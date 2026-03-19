#!/usr/bin/env node
/**
 * cli/start-session.ts
 *
 * High-level entry point: initialises state if absent, registers a master agent
 * if none exists (with interactive prompts), and spawns the coordinator as a
 * background process.
 *
 * Usage:
 *   orc-start-session [--provider=<claude|codex|gemini>] [--agent-id=<id>]
 *
 * All flags are optional. Missing values trigger interactive prompts in a TTY;
 * in non-TTY / CI mode they must be supplied as flags.
 *
 * Flow:
 *   1. Reuse/restart coordinator
 *   2. Reuse/replace/register the foreground master session
 *   3. Start the master provider CLI in this terminal
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

import {
  listAgents,
  registerAgent,
  getAgent,
  removeAgent,
  updateAgentRuntime,
} from '../lib/agentRegistry.ts';
import { STATE_DIR }             from '../lib/paths.ts';
import { flag }                  from '../lib/args.ts';
import { atomicWriteJson }       from '../lib/atomicWrite.ts';
import {
  promptProvider,
  isInteractive,
  promptCoordinatorAction,
  promptMasterAction,
  printManagedWorkerNotice,
} from '../lib/prompts.ts';
import { checkAndInstallBinary, PROVIDER_BINARIES } from '../lib/binaryCheck.ts';
import { startMasterPtyForwarder } from '../lib/masterPtyForwarder.ts';
import { getMasterBootstrap } from '../lib/sessionBootstrap.ts';

export let masterPty: ReturnType<typeof pty.spawn> | null = null;

// ── State init (lazy) ──────────────────────────────────────────────────────
// Only called when we are about to register a new master agent.
// listAgents() is safe to call without any files present — readAgents()
// catches file-not-found and returns { agents: [] }.

function ensureState() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(join(STATE_DIR, 'backlog.json'))) {
    atomicWriteJson(join(STATE_DIR, 'backlog.json'), {
      version: '1',
      features: [{ ref: 'project', title: 'Project', tasks: [] }],
    });
  }
  if (!existsSync(join(STATE_DIR, 'agents.json'))) {
    atomicWriteJson(join(STATE_DIR, 'agents.json'), { version: '1', agents: [] });
  }
  if (!existsSync(join(STATE_DIR, 'claims.json'))) {
    atomicWriteJson(join(STATE_DIR, 'claims.json'), { version: '1', claims: [] });
  }
  if (!existsSync(join(STATE_DIR, 'events.jsonl'))) {
    writeFileSync(join(STATE_DIR, 'events.jsonl'), '');
  }
}

// ── Coordinator helpers ────────────────────────────────────────────────────

const COORDINATOR_PID_FILE = join(STATE_DIR, 'coordinator.pid');
const COORDINATOR_SCRIPT_PATH = resolve(import.meta.dirname, '..', 'coordinator.ts');

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
  try {
    process.kill(pid, 0);           // no-op signal: throws if process is dead
    return { running: isCoordinatorCommandPid(pid), pid };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return { running: false, pid };
    return { running: isCoordinatorCommandPid(pid), pid };
  }
}

async function spawnCoordinator() {
  const child = spawn(process.execPath, ['--experimental-strip-types', COORDINATOR_SCRIPT_PATH], {
    env:      { ...process.env, ORCH_STATE_DIR: STATE_DIR },
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

function writeMcpConfig() {
  const serverPath = fileURLToPath(new URL('../mcp/server.ts', import.meta.url));
  const config = {
    mcpServers: {
      orchestrator: {
        command: process.execPath,
        args: ['--experimental-strip-types', serverPath],
        env: { ORCH_STATE_DIR: STATE_DIR },
      },
    },
  };
  mkdirSync(STATE_DIR, { recursive: true });
  const configPath = join(STATE_DIR, 'mcp-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// ── Find master ────────────────────────────────────────────────────────────

const agents = listAgents(STATE_DIR);
let master = agents.find((a) => a.role === 'master') ?? null;
const deprecatedWorkerId = flag('worker-id');
const deprecatedWorkerProvider = flag('worker-provider');

if (deprecatedWorkerId || deprecatedWorkerProvider) {
  console.error('Deprecated flags: --worker-id and --worker-provider are no longer supported by orc-start-session.');
  console.error('Normal startup is master-only. Configure worker capacity via ORC_MAX_WORKERS / ORC_WORKER_PROVIDER or orchestrator.config.json.');
  console.error('Use orc-worker-register or orc-worker-start-session only for debug/recovery workflows.');
  process.exit(1);
}

// ── Startup wizard ─────────────────────────────────────────────────────────

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

// ── Register master if absent ──────────────────────────────────────────────

if (!master) {
  ensureState(); // create state files only when we need to write
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

// ── Coordinator ────────────────────────────────────────────────────────────

const { running, pid: existingPid } = coordinatorStatus();
if (running) {
  console.log(`✓ Coordinator already running  (PID ${existingPid})`);
} else {
  console.log('Starting coordinator...');
  const newPid = await spawnCoordinator();
  console.log(newPid
    ? `✓ Coordinator running  (PID ${newPid})`
    : '  Coordinator spawned (PID confirmation pending)');
}

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
try {
  if (master.provider === 'claude') {
    const mcpConfigPath = writeMcpConfig();
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-prompt', bootstrap];
    console.log('  MCP server: orchestrator tools available in this session.');
    console.log('  Master bootstrap loaded via --system-prompt.');
    console.log('\n----- MASTER BOOTSTRAP -----');
    console.log(bootstrap);
    console.log('----- END MASTER BOOTSTRAP -----\n');
  } else if (master.provider === 'codex') {
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    spawnArgs = ['--instructions', bootstrap];
    console.log('  Master bootstrap loaded via --instructions.');
    console.log('\n----- MASTER BOOTSTRAP -----');
    console.log(bootstrap);
    console.log('----- END MASTER BOOTSTRAP -----\n');
  } else if (master.provider === 'gemini') {
    const mcpConfigPath = writeMcpConfig();
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-instruction', bootstrap];
    console.log('  MCP server: orchestrator tools available in this session.');
    console.log('  Master bootstrap loaded via --system-instruction.');
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
  console.error(`Failed preparing master session: ${(error as Error)?.message ?? 'unknown error'}`);
  process.exit(1);
}

const now = new Date().toISOString();
updateAgentRuntime(STATE_DIR, master.agent_id, {
  status: 'running',
  last_heartbeat_at: now,
  last_status_change_at: now,
});

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
let stopForwarder = () => {};

const cliResult = await new Promise<{ type: string; error?: Error | undefined; code?: number | undefined; signal?: string | undefined }>((resolvePromise) => {
  try {
    masterPty = pty.spawn(binary, spawnArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns ?? 220,
      rows: process.stdout.rows ?? 50,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
  } catch (error) {
    resolvePromise({ type: 'error', error: error as Error });
    return;
  }

  mkdirSync(masterPidDir, { recursive: true });
  writeFileSync(masterPidPath, String(masterPty.pid));

  masterPty.onData((data) => process.stdout.write(data));
  stopForwarder = startMasterPtyForwarder(STATE_DIR, masterPty, masterPty, {
    provider: master.provider,
  });
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
stopForwarder();
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
  try {
    updateAgentRuntime(STATE_DIR, master.agent_id, {
      status: 'offline',
      session_handle: null,
      provider_ref: null,
      last_status_change_at: new Date().toISOString(),
    });
  } catch {
    // Agent may have been removed by orc kill-all before teardown; safe to ignore.
  }
}

if (cliResult.type === 'error') {
  console.error(
    `Failed to start master provider CLI '${String(binary)}' for ${master.provider}: ${cliResult.error?.message ?? 'unknown error'}`,
  );
  markMasterOffline();
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
