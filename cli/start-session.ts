#!/usr/bin/env node
/**
 * cli/start-session.ts
 *
 * High-level entry point: initialises state if absent, registers a master agent
 * if none exists (with interactive prompts), and spawns the coordinator as a
 * background process.
 *
 * Usage:
 *   orc start-session [--provider=<claude|codex|gemini>] [--agent-id=<id>] [--reset] [--restart-stale] [--no-cockpit]
 *
 * All flags are optional. Missing values trigger interactive prompts in a TTY;
 * in non-TTY / CI mode they must be supplied as flags.
 *
 * Flow:
 *   0. A live master in orc's tmux server: make sure the coordinator runs, then reattach
 *   1. Reuse/start/restart the coordinator. Runtime state is kept, so the new
 *      coordinator adopts live worker sessions; `--reset` (or the "start fresh"
 *      choice) stops every worker session and fails their runs instead
 *   2. Reuse/replace/register the master
 *   3. Start the master provider CLI in a tmux session (resuming its Claude
 *      conversation when one is recorded)
 *   4. Open the cockpit (adapters/tmuxCockpit.ts) on this project's master and
 *      attach this terminal to it; `--no-cockpit` attaches to the master directly
 *
 * Detaching (Ctrl-] d or the master's Ctrl-b d) or closing the terminal leaves the
 * cockpit and the master running; the master's credential is revoked when it
 * exits or by `orc kill-all`.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listAgents,
  registerAgent,
  getAgent,
  removeAgent,
  updateAgentRuntime,
} from '../lib/agentRegistry.ts';
import { ACTIVE_PROJECT, assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { codexMcpOverrideArgs } from '../lib/mcpConfig.ts';
import { loadMasterConfig }      from '../lib/providers.ts';
import { boolFlag, flag }        from '../lib/args.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { recordProviderSession, recordSessionResumeFailed, reopenLiveSession, resumeProviderSession } from '../lib/runStore.ts';
import { credentialHash, newSessionSecret } from '../lib/sessionCredentials.ts';
import {
  promptProvider,
  isInteractive,
  promptCoordinatorAction,
  promptMasterAction,
  printManagedWorkerNotice,
} from '../lib/prompts.ts';
import { checkAndInstallBinary, probeProviderAuth, PROVIDER_BINARIES } from '../lib/binaryCheck.ts';
import { checkTmux, createTmuxAdapter, inspectTmuxSession, startTmuxSession, tmuxAttachCommand, tmuxBinary, tmuxSessionTarget } from '../adapters/tmux.ts';
import {
  COCKPIT_KEYS, cockpitAttachCommand, ensureCockpitWindow, insideCockpit, terminalHasTrueColor,
} from '../adapters/tmuxCockpit.ts';
import { stripNestedProviderEnv } from '../lib/providerChildEnv.ts';
import { listSupervisedSessions, MASTER_RETIRE_FAILURES, retireMaster, type MasterProbe } from '../lib/sessionSupervisor.ts';
import { getMasterBootstrap, MASTER_BOOTSTRAP_TEMPLATE } from '../lib/sessionBootstrap.ts';
import { formatErrorMessage } from './shared.ts';
import {
  coordinatorStatus as coordinatorStatusOf,
  restartCoordinator,
  startCoordinatorIfStopped,
  stopRunningCoordinator,
} from '../lib/coordinatorProcess.ts';
import { ControlClient, controlSocketFromEnv } from '../lib/controlClient.ts';
import { ControlError } from '../lib/controlProtocol.ts';
import { staleCodeWarning } from '../lib/codeIdentity.ts';
import {
  appendSessionStartedEvent,
  prepareSessionReuse,
  resetVolatileRuntimeStateForSession,
  restoreVolatileRuntimeStateFromSnapshot,
  stopSessionsForReset,
} from '../lib/sessionState.ts';
import { createAdapter } from '../adapters/index.ts';
import { sessionCapabilities } from '../lib/sessionCapabilities.ts';

function runtimeModulePath(relativeTsPath: string, relativeJsPath: string): string {
  return fileURLToPath(new URL(
    import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath,
    import.meta.url,
  ));
}

// ── Coordinator helpers ────────────────────────────────────────────────────

const coordinatorStatus = () => coordinatorStatusOf(STATE_DIR);

/** Why the running coordinator is out of date against the code on disk (version or build); null when current, or unreachable. */
let warnedStale = false;
async function staleCoordinatorWarning(): Promise<string | null> {
  if (warnedStale) return null; // already printed this run
  try {
    const warning = staleCodeWarning(await new ControlClient(STATE_DIR, { timeoutMs: 3_000, socketPath: controlSocketFromEnv() }).health());
    warnedStale = warning !== null;
    return warning;
  } catch {
    return null; // no control API, or a coordinator that predates /v1/health
  }
}

/** Stop the running coordinator; false (with the reason printed) when it is still running. */
async function stopCoordinator(): Promise<boolean> {
  try {
    await stopRunningCoordinator(STATE_DIR);
    return true;
  } catch (err) {
    console.warn(`Warning: ${formatErrorMessage(err)}`);
    return false;
  }
}

/** How child processes find this session's state: the project identity. */
function orcStateEnv(): Record<string, string> {
  return { ORC_PROJECT_ID: ACTIVE_PROJECT!.id, ORC_STATE_DIR: STATE_DIR };
}

/**
 * The master's secret (task 231): the credential its MCP tools and shells
 * present to the coordinator. It lives only in the master's environment; the
 * state keeps its hash, and MCP configs reference it by name.
 */
const masterSecret = newSessionSecret();

/**
 * The master's MCP server environment. It forwards the master's
 * secret from the provider's own environment by reference (Claude and Gemini
 * expand `${VAR}`), so the value is never written into `mcp-config.json`.
 */
function masterMcpEnv(): Record<string, string> {
  return { ...orcStateEnv(), ORC_MASTER_SECRET: '${ORC_MASTER_SECRET}' };
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

try {
  assertProjectMode();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// ── Find master ────────────────────────────────────────────────────────────

const agents = listAgents(STATE_DIR);
let master = agents.find((a) => a.role === 'master') ?? null;

/** The tmux session of a master whose process is still running, or null. */
function liveMasterTmuxName(agent: typeof master): string | null {
  const handle = agent?.session_handle;
  if (!handle?.startsWith('tmux:')) return null;
  const name = handle.slice('tmux:'.length);
  return inspectTmuxSession(name).alive ? name : null;
}

/**
 * A master retired while its pane still runs (task general/master-liveness-race):
 * restore its agent record and reopen its session from the live pane, so its
 * secret authenticates again. Only the session whose recorded process is the
 * live pane's is reopened. Returns the session name, or null when there is
 * nothing to repair.
 */
function repairRetiredMaster(agent: typeof master): string | null {
  if (!agent || agent.session_handle) return null;
  const name = agent.agent_id;
  const inspection = inspectTmuxSession(name);
  if (!inspection.alive || inspection.pid == null || inspection.processStart == null) return null;
  const at = new Date().toISOString();
  const reopened = reopenLiveSession(STATE_DIR, {
    agentId: agent.agent_id, processPid: inspection.pid, processStart: inspection.processStart, at,
    reason: 'orc start-session found the master marked offline while its tmux pane runs',
  });
  if (!reopened) return null;
  updateAgentRuntime(STATE_DIR, agent.agent_id, {
    status: 'running',
    session_handle: `tmux:${name}`,
    session_token: reopened.sessionId,
    provider_ref: reopened.providerRef as typeof agent.provider_ref,
    last_heartbeat_at: at,
    last_status_change_at: at,
  });
  return name;
}

async function ensureCoordinatorRunning() {
  const { running, pid } = coordinatorStatus();
  if (running) {
    console.log(`✓ Coordinator already running  (PID ${pid})`);
    const stale = await staleCoordinatorWarning();
    if (!stale) return;
    console.warn(`Warning: ${stale}`);
    if (!boolFlag('restart-stale') || !pid) return;
    console.log(`Restarting stale coordinator (PID ${pid})...`);
  }
  try {
    const restarted = running
      ? await restartCoordinator(STATE_DIR, ACTIVE_PROJECT!.id)
      : await startCoordinatorIfStopped(STATE_DIR, ACTIVE_PROJECT!.id);
    console.log(`✓ Coordinator running  (PID ${restarted.pid})`);
  } catch (err) {
    if (coordinatorStatus().running) {
      console.warn(`Warning: coordinator did not restart: ${formatErrorMessage(err)}. Master session continues with the running coordinator.`);
    } else if (err instanceof ControlError && err.code === 'unavailable') {
      // The detached coordinator may still come up after the 2 s wait.
      console.log('  Coordinator spawned (PID confirmation pending; check orc coordinator status)');
    } else {
      console.warn(`Warning: coordinator failed to start: ${formatErrorMessage(err)}. Master session continues without coordinator.`);
    }
  }
}

/**
 * Attach this terminal to the master's tmux session, with input. tmux refuses
 * to attach from inside another client while TMUX is set, and orc's server is
 * a different socket, so a nested client is the only option (as orc attach).
 * Returns once the client detaches or the master exits.
 */
function attachMaster(agent: NonNullable<typeof master>, sessionName: string) {
  console.log(`\nAttaching to master '${agent.agent_id}' — Ctrl-b d detaches; the master keeps running.`);
  const { TMUX: _tmux, ...env } = process.env;
  const { command, args } = tmuxAttachCommand(sessionName, { write: true, providerRef: agent.provider_ref });
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) console.error(`Could not run ${command}: ${result.error.message}`);
  afterClientExit(agent, sessionName, {
    detached: '\nDetached. The master keeps running; run orc start-session to reattach.',
    ended: '\nMaster session ended. Coordinator continues running in the background.',
  });
}

/**
 * Open the cockpit on this project's master: create it or add this project's
 * tab, then attach this terminal to it (from a shell inside the cockpit, only
 * switch to the tab). Returns false, with a warning, when the cockpit could not
 * be set up, so the caller attaches to the master directly.
 */
function openCockpit(agent: NonNullable<typeof master>, sessionName: string): boolean {
  const project = ACTIVE_PROJECT!;
  const { socket, session } = tmuxSessionTarget(sessionName, agent.provider_ref);
  try {
    ensureCockpitWindow({
      project: { id: project.id, name: project.name, root: resolveInvocationCwd(), env: orcStateEnv() },
      master: { agentId: agent.agent_id, socket, session },
      watchCommand: [process.execPath, runtimeModulePath('./orc.ts', './orc.js'), 'watch'],
      options: { tmux: tmuxBinary(), trueColor: terminalHasTrueColor() },
      size: { columns: process.stdout.columns, rows: process.stdout.rows },
    });
  } catch (error) {
    console.warn(`Warning: could not open the cockpit (${formatErrorMessage(error)}); attaching to the master directly.`);
    return false;
  }
  if (insideCockpit()) {
    console.log(`\nSwitched the cockpit to ${project.name}.`);
    return true;
  }
  console.log(`\nOpening the cockpit on master '${agent.agent_id}' (${project.name}). ${COCKPIT_KEYS}.`);
  const { TMUX: _tmux, ...env } = process.env;
  const { command, args } = cockpitAttachCommand();
  const result = spawnSync(command, args, { stdio: 'inherit', env });
  if (result.error) {
    console.warn(`Warning: could not attach to the cockpit (${result.error.message}); attaching to the master directly.`);
    return false;
  }
  afterClientExit(agent, sessionName, {
    detached: '\nDetached. The cockpit and the master keep running; run orc start-session to reattach.',
    ended: '\nMaster session ended. The cockpit and the coordinator keep running; run orc start-session to restart the master.',
  });
  return true;
}

/** Attach this terminal to the master: in the cockpit unless `--no-cockpit`; without a TTY, only say where it runs. */
function openMaster(agent: NonNullable<typeof master>, sessionName: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`\nMaster '${agent.agent_id}' is running in orc's tmux server. Run orc start-session from a terminal to attach.`);
    return;
  }
  if (!boolFlag('no-cockpit') && openCockpit(agent, sessionName)) return;
  attachMaster(agent, sessionName);
}

/** After the terminal's client returns: a master still running was detached from; one that ended is retired. */
function afterClientExit(agent: NonNullable<typeof master>, sessionName: string, messages: { detached: string; ended: string }) {
  const exit = confirmMasterExit(sessionName);
  if (!exit) {
    console.log(messages.detached);
    return;
  }
  markMasterOffline(agent.agent_id, sessionName, exit);
  console.log(messages.ended);
}

/** Wait between the probes that confirm the master's exit. */
const MASTER_EXIT_PROBE_INTERVAL_MS = 500;

/**
 * Probe the master's pane until it answers alive (null) or fails
 * MASTER_RETIRE_FAILURES times in a row: one failed probe never retires a master.
 */
function confirmMasterExit(sessionName: string): { probe: MasterProbe; failures: number } | null {
  for (let failures = 1; ; failures += 1) {
    const inspection = inspectTmuxSession(sessionName);
    if (inspection.alive) return null;
    if (failures >= MASTER_RETIRE_FAILURES) {
      return { probe: { alive: false, reason: inspection.reason ?? 'session not alive', pid: inspection.pid }, failures };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MASTER_EXIT_PROBE_INTERVAL_MS);
  }
}

function markMasterOffline(agentId: string, sessionName: string, exit: { probe: MasterProbe; failures: number }) {
  try {
    const current = getAgent(STATE_DIR, agentId);
    // Already retired (by the coordinator) or relaunched by another start-session: nothing to do.
    if (!current || current.status === 'offline' || current.session_handle !== `tmux:${sessionName}`) return;
    // An ended master's id must stop authenticating.
    retireMaster(STATE_DIR, current, { probe: exit.probe, consecutiveFailures: exit.failures, actor: 'human' });
  } catch {
    // Agent may have been removed by orc kill-all; safe to ignore.
  }
}

/** Whether the tmux session is still alive after `ms`. */
async function survives(sessionName: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!inspectTmuxSession(sessionName).alive) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
  return inspectTmuxSession(sessionName).alive;
}

// ── Reattach a live master ─────────────────────────────────────────────────

let liveMasterSession = liveMasterTmuxName(master);
if (!liveMasterSession) {
  liveMasterSession = repairRetiredMaster(master);
  if (liveMasterSession && master) {
    console.log(`✓ Master '${master.agent_id}' was marked offline while running; restored its record and session`);
    master = getAgent(STATE_DIR, master.agent_id);
  }
}
if (master && liveMasterSession) {
  if (boolFlag('reset')) {
    // A reset fails the runs the live master is coordinating; never reattach and pretend it ran.
    console.error(`Master '${master.agent_id}' is running; --reset does nothing while it runs. Exit the master (or run orc kill-all) and retry.`);
    process.exit(1);
  }
  console.log(`✓ Master '${master.agent_id}' is already running`);
  await ensureCoordinatorRunning();
  openMaster(master, liveMasterSession);
  process.exit(0);
}

// ── Startup wizard ─────────────────────────────────────────────────────────

const { running: coordinatorRunning, pid: coordinatorPid } = coordinatorStatus();
let coordinatorAction = await promptCoordinatorAction(coordinatorRunning ? coordinatorPid : null, { reset: boolFlag('reset') });
if (coordinatorAction === 'reuse') {
  const stale = await staleCoordinatorWarning();
  if (stale) {
    console.warn(`Warning: ${stale}`);
    if (boolFlag('restart-stale')) coordinatorAction = 'terminate';
  }
}
const resetRuntimeState = coordinatorAction === 'reset';

if (coordinatorAction === 'cancel') {
  if (isInteractive()) console.log('Cancelled.');
  process.exit(isInteractive() ? 0 : 1);
}

if ((coordinatorAction === 'terminate' || resetRuntimeState) && coordinatorRunning && coordinatorPid) {
  console.log(`Stopping running coordinator (PID ${coordinatorPid})...`);
  const stopped = await stopCoordinator();
  if (!stopped && resetRuntimeState) {
    // Resetting under a live coordinator would race its ticks for the same runs.
    console.error(`Coordinator PID ${coordinatorPid} is still running; not resetting. Stop it (orc kill-all) and retry.`);
    process.exit(1);
  }
  if (!stopped) {
    console.warn(`Coordinator PID ${coordinatorPid} is still running; continuing with existing coordinator.`);
  }
}

const masterAction = await promptMasterAction(master);
if (masterAction === 'cancel') {
  if (isInteractive()) console.log('Cancelled.');
  process.exit(isInteractive() ? 0 : 1);
}
// A master registered or replaced now has no conversation to resume.
let freshMaster = false;
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
  freshMaster = true;
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

const tmuxCheck = checkTmux();
if (!tmuxCheck.ok) {
  console.error(`Cannot start master session: ${tmuxCheck.problem}. orc runs the master and every worker in its tmux server.`);
  process.exit(1);
}

// ── Auth probe ─────────────────────────────────────────────────────────────

const authResult = probeProviderAuth(master.provider);
if (!authResult.ok) {
  console.error(authResult.message);
  process.exit(1);
}

// ── Coordinator ────────────────────────────────────────────────────────────

// Kept state is the crash recovery path: the coordinator's startup reconcile adopts
// live tmux sessions. A reset stops every worker session before failing its run.
if (resetRuntimeState) {
  const { stopped, failed } = await stopSessionsForReset(STATE_DIR, (agent) => createAdapter(agent.provider).stop(agent.session_handle!));
  for (const agentId of stopped) console.log(`✓ Stopped session for ${agentId}`);
  if (failed.length > 0) {
    for (const { agent_id, error } of failed) console.error(`Could not stop session for ${agent_id}: ${error}`);
    console.error('Not resetting while those sessions may still run. Stop them with orc kill-all (stops every session and requeues their tasks) and retry.');
    process.exit(1);
  }
}
const sessionReset = resetRuntimeState
  ? resetVolatileRuntimeStateForSession(STATE_DIR)
  : prepareSessionReuse(STATE_DIR);

// Coordinator spawn is deferred until after the master starts — see below.
// This avoids a lock race: if the start throws, the error recovery path calls
// restoreVolatileRuntimeStateFromSnapshot which needs the .lock file, but a
// freshly spawned coordinator may be holding it during its first tick.

// ── Master session ─────────────────────────────────────────────────────────

const binaryName = (PROVIDER_BINARIES)[master.provider] ?? master.provider;
// Resolve to an absolute path so the launcher finds it regardless of the tmux server's PATH.
let resolvedBinary = binaryName;
try { resolvedBinary = execFileSync('which', [binaryName], { encoding: 'utf8' }).trim(); } catch { /* keep binaryName */ }
const binary = resolvedBinary;
console.log(`\n✓ Starting ${master.provider} CLI as master session...`);
console.log("  The master runs in orc's tmux server: detach with Ctrl-b d or close this terminal, and it keeps running.");
console.log('  Workers are separate sessions managed by the coordinator.');
printManagedWorkerNotice();
console.log('\nSession recap:');
console.log('  MASTER:  planner/delegator; orc start-session attaches to it (or starts it)');
console.log('  WORKERS: coordinator-managed background capacity launched per task');
console.log('\nNext steps:');
console.log('  Delegate work:      orc delegate [--target-agent-id=<id>] --task-ref=<feature/task>');
console.log('  Check status:       orc status');
console.log('  Recovery/debug:     orc terminal / orc worker-remove / orc worker-gc');

/**
 * The conversation a dead master left behind (recorded on its session),
 * resumed under the same session id where the provider's CLI can (Claude).
 * A newly registered master starts fresh.
 */
const masterCapabilities = sessionCapabilities(master.provider, 'tmux');
const masterNamesConversation = masterCapabilities.conversation_id === 'orc';
let resumable = !freshMaster && masterNamesConversation && masterCapabilities.resume
  ? listSupervisedSessions(STATE_DIR).filter((row) => row.agent_id === master.agent_id && row.provider_conversation_id).at(-1) ?? null
  : null;
let conversationId = masterNamesConversation ? (resumable?.provider_conversation_id ?? randomUUID()) : null;
/** Claude's own flags naming the conversation: resume the recorded one, or fix the id of a new one. */
const conversationArgs = () => {
  if (!conversationId) return [];
  return resumable ? ['--resume', conversationId] : ['--session-id', conversationId];
};
/** A resume that fails (conversation gone, or recorded under another directory) ends the CLI within this window. */
const RESUME_SURVIVAL_MS = 3_000;

let spawnArgs: string[] = [];
const masterConfig = loadMasterConfig();
const masterModelArgs = masterConfig.model ? ['--model', masterConfig.model] : [];
try {
  if (master.provider === 'claude') {
    const mcpConfigPath = writeMcpConfig(masterMcpEnv());
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-prompt', bootstrap, '--name', 'MASTER', ...masterModelArgs];
    console.log('  MCP server: orchestrator tools available in this session.');
    console.log('  Master bootstrap loaded via --system-prompt.');
    if (resumable) console.log(`  Resuming conversation ${conversationId}.`);
    if (masterConfig.model) console.log(`  Model: ${masterConfig.model}`);
    console.log(`  Bootstrap template: ${MASTER_BOOTSTRAP_TEMPLATE} (sent to the master, not printed here).`);
  } else if (master.provider === 'codex') {
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    // Codex forwards the secret by name from its own environment (env_vars), never on its command line.
    const codexMcpArgs = codexMcpOverrideArgs(runtimeModulePath('../mcp/server.ts', '../mcp/server.js'), orcStateEnv(), process.execPath, ['ORC_MASTER_SECRET']);
    const codexModeArgs = masterConfig.execution_mode === 'sandbox'
      ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']
      : ['--dangerously-bypass-approvals-and-sandbox'];
    spawnArgs = [...codexModeArgs, ...codexMcpArgs, ...masterModelArgs, bootstrap];
    console.log('  MCP server: orchestrator tools available via command-line overrides.');
    console.log('  Master bootstrap loaded via initial prompt.');
    if (masterConfig.model) console.log(`  Model: ${masterConfig.model}`);
    console.log(`  Bootstrap template: ${MASTER_BOOTSTRAP_TEMPLATE} (sent to the master, not printed here).`);
  } else if (master.provider === 'gemini') {
    const mcpConfigPath = writeMcpConfig(masterMcpEnv());
    const bootstrap = getMasterBootstrap(master.provider, master.agent_id);
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-instruction', bootstrap, ...masterModelArgs];
    console.log('  MCP server: orchestrator tools available in this session.');
    console.log('  Master bootstrap loaded via --system-instruction.');
    if (masterConfig.model) console.log(`  Model: ${masterConfig.model}`);
    console.log(`  Bootstrap template: ${MASTER_BOOTSTRAP_TEMPLATE} (sent to the master, not printed here).`);
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

let masterSessionName: string;
try {
  // The secret reaches the master only through the tmux launcher's environment (deleted before exec).
  const launch = () => startTmuxSession(master.agent_id, {
    binary,
    args: [...spawnArgs, ...conversationArgs()],
    env: { ...stripNestedProviderEnv(process.env), ORC_MASTER_SECRET: masterSecret } as Record<string, string>,
    cwd: resolveInvocationCwd(),
  }, master.provider);
  let started = launch();
  if (resumable && !(await survives(started.session_handle.slice('tmux:'.length), RESUME_SURVIVAL_MS))) {
    console.warn(`  Could not resume conversation ${conversationId}; starting a fresh one.`);
    recordSessionResumeFailed(STATE_DIR, resumable.session_id, 'provider CLI exited while resuming its conversation');
    resumable = null;
    conversationId = randomUUID();
    started = launch();
  }
  masterSessionName = started.session_handle.slice('tmux:'.length);
  try {
    const startedAt = new Date().toISOString();
    const ref = started.provider_ref;
    const sessionId = resumable?.session_id ?? sessionReset.session_id;
    const identity = { transport: 'tmux', processPid: ref.pid, processStart: ref.process_start };
    if (resumable) {
      resumeProviderSession(STATE_DIR, {
        sessionId, providerRef: ref, at: startedAt, ...identity, credentialHash: credentialHash(masterSecret),
      });
    } else {
      recordProviderSession(STATE_DIR, {
        sessionId,
        runId: null,
        agentId: master.agent_id,
        provider: master.provider,
        providerRef: ref,
        startedAt,
        ...identity,
        credentialHash: credentialHash(masterSecret),
        providerConversationId: conversationId,
      });
    }
    updateAgentRuntime(STATE_DIR, master.agent_id, {
      status: 'running',
      session_handle: started.session_handle,
      session_token: sessionId,
      session_started_at: startedAt,
      provider_ref: ref as typeof master.provider_ref,
      last_heartbeat_at: startedAt,
      last_status_change_at: startedAt,
    });
    // A resumed master keeps its session id; the event names the session that runs.
    appendSessionStartedEvent(STATE_DIR, { ...sessionReset, session_id: sessionId });
  } catch (error) {
    // The master must not outlive a failed start: its secret would be valid nowhere, its state half-written.
    await createTmuxAdapter({ provider: master.provider }).stop(started.session_handle);
    throw error;
  }
} catch (error) {
  // A reset stopped its worker sessions already: restoring their runs would undo it, so it stands.
  if (!resetRuntimeState) restoreVolatileRuntimeStateFromSnapshot(STATE_DIR, sessionReset.snapshot);
  console.error(`Failed to start master provider CLI '${String(binary)}' for ${master.provider}: ${formatErrorMessage(error)}`);
  process.exit(1);
}

// Coordinator spawn deferred to here — the master started and its state is committed.
await ensureCoordinatorRunning();
openMaster(master, masterSessionName);
