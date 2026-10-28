#!/usr/bin/env node
/**
 * cli/start-session.ts
 *
 * High-level entry point: initialises state if absent, registers a master agent
 * if none exists (with interactive prompts), and spawns the coordinator as a
 * background process.
 *
 * Usage:
 *   orc start-session [--provider=<claude|codex|gemini>] [--agent-id=<id>]
 *
 * All flags are optional. Missing values trigger interactive prompts in a TTY;
 * in non-TTY / CI mode they must be supplied as flags.
 *
 * Flow:
 *   1. Reuse/restart coordinator
 *   2. Reuse/replace/register the foreground master session
 *   3. Start the master provider CLI in this terminal
 */
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

import {
  listAgents,
  registerAgent,
  getAgent,
  removeAgent,
  updateAgentRuntime,
} from '../lib/agentRegistry.ts';
import { ACTIVE_PROJECT, assertSupportedLayout, STATE_DIR } from '../lib/paths.ts';
import { codexMcpOverrideArgs } from '../lib/mcpConfig.ts';
import { loadMasterConfig }      from '../lib/providers.ts';
import { flag }                  from '../lib/args.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { closeProviderSessionsForAgent, recordProviderSession } from '../lib/runStore.ts';
import { credentialHash, newSessionSecret } from '../lib/sessionCredentials.ts';
import {
  promptProvider,
  isInteractive,
  promptCoordinatorAction,
  promptMasterAction,
  printManagedWorkerNotice,
} from '../lib/prompts.ts';
import { checkAndInstallBinary, probeProviderAuth, PROVIDER_BINARIES } from '../lib/binaryCheck.ts';
import { ensureNodePtySpawnHelperPermissions } from '../lib/nodePtyPermissions.ts';
import { getMasterBootstrap } from '../lib/sessionBootstrap.ts';
import { formatErrorMessage } from './shared.ts';
import { isCoordinatorLockHeld, type CoordinatorLock } from '../lib/coordinatorLiveness.ts';
import {
  appendSessionStartedEvent,
  prepareSessionReuse,
  resetVolatileRuntimeStateForSession,
  restoreVolatileRuntimeStateFromSnapshot,
} from '../lib/sessionState.ts';

export let masterPty: ReturnType<typeof pty.spawn> | null = null;

ensureNodePtySpawnHelperPermissions();

function runtimeModulePath(relativeTsPath: string, relativeJsPath: string): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath,
    import.meta.url,
  ));
}

// ── Coordinator helpers ────────────────────────────────────────────────────

const COORDINATOR_PID_FILE = join(STATE_DIR, 'coordinator.pid');
const COORDINATOR_SCRIPT_PATH = runtimeModulePath('../coordinator.ts', '../coordinator.js');

function isValidPid(pid: unknown): pid is number {
  return Number.isInteger(pid) && (pid as number) > 0;
}

function readCoordinatorPidRecord() {
  if (!existsSync(COORDINATOR_PID_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(COORDINATOR_PID_FILE, 'utf8')) as Record<string, unknown>;
    if (!isValidPid(data?.pid)) return null;
    return {
      pid: Number(data.pid),
      started_at: typeof data.started_at === 'string' ? data.started_at : null,
    };
  } catch {
    return null;
  }
}

function readCoordinatorLock(): CoordinatorLock | null {
  try {
    return JSON.parse(readFileSync(COORDINATOR_PID_FILE, 'utf8')) as CoordinatorLock;
  } catch {
    return null;
  }
}

function readCoordinatorPidFromFile() {
  return readCoordinatorPidRecord()?.pid ?? null;
}

function removeCoordinatorPidFileIfMatches(pid: number) {
  const record = readCoordinatorPidRecord();
  if (record?.pid !== pid) return;
  try {
    unlinkSync(COORDINATOR_PID_FILE);
  } catch {
    // already gone
  }
}

function isCoordinatorCommandPid(pid: number) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return false;
  const command = String(result.stdout ?? '').trim();
  return command.includes(COORDINATOR_SCRIPT_PATH);
}

function coordinatorStatus() {
  const pid = readCoordinatorPidFromFile();
  if (!pid) return { running: false, pid: null };
  // A lock whose recorded process start no longer matches names a reused PID, not the coordinator.
  if (!isCoordinatorLockHeld(readCoordinatorLock())) return { running: false, pid };
  try {
    process.kill(pid, 0);           // no-op signal: throws if process is dead
    return { running: isCoordinatorCommandPid(pid), pid };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return { running: false, pid };
    return { running: isCoordinatorCommandPid(pid), pid };
  }
}

async function spawnCoordinator() {
  const child = spawn(process.execPath, [COORDINATOR_SCRIPT_PATH], {
    env:      { ...process.env, ...orcStateEnv() },
    detached: true,
    stdio:    'ignore',
  });
  child.unref();

  // Poll coordinator.pid up to 2 s (10 × 200 ms) to confirm startup
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const pid = readCoordinatorPidFromFile();
    if (pid) return pid;
  }
  return null;
}

async function stopCoordinator(pid: number) {
  if (!isValidPid(pid)) return false;
  const record = readCoordinatorPidRecord();
  if (!record || record.pid !== pid || !record.started_at) return false;
  if (!isCoordinatorCommandPid(pid)) return false;

  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ESRCH') {
      removeCoordinatorPidFileIfMatches(pid);
      return true;
    }
    return false;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
        removeCoordinatorPidFileIfMatches(pid);
        return true;
      }
    }
  }
  return false;
}

/** How child processes find this session's state: the project identity in project mode. */
function orcStateEnv(): Record<string, string> {
  return ACTIVE_PROJECT ? { ORC_PROJECT_ID: ACTIVE_PROJECT.id, ORC_STATE_DIR: STATE_DIR } : { ORC_STATE_DIR: STATE_DIR };
}

/**
 * The master's secret (task 231): the credential its MCP tools and shells
 * present to the coordinator. It lives only in the master's environment; the
 * state keeps its hash, and MCP configs reference it by name.
 */
const masterSecret = ACTIVE_PROJECT ? newSessionSecret() : null;

/**
 * The master's MCP server environment. In a project it forwards the master's
 * secret from the provider's own environment by reference (Claude and Gemini
 * expand `${VAR}`), so the value is never written into `mcp-config.json`.
 */
function masterMcpEnv(): Record<string, string> {
  return masterSecret ? { ...orcStateEnv(), ORC_MASTER_SECRET: '${ORC_MASTER_SECRET}' } : orcStateEnv();
}

function writeMcpConfig(env: Record<string, string>) {
  const serverPath = runtimeModulePath('../mcp/server.ts', '../mcp/server.js');
  const config = {
    mcpServers: {
      orchestrator: {
        command: process.execPath,
        args: [serverPath],
        env,
      },
    },
  };
  mkdirSync(STATE_DIR, { recursive: true });
  const configPath = join(STATE_DIR, 'mcp-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function escapeTomlString(value: string) {
  return JSON.stringify(value);
}

function resolveInvocationCwd(cwd: string = process.cwd()) {
  const shellPwd = process.env.PWD;
  if (!shellPwd) return cwd;
  try {
    const shellStats = statSync(shellPwd);
    const cwdStats = statSync(cwd);
    if (shellStats.dev === cwdStats.dev && shellStats.ino === cwdStats.ino) {
      return shellPwd;
    }
  } catch {
    // Fall back to the canonical cwd if either path is unavailable.
  }
  return cwd;
}

function resolveActiveCheckoutRoot(cwd: string = resolveInvocationCwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  });
  const configuredRoot = process.env.ORC_REPO_ROOT ? resolve(process.env.ORC_REPO_ROOT) : null;
  if (result.status !== 0) {
    return configuredRoot ?? resolve(cwd);
  }
  return result.stdout.trim() || configuredRoot || resolve(cwd);
}

function stripTomlTable(existing: string, tablePath: string) {
  const lines = existing.split('\n');
  const stripped: string[] = [];
  let skipTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '# BEGIN ORC MANAGED MCP' || trimmed === '# END ORC MANAGED MCP') {
      continue;
    }

    const tableMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      const currentTable = tableMatch[1].trim();
      skipTable = currentTable === tablePath || currentTable.startsWith(`${tablePath}.`);
    }

    if (!skipTable) {
      stripped.push(line);
    }
  }

  return stripped.join('\n').trimEnd();
}

function writeCodexProjectMcpConfig(repoRoot: string) {
  const serverPath = runtimeModulePath('../mcp/server.ts', '../mcp/server.js');
  const codexDir = join(repoRoot, '.codex');
  const configPath = join(codexDir, 'config.toml');
  const managedBlockStart = '# BEGIN ORC MANAGED MCP';
  const managedBlockEnd = '# END ORC MANAGED MCP';
  const managedBlock = [
    managedBlockStart,
    '[mcp_servers.orchestrator]',
    `command = ${escapeTomlString(process.execPath)}`,
    `args = [${escapeTomlString(serverPath)}]`,
    `cwd = ${escapeTomlString(repoRoot)}`,
    '',
    '[mcp_servers.orchestrator.env]',
    `ORC_STATE_DIR = ${escapeTomlString(STATE_DIR)}`,
    managedBlockEnd,
    '',
  ].join('\n');

  mkdirSync(codexDir, { recursive: true });

  let existing = '';
  try {
    existing = readFileSync(configPath, 'utf8');
  } catch {
    existing = '';
  }

  const withoutManagedBlock = stripTomlTable(existing, 'mcp_servers.orchestrator');
  const nextContents = withoutManagedBlock
    ? `${withoutManagedBlock}\n\n${managedBlock}`
    : managedBlock;

  writeFileSync(configPath, nextContents);
  return configPath;
}

// ── Find master ────────────────────────────────────────────────────────────

const agents = listAgents(STATE_DIR);
let master = agents.find((a) => a.role === 'master') ?? null;
const deprecatedWorkerId = flag('worker-id');
const deprecatedWorkerProvider = flag('worker-provider');

if (deprecatedWorkerId || deprecatedWorkerProvider) {
  console.error('Deprecated flags: --worker-id and --worker-provider are no longer supported by orc start-session.');
  console.error('Normal startup is master-only. Configure worker capacity via ORC_MAX_WORKERS / ORC_WORKER_PROVIDER or orc-state.config.json.');
  console.error('Use orc register-worker or orc start-worker-session only for debug/recovery workflows.');
  process.exit(1);
}

// ── Startup wizard ─────────────────────────────────────────────────────────

try {
  assertSupportedLayout();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const { running: coordinatorRunning, pid: coordinatorPid } = coordinatorStatus();
const coordinatorAction = await promptCoordinatorAction(coordinatorRunning ? coordinatorPid : null);

if (coordinatorAction === 'cancel') {
  if (isInteractive()) console.log('Cancelled.');
  process.exit(isInteractive() ? 0 : 1);
}

if (coordinatorAction === 'terminate' && coordinatorPid) {
  console.log(`Stopping running coordinator (PID ${coordinatorPid})...`);
  const stopped = await stopCoordinator(coordinatorPid);
  if (!stopped) {
    console.warn(`Coordinator PID ${coordinatorPid} is still running; continuing with existing coordinator.`);
  }
}

const masterAction = await promptMasterAction(master);
if (masterAction === 'cancel') {
  if (isInteractive()) console.log('Cancelled.');
  process.exit(isInteractive() ? 0 : 1);
}
if (masterAction === 'replace' && master) {
  removeAgent(STATE_DIR, master.agent_id);
  console.log(`✓ Removed existing master '${master.agent_id}'`);
  master = null;
}

ensureStateInitialized(STATE_DIR);

// ── Register master if absent ──────────────────────────────────────────────

if (!master) {
  const agentId = flag('agent-id') ?? 'master';
  const provider = await promptProvider(flag('provider'), {
    message: 'Select provider for MASTER session (this terminal only)',
  });
  if (!provider) {
    console.error('No master agent found. Provide a provider via --provider=<claude|codex|gemini>');
    if (!isInteractive()) {
      console.error('Run with a TTY for interactive setup, or pass all flags explicitly.');
    }
    process.exit(1);
  }
  registerAgent(STATE_DIR, { agent_id: agentId, provider, role: 'master' });
  console.log(`✓ Registered master agent '${agentId}' (${provider})`);
  master = getAgent(STATE_DIR, agentId);
}

if (!master) {
  console.error('Failed to load master agent record after registration.');
  process.exit(1);
}

// ── Binary check ───────────────────────────────────────────────────────────

const binaryOk = await checkAndInstallBinary(master.provider);
if (!binaryOk) {
  const binary = (PROVIDER_BINARIES)[master.provider] ?? master.provider;
  console.error(`Cannot start master session: '${binary}' binary not available.`);
  process.exit(1);
}

// ── Auth probe ─────────────────────────────────────────────────────────────

const authResult = probeProviderAuth(master.provider);
if (!authResult.ok) {
  console.error(authResult.message);
  process.exit(1);
}

// ── Coordinator ────────────────────────────────────────────────────────────

const sessionReset = coordinatorAction === 'reuse'
  ? prepareSessionReuse(STATE_DIR)
  : resetVolatileRuntimeStateForSession(STATE_DIR);

// Coordinator spawn is deferred until after pty.spawn succeeds — see below.
// This avoids a lock race: if pty.spawn throws, the error recovery path calls
// restoreVolatileRuntimeStateFromSnapshot which needs the .lock file, but a
// freshly spawned coordinator may be holding it during its first tick.

// ── Master foreground session ──────────────────────────────────────────────

const binaryName = (PROVIDER_BINARIES)[master.provider] ?? master.provider;
// Resolve to absolute path so node-pty can find it regardless of its PATH.
let resolvedBinary = binaryName;
try { resolvedBinary = execFileSync('which', [binaryName], { encoding: 'utf8' }).trim(); } catch { /* keep binaryName */ }
const binary = resolvedBinary;
const masterPidDir = join(STATE_DIR, 'pty-pids');
const masterPidPath = join(masterPidDir, 'master.pid');
console.log(`\n✓ Starting ${master.provider} CLI as master session...`);
console.log('  This terminal is the MASTER session.');
console.log('  Workers are separate headless PTY sessions managed by the coordinator.');
printManagedWorkerNotice();
console.log('\nSession recap:');
console.log('  MASTER:  foreground planner/delegator in this terminal');
console.log('  WORKERS: coordinator-managed background capacity launched per task');
console.log('\nNext steps:');
console.log('  Delegate work:      orc delegate [--target-agent-id=<id>] --task-ref=<feature/task>');
console.log('  Check status:       orc status');
console.log('  Recovery/debug:     orc register-worker / orc start-worker-session / orc control-worker');

let spawnArgs: string[] = [];
const masterConfig = loadMasterConfig();
const masterModelArgs = masterConfig.model ? ['--model', masterConfig.model] : [];
const checkoutRoot = resolveActiveCheckoutRoot();
try {
  if (master.provider === 'claude') {
    const mcpConfigPath = writeMcpConfig(masterMcpEnv());
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-prompt', bootstrap, '--name', 'MASTER', ...masterModelArgs];
    console.log('  MCP server: orchestrator tools available in this session.');
    console.log('  Master bootstrap loaded via --system-prompt.');
    if (masterConfig.model) console.log(`  Model: ${masterConfig.model}`);
    console.log('\n----- MASTER BOOTSTRAP -----');
    console.log(bootstrap);
    console.log('----- END MASTER BOOTSTRAP -----\n');
  } else if (master.provider === 'codex') {
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    const codexMcpArgs = ACTIVE_PROJECT
      // Codex forwards the secret by name from its own environment (env_vars), never on its command line.
      ? codexMcpOverrideArgs(runtimeModulePath('../mcp/server.ts', '../mcp/server.js'), orcStateEnv(), process.execPath, ['ORC_MASTER_SECRET'])
      : [];
    const codexConfigPath = ACTIVE_PROJECT ? 'command-line overrides' : writeCodexProjectMcpConfig(checkoutRoot);
    const codexModeArgs = masterConfig.execution_mode === 'sandbox'
      ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
      : ['--dangerously-bypass-approvals-and-sandbox'];
    spawnArgs = [...codexModeArgs, ...codexMcpArgs, ...masterModelArgs, bootstrap];
    console.log(`  MCP server: orchestrator tools available via ${codexConfigPath}.`);
    console.log('  Master bootstrap loaded via initial prompt.');
    if (masterConfig.model) console.log(`  Model: ${masterConfig.model}`);
    console.log('\n----- MASTER BOOTSTRAP -----');
    console.log(bootstrap);
    console.log('----- END MASTER BOOTSTRAP -----\n');
  } else if (master.provider === 'gemini') {
    const mcpConfigPath = writeMcpConfig(masterMcpEnv());
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-instruction', bootstrap, ...masterModelArgs];
    console.log('  MCP server: orchestrator tools available in this session.');
    console.log('  Master bootstrap loaded via --system-instruction.');
    if (masterConfig.model) console.log(`  Model: ${masterConfig.model}`);
    console.log('\n----- MASTER BOOTSTRAP -----');
    console.log(bootstrap);
    console.log('----- END MASTER BOOTSTRAP -----\n');
  } else {
    console.warn(`Unknown provider '${master.provider}' for bootstrap args; starting without bootstrap args.`);
  }
} catch (error) {
  updateAgentRuntime(STATE_DIR, master.agent_id, {
    status: 'offline',
    session_handle: null,
    provider_ref: null,
    last_status_change_at: new Date().toISOString(),
  });
  console.error(`Failed preparing master session: ${formatErrorMessage(error)}`);
  process.exit(1);
}

let stdinRawEnabled = false;
const stdinDataHandler = (data: Buffer | string) => {
  if (masterPty) {
    masterPty.write(String(data));
  }
};
const stdoutResizeHandler = () => {
  if (masterPty) {
    masterPty.resize(process.stdout.columns ?? 220, process.stdout.rows ?? 50);
  }
};
// A killed start-session must not leave the master's credential valid: close its session on the way out.
for (const [signal, code] of [['SIGHUP', 129], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    markMasterOffline();
    try { masterPty?.kill(); } catch { /* already gone */ }
    // The normal teardown below never runs after process.exit: restore the terminal and drop the pid file here.
    if (stdinRawEnabled && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
    try { unlinkSync(masterPidPath); } catch { /* already gone */ }
    process.exit(code);
  });
}

const cliResult = await new Promise<{ type: string; error?: Error | undefined; code?: number | undefined; signal?: string | undefined }>((resolvePromise) => {
  try {
    masterPty = pty.spawn(binary, spawnArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns ?? 220,
      rows: process.stdout.rows ?? 50,
      cwd: resolveInvocationCwd(),
      env: { ...process.env, ...(masterSecret ? { ORC_MASTER_SECRET: masterSecret } : {}) } as Record<string, string>,
    });
    const startedAt = new Date().toISOString();
    recordProviderSession(STATE_DIR, {
      sessionId: sessionReset.session_id,
      runId: null,
      agentId: master.agent_id,
      provider: master.provider,
      providerRef: null,
      startedAt,
      credentialHash: masterSecret ? credentialHash(masterSecret) : null,
    });
    updateAgentRuntime(STATE_DIR, master.agent_id, {
      status: 'running',
      last_heartbeat_at: startedAt,
      last_status_change_at: startedAt,
    });
    appendSessionStartedEvent(STATE_DIR, sessionReset);

    // Coordinator spawn deferred to here — pty.spawn succeeded, state is committed.
    // Fire-and-forget: master session doesn't depend on coordinator being confirmed alive.
    const { running: coordRunning, pid: coordPid } = coordinatorStatus();
    if (coordRunning) {
      console.log(`✓ Coordinator already running  (PID ${coordPid})`);
    } else {
      spawnCoordinator().then((newPid) => {
        console.log(newPid
          ? `✓ Coordinator running  (PID ${newPid})`
          : '  Coordinator spawned (PID confirmation pending)');
      }).catch((err: unknown) => {
        console.warn(`Warning: coordinator failed to start: ${formatErrorMessage(err)}. Master session continues without coordinator.`);
      });
    }
  } catch (error) {
    restoreVolatileRuntimeStateFromSnapshot(STATE_DIR, sessionReset.snapshot);
    if (masterPty) {
      try {
        masterPty.kill();
      } catch {
        // best effort
      }
      masterPty = null;
    }
    resolvePromise({ type: 'error', error: error as Error });
    return;
  }

  mkdirSync(masterPidDir, { recursive: true });
  writeFileSync(masterPidPath, String(masterPty.pid));

  masterPty.onData((data) => process.stdout.write(data));
  masterPty.onExit(({ exitCode, signal }) => resolvePromise({ type: 'close', code: exitCode, signal: signal as string | undefined }));

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    process.stdin.setRawMode(true);
    stdinRawEnabled = true;
  }
  process.stdin.resume();
  process.stdin.on('data', stdinDataHandler);
  process.stdout.on('resize', stdoutResizeHandler);
});

process.stdin.off('data', stdinDataHandler);
process.stdout.off('resize', stdoutResizeHandler);
if (stdinRawEnabled && process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
  process.stdin.setRawMode(false);
}
if (process.stdin.isTTY) {
  process.stdin.pause();
}
try {
  unlinkSync(masterPidPath);
} catch {
  // already gone
}
masterPty = null;

function markMasterOffline() {
  if (!master) return;
  const now = new Date().toISOString();
  try {
    updateAgentRuntime(STATE_DIR, master.agent_id, {
      status: 'offline',
      session_handle: null,
      provider_ref: null,
      last_status_change_at: now,
    });
  } catch {
    // Agent may have been removed by orc kill-all before teardown; safe to ignore.
  }
  try {
    // The coordinator leaves the master's session to us: an ended master's id must stop authenticating.
    closeProviderSessionsForAgent(STATE_DIR, master.agent_id, now);
  } catch {
    // Best effort, as above.
  }
}

if (cliResult.type === 'error') {
  console.error(
    `Failed to start master provider CLI '${String(binary)}' for ${master.provider}: ${cliResult.error?.message ?? 'unknown error'}`,
  );
  process.exit(1);
} else if (cliResult.code !== 0) {
  console.error(
    `Master provider CLI '${binary}' exited with code ${cliResult.code ?? 'null'}${cliResult.signal ? ` (signal ${cliResult.signal})` : ''}.`,
  );
  markMasterOffline();
  process.exit(1);
} else {
  markMasterOffline();
  console.log('\nMaster session ended. Coordinator continues running in the background.');
}
