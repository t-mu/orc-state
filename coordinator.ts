#!/usr/bin/env node
/**
 * coordinator.ts
 * Usage: node coordinator.ts [--interval-ms=30000] [--mode=autonomous]
 *
 * Main coordinator loop. On each tick:
 *   1. expireStaleLeases — requeue/block expired runs
 *   2. (autonomous mode) for each idle agent, claim + send the next eligible task
 *
 * Control:
 *   SIGINT / SIGTERM — graceful shutdown after current tick
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Agent } from './types/agents.ts';
import type { Claim } from './types/claims.ts';
import type { WorkerPoolConfig, CoordinatorConfig, LeaseConfig, ProviderName } from './lib/providers.ts';
import { resolveWorkerProvider } from './lib/providers.ts';
import type { ActorType, OrcEvent, OrcEventInput } from './types/events.ts';

// Distributive Omit — preserves discriminated union across all members
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
// Allow processTerminalRunEvents to accept events without seq/actor fields (e.g. in tests)
type ProcessableEvent = DistributiveOmit<OrcEvent, 'seq' | 'actor_type' | 'actor_id' | 'event_id'>
  & { seq?: number; actor_type?: ActorType; actor_id?: string; event_id?: string };
import { expireStaleLeasesDetailed, claimTask, finishRun, heartbeat, renewLeaseOnly, markTaskEnvelopeSent, setEscalationNotified, setRunFinalizationState, setRunInputState, startRun, setPrRef, setPrCreatedAt } from './lib/claimManager.ts';
import { getAgent, listCoordinatorAgents, updateAgentRuntime, nextAvailableWorkerName, removeAgent } from './lib/agentRegistry.ts';
import { getGitHostAdapter } from './lib/gitHosts/index.ts';
import { createAdapter } from './adapters/index.ts';
import { adapterDetectInputBlock, adapterExitStatus, adapterInspectSession, adapterOwnsSession, adapterSurvivesCoordinatorExit } from './adapters/interface.ts';
import type { SessionInspection } from './adapters/interface.ts';
import { checkTmux, removeDeadTmuxSocket } from './adapters/tmux.ts';
import { CapabilityRefusal, isStructuredSession, type RuntimeEvent, type RuntimeEventType } from './adapters/runtime.ts';
import { CommandDispatcher, acknowledgeFromRuntime, isDeferred, type AckState, type CommandTransport, type DurableCommand } from './lib/commandDelivery.ts';
import { appendSequencedEvent, closeAllDatabases, eventIdentity, readEventBatch, readEventsForRuns } from './lib/eventLog.ts';
import { newestTimestamp, shouldRenewFromHookActivity } from './lib/runActivity.ts';
import { gcOrphanedHookFiles } from './lib/hookFiles.ts';
import { noProgressEscalationMs } from './lib/runProgress.ts';
import { drainHookEvents, type PermissionHookEvent } from './lib/hookEventBus.ts';
import { inferPhaseTransitions, phaseInferenceClaims } from './lib/phaseInference.ts';
import { readRunActivity, writeRunActivity } from './lib/runActivityStore.ts';
import { RunSignals, type RunHookEvents } from './lib/runSignals.ts';
import { renderTemplate } from './lib/templateRender.ts';
import { ACTIVE_PROJECT, assertProjectMode, ORC_PACKAGE_ROOT, STATE_DIR, EVENTS_FILE, WORKTREES_DIR, TARGET_REPO_ROOT } from './lib/paths.ts';
import { flag, intFlag } from './lib/args.ts';
import { reconcileState } from './lib/reconcile.ts';
import { loadWorkerPoolConfig, loadCoordinatorConfig, loadLeaseConfig, loadSessionsConfig } from './lib/providers.ts';
import { checkSandboxControlSocket } from './lib/sandboxDeps.ts';
import { cleanupRunWorktree, deleteRunWorktree, ensureRunWorktree, getRunWorktree, pruneMissingRunWorktrees } from './lib/runWorktree.ts';
import { HERMETIC_GIT_CONFIG_ARGS } from './lib/gitPlumbing.ts';
import { InjectionScanError } from './lib/promptInjectionScan.ts';
import { pruneOrphanRunTaskSnapshots, taskSnapshotStatus, verifyRunTaskSnapshot } from './lib/documentIndex.ts';
import { resumeWorkerSession, spawnEphemeralWorker } from './lib/workerRuntime.ts';
import { classifySessionExit, decideSessionResume, latestRunSession, recordSessionExit, recordSessionResumeFailed, type ResumeDecision } from './lib/sessionResume.ts';
import { markTaskDoneRuntimeOnly } from './lib/taskCompletion.ts';
import { readEventCheckpoint } from './lib/eventCheckpoint.ts';
import { advanceEventOffset, initializeEventOffset, readEventOffset, wasEventOffsetReset } from './lib/eventOffsets.ts';
import { recordAgentActivity } from './lib/agentActivity.ts';
import { sessionAuthenticator, startControlServer, type ControlServer } from './lib/controlServer.ts';
import {
  IDENTITY_MISMATCH_REASON, SESSION_OWNER_TTL_MS, currentSessionForAgent, currentSessionOwnerId,
  identityMismatch, reconcileSessions, renewSessionOwnership, setSessionState, type SupervisedSession,
  retireDeadMaster,
} from './lib/sessionSupervisor.ts';
import { storeDrawer, wingFromTaskRef, pruneExpiredMemories, pruneByCapacity } from './lib/memoryStore.ts';
import { fileURLToPath } from 'node:url';
import { findTask, readBacklog, readJson } from './lib/stateReader.ts';
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { reduceLifecycleEvent } from './lib/workerLifecycleReducer.ts';
import { resolveOrcBinSh } from './lib/orcBin.ts';
import { builtinPolicies, evaluateRemediationPolicies, loadRemediationConfig } from './lib/remediationPolicies.ts';
import type { RemediationSignals } from './lib/remediationPolicies.ts';
import { AGENT_DEAD_TTL_MS, GIT_OP_TIMEOUT_MS, TASK_TYPES } from './lib/constants.ts';
import type { Backlog } from './types/backlog.ts';
import { writeProjectDescriptor } from './lib/projectContext.ts';
import { readProcessStart } from './lib/processIdentity.ts';
import { controlEndpointCoordinatorPid, isCoordinatorLockHeld, type CoordinatorLock } from './lib/coordinatorLiveness.ts';
import { ensureCoordinatorPidFile, releaseCoordinatorPidFile, type CoordinatorPidRecord, type PidFileCheck } from './lib/coordinatorPidFile.ts';

// ── Adapter singleton cache ────────────────────────────────────────────────
// One adapter instance per provider — preserves in-memory session state across
// multiple coordinator functions (session probes, nudge, dispatch).

const adapterInstances = new Map<string, ReturnType<typeof createAdapter>>();
function getAdapter(provider: string): ReturnType<typeof createAdapter> {
  if (!adapterInstances.has(provider)) {
    const adapter = createAdapter(provider);
    // Duck-typed like isStructuredSession: adapters without a structured runtime may omit onEvent.
    (adapter as { onEvent?: typeof adapter.onEvent }).onEvent?.(onRuntimeEvent);
    // Every direct write (task envelopes, nudges, PR review) passes the supervision gate.
    // Structured sessions receive it as a durable command the provider protocol ACKs.
    adapterInstances.set(provider, {
      ...adapter,
      send: async (sessionHandle: string, text: string) => {
        await assertSessionWritable(adapter, sessionHandle);
        if (isStructuredSession(adapter, sessionHandle)) {
          // A nudge wakes an idle worker; one in the middle of a turn is working and would only queue a stale prompt.
          if (isNudge(text) && adapter.turnActive(sessionHandle)) return '';
          return deliverStructured(sessionHandle, text, 'coordinator_message', `coordinator:${randomUUID()}`);
        }
        return adapter.send(sessionHandle, text);
      },
    });
  }
  return adapterInstances.get(provider)!;
}

// ── Durable commands for structured runtimes (task 203) ────────────────────
// A structured session's input is a durable command: the transport submits it
// over the provider protocol and records `accepted` only when the provider
// answers; turn events then move it to running and completed/failed. CLI
// sessions keep the direct terminal path and are refused by this transport. Input
// for a session whose turn is still running waits in the queue (no attempt is
// used) and goes out when the turn ends.

const commandTransport: CommandTransport = {
  async send(command: DurableCommand) {
    const { adapter, sessionHandle } = structuredRecipient(command);
    const { text } = JSON.parse(command.payload) as { text: string };
    await adapter.submit(sessionHandle, text, { commandId: command.command_id });
    acknowledgeFromRuntime(STATE_DIR, command.command_id, command.session_id!, 'accepted');
  },
  async isAlive(command: DurableCommand) {
    const { adapter, sessionHandle } = structuredRecipient(command);
    return adapter.heartbeatProbe(sessionHandle);
  },
  isBusy(command: DurableCommand) {
    const { adapter, sessionHandle } = structuredRecipient(command);
    return adapter.turnActive(sessionHandle);
  },
};

function isNudge(text: string): boolean {
  return text.startsWith('RUN_NUDGE') || text.startsWith('SESSION_NUDGE');
}

function structuredRecipient(command: DurableCommand) {
  const agent = getAgent(STATE_DIR, command.recipient_id);
  if (!agent?.session_handle || agent.session_token !== command.session_id) throw new Error('Recipient session is not current');
  const adapter = adapterInstances.get(agent.provider) ?? getAdapter(agent.provider);
  if (!isStructuredSession(adapter, agent.session_handle)) {
    throw new CapabilityRefusal(agent.provider, 'command_ack', 'CLI sessions have no protocol acknowledgement');
  }
  return { adapter, sessionHandle: agent.session_handle };
}

let commandDispatcher: CommandDispatcher | null = null;
function getCommandDispatcher(): CommandDispatcher {
  commandDispatcher ??= new CommandDispatcher(STATE_DIR, commandTransport, sessionAuthenticator(STATE_DIR));
  return commandDispatcher;
}

const DELIVERED_STATES = new Set(['sent', 'accepted', 'running', 'completed']);

/**
 * Enqueue `text` for a structured session's run and dispatch it now. Resolves
 * once the provider took it or it is queued behind the running turn; throws
 * otherwise. A run that has ended takes no commands (e.g. FINALIZE_SUCCESS
 * after the coordinator finished the run): the session is cleaned up instead.
 */
async function deliverStructured(sessionHandle: string, text: string, kind: string, idempotencyKey: string): Promise<string> {
  const agentId = sessionHandle.slice(sessionHandle.indexOf(':') + 1);
  const session = currentSessionForAgent(STATE_DIR, agentId);
  if (!session?.run_id) throw new Error(`structured session ${sessionHandle} has no active run to scope the command`);
  const dispatcher = getCommandDispatcher();
  const queued = dispatcher.enqueueFromCoordinator({
    runId: session.run_id, recipientSessionId: session.session_id, idempotencyKey, kind, payload: { text }, maxAttempts: 1,
  });
  const command = await dispatcher.deliver(queued.command_id);
  if (!DELIVERED_STATES.has(command.state) && !isDeferred(command)) {
    throw new Error(`command ${command.command_id} ${command.state}: ${command.last_error ?? 'not delivered'}`);
  }
  return '';
}

const RUNTIME_ACK_STATES: Partial<Record<RuntimeEventType, AckState>> = {
  turn_started: 'running',
  turn_completed: 'completed',
  turn_failed: 'failed',
  turn_interrupted: 'failed',
};

/** Turn lifecycle proven by the provider protocol advances the command that started the turn. */
function onRuntimeEvent(event: RuntimeEvent): void {
  if (event.type === 'approval_refused') {
    log(`${event.agent_id}: refused provider request ${event.provider_event} (approvals are not supported by the ${event.provider} runtime)`);
    return;
  }
  const state = RUNTIME_ACK_STATES[event.type];
  if (!state || !event.command_id) return;
  const session = currentSessionForAgent(STATE_DIR, event.agent_id);
  if (!session) return;
  try {
    acknowledgeFromRuntime(STATE_DIR, event.command_id, session.session_id, state,
      state === 'failed' ? `provider turn ${typeof event.provider_meta.status === 'string' ? event.provider_meta.status : event.type}` : undefined);
  } catch (error) {
    log(`warning: could not record ${event.type} for command ${event.command_id}: ${(error as Error).message}`);
  }
}

/**
 * Refuse to write to a session the supervisor has not confirmed: a recorded
 * session must be `running`, and a live process must still match its recorded
 * PID and start time. Agents without a session record keep legacy behavior.
 */
async function assertSessionWritable(adapter: ReturnType<typeof createAdapter>, sessionHandle: string): Promise<void> {
  const agentId = sessionHandle.slice(sessionHandle.indexOf(':') + 1);
  const session = currentSessionForAgent(STATE_DIR, agentId);
  if (!session) return;
  if (session.state !== 'running') {
    throw new Error(`session ${session.session_id} is ${session.state}: ${session.state_reason ?? 'not writable'}`);
  }
  if (identityMismatch(session, await adapterInspectSession(adapter, sessionHandle))) {
    setSessionState(STATE_DIR, session.session_id, 'unknown', IDENTITY_MISMATCH_REASON, { outcome: 'unknown' });
    throw new Error(`session ${session.session_id} is unknown: ${IDENTITY_MISMATCH_REASON}`);
  }
}

// ── CLI args ───────────────────────────────────────────────────────────────

// Config-backed constants: config file values are defaults, CLI flags override.
const COORD_CONFIG: CoordinatorConfig = loadCoordinatorConfig();
const LEASE_CONFIG: LeaseConfig = loadLeaseConfig();
const INTERVAL_MS = intFlag('interval-ms', COORD_CONFIG.tick_interval_ms);
const MODE        = flag('mode') ?? COORD_CONFIG.mode;
const RUN_START_TIMEOUT_MS = intFlag('run-start-timeout-ms', COORD_CONFIG.run_start_timeout_ms);
const SESSION_READY_TIMEOUT_MS = intFlag('session-ready-timeout-ms', COORD_CONFIG.session_ready_timeout_ms);
const SESSION_READY_NUDGE_MS = intFlag('session-ready-nudge-ms', COORD_CONFIG.session_ready_nudge_ms);
const SESSION_READY_NUDGE_INTERVAL_MS = intFlag('session-ready-nudge-interval-ms', COORD_CONFIG.session_ready_nudge_interval_ms);
const RUN_START_NUDGE_MS = Math.floor(RUN_START_TIMEOUT_MS * 0.1);
const RUN_START_NUDGE_INTERVAL_MS = Math.floor(RUN_START_TIMEOUT_MS * 0.2);
const RUN_INACTIVE_NUDGE_MS = intFlag('run-inactive-nudge-ms', COORD_CONFIG.run_inactive_nudge_ms);
const RUN_INACTIVE_NUDGE_INTERVAL_MS = intFlag('run-inactive-nudge-interval-ms', COORD_CONFIG.run_inactive_nudge_interval_ms);
const CONCURRENCY_LIMIT = COORD_CONFIG.concurrency_limit;
const MEMORY_PRUNE_INTERVAL_MS = intFlag('memory-prune-interval-ms', COORD_CONFIG.memory_prune_interval_ms);
const WORKER_STALE_SOFT_MS = intFlag('worker-stale-soft-ms', COORD_CONFIG.worker_stale_soft_ms);
const WORKER_STALE_NUDGE_MS = intFlag('worker-stale-nudge-ms', COORD_CONFIG.worker_stale_nudge_ms);
const WORKER_STALE_FORCE_FAIL_MS = intFlag('worker-stale-force-fail-ms', COORD_CONFIG.worker_stale_force_fail_ms);
// Runs whose harness reports tool hooks: silence means a real stall, so they get shorter thresholds.
const HOOK_IDLE_NUDGE_MS = intFlag('hook-idle-nudge-ms', COORD_CONFIG.hook_idle_nudge_ms);
const HOOK_IDLE_ESCALATE_MS = intFlag('hook-idle-escalate-ms', COORD_CONFIG.hook_idle_escalate_ms);
// A live run without progress (phase change, commit, lifecycle event) for this long gets worker_needs_attention.
const RUN_NO_PROGRESS_ESCALATE_MS = intFlag('run-no-progress-escalate-ms', COORD_CONFIG.run_no_progress_escalate_ms);
const REMEDIATION_CONFIG = loadRemediationConfig();
const REMEDIATION_POLICIES = builtinPolicies(REMEDIATION_CONFIG);

// ── State ──────────────────────────────────────────────────────────────────

let running = true;
let tickCount = 0;
let ticking = false;
let timerHandle: ReturnType<typeof setInterval> | null = null;
let shutdownStarted = false;
// The pid lock this process acquired; null before acquisition and after release.
let coordinatorLock: CoordinatorPidRecord | null = null;
let lastPidFileCheck: PidFileCheck = 'present';
let controlServer: ControlServer | null = null;
const runStartNudgeAtMs = new Map<string, number>();
const sessionReadyNudgeAtMs = new Map<string, number>();
const runInactiveNudgeAtMs = new Map<string, number>();
const runNudgeCount = new Map<string, number>();
const runLastPhase = new Map<string, string>();
// Per-run activity signals (lib/runSignals.ts): durable and hook activity,
// pending permission events, announced labels and phase evidence. Hook
// activity is projected to run-activity.json for other processes.
const runSignals = new RunSignals({
  softMs: WORKER_STALE_SOFT_MS,
  nudgeMs: WORKER_STALE_NUDGE_MS,
  finalizeRetryMs: RUN_INACTIVE_NUDGE_MS,
  hookIdleEscalateMs: HOOK_IDLE_ESCALATE_MS,
  hookIdleNudgeMs: HOOK_IDLE_NUDGE_MS,
});
let lastMemoryPruneAt = Date.now(); // startup prune counts as first
// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`[coordinator] ${new Date().toISOString()} ${msg}`); }

const EVENT_BATCH_SIZE = 128;
let legacyProcessedIds: Set<string> | null = null;
let legacyLastSeq = 0;
let signalsHydrated = false;

function getEventCursor(): number {
  const cursor = initializeEventOffset(STATE_DIR);
  if (legacyProcessedIds === null) {
    const path = join(STATE_DIR, 'event-checkpoint.json');
    const legacy = existsSync(path) ? readEventCheckpoint(STATE_DIR) : null;
    legacyProcessedIds = new Set(legacy?.processed_event_ids ?? []);
    legacyLastSeq = legacy?.last_processed_seq ?? 0;
  }
  return cursor;
}

function advanceCursor(seq: number): void {
  const current = readEventOffset(STATE_DIR);
  if (seq > current) advanceEventOffset(STATE_DIR, current, seq);
}

/** Append a coordinator event stamped now (unless it carries a `ts`); returns its seq. */
function emit(event: Omit<OrcEventInput, 'ts'> | Record<string, unknown>): number {
  return appendSequencedEvent(STATE_DIR, { ts: new Date().toISOString(), ...event } as OrcEventInput);
}

/** Coerce an agent-provided timestamp to a valid ISO string, or fall back to now. */
function coerceTs(ts: unknown) {
  if (ts && typeof ts === 'string' && Number.isFinite(new Date(ts).getTime())) return ts;
  return new Date().toISOString();
}

/**
 * Coordinator-owned state must not trust future worker timestamps and must not
 * move backwards relative to already-recorded lifecycle timestamps.
 */
function authoritativeStateTs(eventTs: string, floorTs?: string | null) {
  const nowIso = new Date().toISOString();
  const eventMs = new Date(eventTs).getTime();
  const nowMs = new Date(nowIso).getTime();
  const floorMs = typeof floorTs === 'string' ? new Date(floorTs).getTime() : NaN;
  const boundedMs = Math.min(eventMs, nowMs);
  const effectiveMs = Number.isFinite(floorMs)
    ? Math.max(boundedMs, floorMs)
    : boundedMs;
  return new Date(effectiveMs).toISOString();
}

/**
 * Run async thunks in bounded concurrency batches.
 * Returns settled results in original batch order.
 */
async function runBounded(thunks: Array<() => Promise<unknown>>, limit = CONCURRENCY_LIMIT) {
  const results = [];
  for (let i = 0; i < thunks.length; i += limit) {
    const batch = await Promise.allSettled(thunks.slice(i, i + limit).map((fn) => fn()));
    results.push(...batch);
  }
  return results;
}

/**
 * Run nudge thunks with bounded concurrency, log failures, and return the set
 * of agent IDs returned by successful thunks.
 */
async function executeNudgeBatch(nudgeThunks: Array<() => Promise<unknown>>): Promise<Set<string>> {
  const results = await runBounded(nudgeThunks);
  const nudgedAgentIds = new Set<string>();
  for (const result of results) {
    if (result.status === 'rejected') {
      log(`warning: nudge failed: ${(result.reason as Error)?.message ?? 'unknown error'}`);
    } else if (typeof result.value === 'string') {
      nudgedAgentIds.add(result.value);
    }
  }
  return nudgedAgentIds;
}

async function sendTaskEnvelope(agent: Agent, taskRef: string, runId: string) {
  const adapter = getAdapter(agent.provider);
  const envelope = buildTaskEnvelope(taskRef, runId, agent.agent_id);
  try {
    if (isStructuredSession(adapter, agent.session_handle!)) {
      // One envelope per run: a retried dispatch finds the same durable command instead of resending.
      await assertSessionWritable(adapter, agent.session_handle!);
      await deliverStructured(agent.session_handle!, envelope, 'task_envelope', `task-envelope:${runId}`);
    } else {
      await adapter.send(
        agent.session_handle!,
        envelope,
      );
    }
    log(`dispatched ${taskRef} to ${agent.agent_id}`);
    markTaskEnvelopeSent(STATE_DIR, runId, agent.agent_id, {
      actorType: 'coordinator',
      actorId: 'coordinator',
    });
    return true;
  } catch (err) {
    finishRun(STATE_DIR, runId, agent.agent_id, {
      success: false,
      failureReason: `dispatch_error: ${(err as Error).message}`,
      failureCode: 'ERR_DISPATCH_FAILURE',
      policy: 'requeue',
    });
    await cleanupRunCapacity(agent.agent_id);
    throw err;
  }
}

function isAgentSessionReady(agent: Agent | null | undefined) {
  if (!agent?.session_handle || !agent.session_token || !agent.session_started_at || !agent.session_ready_at) {
    return false;
  }
  return new Date(agent.session_ready_at).getTime() >= new Date(agent.session_started_at).getTime();
}

function buildReportForDutyNudge(agent: Agent) {
  return [
    'SESSION_NUDGE',
    `agent_id: ${agent.agent_id}`,
    `session_id: ${agent.session_token ?? '(missing)'}`,
    'Missing required reported_for_duty acknowledgement for this session.',
    'Call this command immediately via your Bash tool:',
    `${resolveOrcBinSh(ORC_PACKAGE_ROOT)} report-for-duty --agent-id=${agent.agent_id} --session-id=${agent.session_token ?? ''}`,
    'SESSION_NUDGE_END',
  ].join('\n');
}

async function processClaimedSessionReadiness(agents: Agent[], claims: Claim[]) {
  const nowMs = Date.now();
  const byAgent = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const nudgeWork = [];

  for (const claim of claims ?? []) {
    if (claim.state !== 'claimed') {
      sessionReadyNudgeAtMs.delete(claim.run_id);
      continue;
    }
    if (claim.task_envelope_sent_at) {
      sessionReadyNudgeAtMs.delete(claim.run_id);
      continue;
    }
    const agent = byAgent.get(claim.agent_id);
    if (!agent || agent.status === 'offline') continue;

    if (!agent.session_handle) {
      // The session is gone before the worker reported for duty. Its handle was
      // cleared, so no exit status is observable: the decision classifies the exit
      // as unknown and always requeues for a fresh worker.
      await resumeOrRequeue(claim, agent, {
        reason: 'session_start_failed: worker session is gone before reported_for_duty',
        code: 'ERR_SESSION_START_FAILED',
      });
      sessionReadyNudgeAtMs.delete(claim.run_id);
      continue;
    }

    if (isAgentSessionReady(agent)) {
      try {
        await sendTaskEnvelope(agent, claim.task_ref, claim.run_id);
      } catch (err) {
        log(`ERROR dispatching pending envelope for ${claim.task_ref} to ${claim.agent_id}: ${(err as Error).message}`);
      }
      sessionReadyNudgeAtMs.delete(claim.run_id);
      continue;
    }

    const sessionAnchor = agent.session_started_at ?? claim.claimed_at ?? null;
    if (!sessionAnchor) continue;
    const ageMs = nowMs - new Date(sessionAnchor).getTime();
    if (Number.isNaN(ageMs)) continue;

    if (ageMs >= SESSION_READY_TIMEOUT_MS) {
      finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
        success: false,
        failureReason: 'reported_for_duty timeout: worker did not acknowledge session readiness in time',
        failureCode: 'ERR_SESSION_READY_TIMEOUT',
        policy: 'requeue',
      });
      await cleanupRunCapacity(claim.agent_id);
      sessionReadyNudgeAtMs.delete(claim.run_id);
      log(`run ${claim.run_id} timed out waiting for reported_for_duty; requeued ${claim.task_ref}`);
      continue;
    }

    if (ageMs < SESSION_READY_NUDGE_MS || !agent.session_token) continue;
    const lastNudgeAt = sessionReadyNudgeAtMs.get(claim.run_id) ?? 0;
    if (nowMs - lastNudgeAt < SESSION_READY_NUDGE_INTERVAL_MS) continue;

    const agentSnapshot = { ...agent };
    const runId = claim.run_id;
    nudgeWork.push(async () => {
      const adapter = getAdapter(agentSnapshot.provider);
      await adapter.send(agentSnapshot.session_handle!, buildReportForDutyNudge(agentSnapshot));
      sessionReadyNudgeAtMs.set(runId, nowMs);
      log(`nudged ${agentSnapshot.agent_id} for missing reported_for_duty on session ${agentSnapshot.session_token}`);
    });
  }

  await executeNudgeBatch(nudgeWork);
}

function claimAwaitingInput(claim: Claim) {
  return claim?.input_state === 'awaiting_input';
}

function detectBlockingPromptQuestion(
  adapter: ReturnType<typeof createAdapter>,
  sessionHandle: string,
  hookEvents: PermissionHookEvent[] = [],
) {
  const prompt = adapterDetectInputBlock(adapter, sessionHandle, hookEvents);
  if (typeof prompt !== 'string') return null;
  const trimmed = prompt.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getClaim(runId: string): Claim | null {
  try {
    const claims = (readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] }).claims ?? [];
    return (claims).find((claim) => claim.run_id === runId) ?? null;
  } catch {
    return null;
  }
}

function branchContainsMain(branch: string) {
  const result = spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, 'merge-base', '--is-ancestor', 'main', branch], {
    cwd: TARGET_REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_OP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
}

function pushMain() {
  const result = spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, 'push'], {
    cwd: TARGET_REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_OP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git push failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
}

function mergeTaskBranch(branch: string, taskRef: string) {
  const result = spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, 'merge', branch, '--no-ff', '-m', `task(${taskRef}): merge worktree`], {
    cwd: TARGET_REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_OP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git merge failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
}

async function sendCoordinatorMessage(agentId: string, message: string) {
  const agent = getAgent(STATE_DIR, agentId);
  if (!agent?.session_handle || agent.status === 'offline') return false;
  const adapter = getAdapter(agent.provider);
  try {
    await adapter.send(agent.session_handle, message);
    return true;
  } catch {
    return false;
  }
}

async function markFinalizeBlocked(claim: Claim, workerPoolConfig: WorkerPoolConfig, reason: string) {
  try {
    setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id, {
      finalizationState: 'blocked_finalize',
      blockedReason: reason,
    });
  } catch {
    return false;
  }
  await cleanupRunCapacity(claim.agent_id);
  log(`run ${claim.run_id} blocked during finalization: ${reason}`);
  return true;
}

/** A master that exited while detached goes offline and loses its credential (v1/master-tmux). */
async function retireMasterIfDead(agents: Agent[]): Promise<void> {
  try {
    const retired = await retireDeadMaster(STATE_DIR, agents, (master) => getAdapter(master.provider).heartbeatProbe(master.session_handle!));
    if (retired) log('master session exited; marked the master offline and closed its session');
  } catch (error) {
    log(`warning: master liveness check failed: ${(error as Error).message}`);
  }
}

function checkMasterHealth(agents: Agent[]): void {
  const master = agents.find((a) => a.role === 'master');
  if (!master) return;
  if (master.status !== 'offline' && master.status !== 'dead') return;

  console.warn(`[coordinator] MASTER OFFLINE: agent '${master.agent_id}' is ${master.status}. Run 'orc start-session' to restore the master session.`);
}

async function requestFinalizeRebase(claim: Claim, workerPoolConfig: WorkerPoolConfig, reason: string, { incrementRetry = true } = {}) {
  const latestClaim = getClaim(claim.run_id) ?? claim;
  const hadPendingFinalizeRequest = latestClaim.finalization_state === 'finalize_rebase_requested';
  const retryCount = latestClaim.finalization_retry_count ?? 0;
  if (retryCount >= 2 && incrementRetry) {
    return markFinalizeBlocked(latestClaim, workerPoolConfig, reason);
  }

  let updatedClaim = latestClaim;
  try {
    updatedClaim = setRunFinalizationState(STATE_DIR, latestClaim.run_id, latestClaim.agent_id, {
      finalizationState: 'finalize_rebase_requested',
      retryCountDelta: 0,
      blockedReason: null,
    });
  } catch (error) {
    log(`warning: failed to record finalize_rebase_requested for ${latestClaim.run_id}: ${(error as Error).message}`);
    return false;
  }

  const sent = await sendCoordinatorMessage(updatedClaim.agent_id, buildFinalizeRebaseRequest(updatedClaim, reason));
  if (!sent) {
    log(`warning: failed to deliver finalize rebase request to ${updatedClaim.agent_id} for ${updatedClaim.run_id}`);
    if (hadPendingFinalizeRequest) {
      return markFinalizeBlocked(updatedClaim, workerPoolConfig, `${reason}; finalize request could not be delivered twice`);
    }
    return sent;
  }

  if (incrementRetry) {
    try {
      updatedClaim = setRunFinalizationState(STATE_DIR, updatedClaim.run_id, updatedClaim.agent_id, {
        finalizationState: 'finalize_rebase_requested',
        retryCountDelta: 1,
        blockedReason: null,
      });
    } catch (error) {
      log(`warning: failed to increment finalize retry count for ${updatedClaim.run_id}: ${(error as Error).message}`);
    }
  }
  return sent;
}

function resolveMergeStrategy(
  task: { merge_strategy?: string | undefined } | null,
  config: CoordinatorConfig,
): 'direct' | 'pr' {
  return ((task?.merge_strategy) ?? config.merge_strategy ?? 'direct') as 'direct' | 'pr';
}


async function mergeAndFinishDirectRun(claim: Claim, runWorktree: { branch: string; worktree_path?: string }, workerPoolConfig: WorkerPoolConfig) {
  try {
    mergeTaskBranch(runWorktree.branch, claim.task_ref);
  } catch (error) {
    return requestFinalizeRebase(claim, workerPoolConfig, (error as Error).message);
  }

  try {
    if (findTask(readBacklog(STATE_DIR), claim.task_ref)?.status !== 'done') {
      markTaskDoneRuntimeOnly(claim.task_ref, 'coordinator', STATE_DIR);
    }
  } catch (error) {
    return markFinalizeBlocked(claim, workerPoolConfig, `failed to mark runtime task done after merge: ${(error as Error).message}`);
  }

  try {
    pushMain();
  } catch (error) {
    log(`warning: git push failed after merging ${claim.task_ref}: ${(error as Error).message}`);
  }

  finishRun(STATE_DIR, claim.run_id, claim.agent_id, { success: true });
  await sendCoordinatorMessage(claim.agent_id, buildFinalizeSuccessNotice(claim, runWorktree.branch));
  await cleanupRunCapacity(claim.agent_id);
  try {
    const cleaned = cleanupRunWorktree(STATE_DIR, claim.run_id);
    if (!cleaned) {
      log(`merged ${claim.task_ref} from ${runWorktree.branch}; cleanup pending`);
      return true;
    }
  } catch (error) {
    log(`warning: cleanupRunWorktree failed for ${claim.run_id}: ${(error as Error).message}`);
    log(`merged ${claim.task_ref} from ${runWorktree.branch}; cleanup pending`);
    return true;
  }
  log(`finalized and merged ${claim.task_ref} from ${runWorktree.branch}`);
  return true;
}

async function finalizeRun(claim: Claim, workerPoolConfig: WorkerPoolConfig, eventSeq = 0) {
  const runWorktree = getRunWorktree(STATE_DIR, claim.run_id);
  if (!runWorktree?.branch) {
    return markFinalizeBlocked(claim, workerPoolConfig, 'missing run worktree metadata for finalization');
  }

  // ── PR reviewer work_complete → merge PR and release ─────────────────────
  if (claim.finalization_state === 'pr_review_in_progress') {
    const prRef = claim.pr_ref;
    if (!prRef || !COORD_CONFIG.pr_provider) {
      return markFinalizeBlocked(claim, workerPoolConfig, 'pr_review_in_progress but pr_ref or pr_provider is missing');
    }
    const adapter = getGitHostAdapter(COORD_CONFIG.pr_provider, TARGET_REPO_ROOT);
    try {
      adapter.mergePr(prRef);
    } catch (error) {
      return markFinalizeBlocked(claim, workerPoolConfig, `PR merge failed: ${(error as Error).message}`);
    }

    try {
      setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id, { finalizationState: 'pr_merged' });
    } catch { /* ignore races */ }

    try {
      if (findTask(readBacklog(STATE_DIR), claim.task_ref)?.status !== 'done') {
        markTaskDoneRuntimeOnly(claim.task_ref, 'coordinator', STATE_DIR);
      }
    } catch (error) {
      return markFinalizeBlocked(claim, workerPoolConfig, `failed to mark runtime task done after PR merge: ${(error as Error).message}`);
    }

    finishRun(STATE_DIR, claim.run_id, claim.agent_id, { success: true });
    await sendCoordinatorMessage(claim.agent_id, buildFinalizeSuccessNotice(claim, runWorktree.branch));
    await cleanupRunCapacity(claim.agent_id);
    try {
      const cleaned = cleanupRunWorktree(STATE_DIR, claim.run_id);
      if (!cleaned) {
        log(`PR merged ${claim.task_ref} (${prRef}); cleanup pending`);
        return true;
      }
    } catch (error) {
      log(`warning: cleanupRunWorktree failed after PR merge for ${claim.run_id}: ${(error as Error).message}`);
      log(`PR merged ${claim.task_ref} (${prRef}); cleanup pending`);
      return true;
    }
    log(`PR merged and finalized ${claim.task_ref} (${prRef})`);
    return true;
  }

  // ── awaiting_finalize: branch on merge strategy ───────────────────────────
  await sendCoordinatorMessage(claim.agent_id, buildFinalizeWaitNotice(claim));

  const task = findTask(readBacklog(STATE_DIR), claim.task_ref);
  const strategy = resolveMergeStrategy(task, COORD_CONFIG);

  if (strategy === 'pr') {
    if (!COORD_CONFIG.pr_provider) {
      return markFinalizeBlocked(claim, workerPoolConfig, 'merge_strategy=pr but pr_provider is not configured');
    }
    const gitAdapter = getGitHostAdapter(COORD_CONFIG.pr_provider, TARGET_REPO_ROOT);

    // Push the branch
    try {
      gitAdapter.pushBranch(COORD_CONFIG.pr_push_remote, runWorktree.branch);
    } catch (error) {
      return markFinalizeBlocked(claim, workerPoolConfig, `failed to push branch for PR: ${(error as Error).message}`);
    }

    // Create the PR
    const prTitle = task?.title ?? claim.task_ref;
    const prBody = renderTemplate('pr-template-v1.txt', {
      task_ref: claim.task_ref,
      run_id: claim.run_id,
      review_level: task?.review_level ?? 'full',
      acceptance_criteria: task?.acceptance_criteria ? '- ' + task.acceptance_criteria.join('\n- ') : 'No criteria specified',
      agent_id: claim.agent_id,
      branch: runWorktree.branch,
    });
    let prRef: string;
    try {
      prRef = gitAdapter.createPr(prTitle, runWorktree.branch, prBody);
    } catch (error) {
      return markFinalizeBlocked(claim, workerPoolConfig, `failed to create PR: ${(error as Error).message}`);
    }

    const nowIso = new Date().toISOString();
    try {
      setPrRef(STATE_DIR, claim.run_id, prRef);
      setPrCreatedAt(STATE_DIR, claim.run_id, nowIso, eventSeq > 0 ? eventSeq : undefined);
    } catch (error) {
      log(`warning: failed to store PR fields for ${claim.run_id}: ${(error as Error).message}`);
    }

    try {
      setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id, { finalizationState: 'pr_created' });
    } catch (error) {
      log(`warning: failed to set pr_created state for ${claim.run_id}: ${(error as Error).message}`);
    }

    // Extend lease for the PR review duration
    try {
      renewLeaseOnly(STATE_DIR, claim.run_id, { leaseDurationMs: COORD_CONFIG.pr_finalize_lease_ms });
    } catch (error) {
      log(`warning: failed to extend lease for PR finalization on ${claim.run_id}: ${(error as Error).message}`);
    }

    // Send PR_REVIEW into the existing worker's session
    const workerAgent = getAgent(STATE_DIR, claim.agent_id);
    if (!workerAgent?.session_handle) {
      return markFinalizeBlocked(claim, workerPoolConfig, 'worker session_handle missing at PR_REVIEW send time');
    }
    const prReviewMessage = renderTemplate('pr-review-envelope-v1.txt', {
      pr_ref: prRef,
      run_id: claim.run_id,
      task_ref: claim.task_ref,
      review_level: task?.review_level ?? 'full',
      acceptance_criteria: task?.acceptance_criteria?.join('\n') ?? '',
      worktree_path: runWorktree.worktree_path ?? '',
      orc_bin: resolveOrcBinSh(ORC_PACKAGE_ROOT),
    });
    try {
      await getAdapter(workerAgent.provider).send(workerAgent.session_handle, prReviewMessage);
    } catch (error) {
      return markFinalizeBlocked(claim, workerPoolConfig, `failed to send PR_REVIEW to worker ${claim.agent_id}: ${(error as Error).message}`);
    }

    try {
      setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id, { finalizationState: 'pr_review_in_progress' });
    } catch (error) {
      log(`warning: failed to set pr_review_in_progress state for ${claim.run_id}: ${(error as Error).message}`);
    }

    log(`PR created for ${claim.task_ref}: ${prRef}; sent PR_REVIEW to worker ${claim.agent_id}`);
    return true;
  }

  // ── Direct finalization path (unchanged) ──────────────────────────────────
  let mainIncluded = false;
  try {
    mainIncluded = branchContainsMain(runWorktree.branch);
  } catch (error) {
    return markFinalizeBlocked(claim, workerPoolConfig, (error as Error).message);
  }

  if (!mainIncluded) {
    return requestFinalizeRebase(claim, workerPoolConfig, 'branch is not rebased onto latest main');
  }

  return mergeAndFinishDirectRun(claim, runWorktree, workerPoolConfig);
}

function recordCoordinatorInputRequest(claim: Claim, question: string, reason: string) {
  const nowIso = new Date().toISOString();
  try {
    setRunInputState(STATE_DIR, claim.run_id, claim.agent_id, {
      inputState: 'awaiting_input',
      requestedAt: nowIso,
    });
  } catch {
    return false;
  }
  emit({
    ts: nowIso,
    event: 'input_requested',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    run_id: claim.run_id,
    task_ref: claim.task_ref,
    agent_id: claim.agent_id,
    payload: {
      question,
      reason,
    },
  });
  log(`run ${claim.run_id} is awaiting input: ${reason}`);
  return true;
}

function activeClaimAgents(claims: Claim[]) {
  const busy = new Set<string>();
  for (const claim of claims ?? []) {
    if (claim?.agent_id && ['claimed', 'in_progress'].includes(claim.state)) {
      busy.add(claim.agent_id);
    }
  }
  return busy;
}

async function stopAgentSession(agent: Agent | null | undefined) {
  if (!agent?.session_handle) return;
  const adapter = getAdapter(agent.provider);
  try {
    await adapter.stop(agent.session_handle);
  } catch {
    // Best-effort stop; runtime cleanup still happens below.
  }
}


/** Every worker is task-scoped: stop its session and drop its registry entry. */
async function cleanupRunCapacity(agentId: string) {
  const agent = getAgent(STATE_DIR, agentId);
  if (!agent) return;
  await stopAgentSession(agent);
  removeAgent(STATE_DIR, agentId);
}

/**
 * The one exit for a run whose worker session is gone (task v1/run-resume).
 * A crashed session that can resume (lib/sessionResume.ts decideSessionResume)
 * is relaunched in place on the same claim and nudged to continue; anything
 * else fails the run with `policy: requeue` and frees its worker, as before.
 */
async function resumeOrRequeue(
  claim: Claim,
  agent: Agent | null | undefined,
  failure: { reason: string; code: string },
): Promise<'resumed' | 'requeued'> {
  const session = agent ? latestRunSession(STATE_DIR, agent.agent_id, claim.run_id) : null;
  let decision: ResumeDecision = { resume: false, reason: 'no session record for this run', budgetExhausted: false };
  if (agent && session) {
    const adapter = getAdapter(agent.provider);
    const status = agent.session_handle ? adapterExitStatus(adapter, agent.session_handle) : null;
    const exitReason = classifySessionExit(status, { workComplete: claim.finalization_state != null });
    recordSessionExit(STATE_DIR, session.session_id, exitReason);
    const worktree = getRunWorktree(STATE_DIR, claim.run_id);
    const worktreePath = worktree?.worktree_path ?? null;
    decision = decideSessionResume({
      setting: sessionResumeSetting(),
      provider: agent.provider,
      transport: session.transport,
      conversationId: session.provider_conversation_id,
      exitReason,
      resumeCount: session.resume_count,
      worktreeExists: Boolean(worktreePath && existsSync(worktreePath)),
    });
    if (decision.resume && worktreePath) {
      const workerPoolConfig = loadWorkerPoolConfig();
      const task = findTask(readBacklog(STATE_DIR), claim.task_ref);
      const result = await resumeWorkerSession(STATE_DIR, agent, session, {
        adapter,
        workingDirectory: worktreePath,
        repoRoot: ORC_PACKAGE_ROOT,
        taskModel: task?.model ?? null,
        executionMode: workerPoolConfig.execution_mode,
        sandboxNetwork: workerPoolConfig.sandbox_network,
        reason: failure.reason,
      });
      if (result.ok) {
        log(`resumed ${agent.agent_id} for run ${claim.run_id} (session ${session.session_id}, generation ${result.generation}) after ${failure.reason}`);
        try {
          await sendResumeNudge(adapter, agent, claim, session.session_id, result.generation);
        } catch (error) {
          log(`warning: resume nudge to ${agent.agent_id} failed: ${(error as Error).message}`);
        }
        return 'resumed';
      }
      decision = { resume: false, reason: `relaunch failed: ${result.reason}`, budgetExhausted: false };
      recordSessionResumeFailed(STATE_DIR, session, decision.reason, result.generation);
    } else if (!decision.resume && decision.budgetExhausted) {
      recordSessionResumeFailed(STATE_DIR, session, decision.reason);
    }
  }
  finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
    success: false,
    failureReason: failure.reason,
    failureCode: failure.code,
    policy: 'requeue',
  });
  await cleanupRunCapacity(claim.agent_id);
  if (session) log(`run ${claim.run_id} not resumed: ${decision.resume ? 'no worktree' : decision.reason}`);
  return 'requeued';
}

/** An unreadable setting (e.g. ORC_SESSIONS_RESUME=false) must not stall the dead-session path: requeue. */
function sessionResumeSetting(): 'auto' | 'off' {
  try {
    return loadSessionsConfig().resume;
  } catch (error) {
    log(`warning: ${(error as Error).message}; dead sessions are requeued, not resumed`);
    return 'off';
  }
}

async function sendResumeNudge(adapter: ReturnType<typeof createAdapter>, agent: Agent, claim: Claim, sessionId: string, generation: number) {
  const text = buildResumeNudge(claim, sessionId, generation);
  if (isStructuredSession(adapter, agent.session_handle!)) {
    await deliverStructured(agent.session_handle!, text, 'session_resume', `session-resume:${sessionId}:${generation}`);
  } else {
    await adapter.send(agent.session_handle!, text);
  }
}

function hasOtherActiveClaim(agentId: string, runId: string) {
  try {
    const claims = (readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] }).claims ?? [];
    return claims.some((claim) =>
      claim.agent_id === agentId
      && claim.run_id !== runId
      && ['claimed', 'in_progress'].includes(claim.state),
    );
  } catch {
    return false;
  }
}

/**
 * Remove worker records that no run needs any more: offline or dead workers,
 * workers whose session process has exited, and workers silent past the dead
 * TTL. Workers holding an active claim are left to the run lifecycle; the
 * master and scouts (removed with remove_scout) are never touched. A session
 * this coordinator cannot confirm or write to (recoverable/unknown) is never
 * stopped here: it stays visible until it exits or an operator removes it.
 */
async function removeStaleWorkers(agents: Agent[], claims: Claim[], nowMs = Date.now()) {
  const busyAgents = activeClaimAgents(claims);
  let removed = false;
  for (const agent of agents ?? []) {
    if (!agent?.agent_id) continue;
    if (agent.role === 'master' || agent.role === 'scout') continue;
    if (busyAgents.has(agent.agent_id)) continue;
    const session = currentSessionForAgent(STATE_DIR, agent.agent_id);
    if (session && (session.state === 'recoverable' || session.state === 'unknown')) continue;

    let reason: string | null = null;
    if (agent.status === 'offline' || agent.status === 'dead') {
      reason = `status_${agent.status}`;
    } else {
      const lastHeartbeatMs = typeof agent.last_heartbeat_at === 'string'
        ? new Date(agent.last_heartbeat_at).getTime()
        : Number.NaN;
      const elapsedMs = nowMs - lastHeartbeatMs;
      if (Number.isFinite(elapsedMs) && elapsedMs >= AGENT_DEAD_TTL_MS) {
        emit({
          event: 'agent_marked_dead',
          actor_type: 'coordinator',
          actor_id: 'coordinator',
          agent_id: agent.agent_id,
          payload: { elapsed_ms: elapsedMs },
        });
        reason = 'heartbeat_expired';
      } else if (agent.session_handle) {
        try {
          if (!(await getAdapter(agent.provider).heartbeatProbe(agent.session_handle))) reason = 'session_exited';
        } catch (error) {
          // An unanswerable probe is not proof of death: keep the worker.
          log(`warning: could not probe worker ${agent.agent_id}: ${(error as Error).message}`);
        }
      }
    }
    if (!reason) continue;
    if (reason !== 'heartbeat_expired') {
      emit({
        event: 'agent_offline',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        agent_id: agent.agent_id,
        payload: { reason: 'worker_record_removed', code: reason },
      });
    }
    await cleanupRunCapacity(agent.agent_id);
    log(`removed worker ${agent.agent_id} (${reason})`);
    removed = true;
  }
  return removed;
}

// ── Hook-event bus ─────────────────────────────────────────────────────────

/**
 * Restore run signals once, on the first tick after a start: the hook
 * snapshots in run-activity.json and the active runs' events. Returns true
 * when replayed worker notes changed a run's activity snapshot.
 */
function hydrateRunSignals(claims: Claim[]): boolean {
  if (signalsHydrated) return false;
  try {
    const activeRunIds = activeRunIdsOf(claims);
    const { hookActivity } = runSignals.hydrate(readRunActivity(STATE_DIR), readEventsForRuns(EVENTS_FILE, activeRunIds));
    signalsHydrated = true;
    return hookActivity.length > 0;
  } catch (error) {
    // Retried on the next tick; until then the run signals start from this tick's events.
    log(`warning: failed to hydrate run signals: ${(error as Error).message}`);
    return false;
  }
}

function activeRunIdsOf(claims: Claim[]): string[] {
  return (claims ?? []).filter((claim) => claim.state === 'claimed' || claim.state === 'in_progress').map((claim) => claim.run_id);
}

/**
 * The single consumer of `pty-hook-events/*.ndjson`. Drains each active run's
 * hook file once per tick into RunSignals: permission events wait for the
 * run's input-block check; tool/activity/turn_end events update the run's
 * activity snapshot (worker notes arrive on durable events instead, folded in
 * processEventCheckpoint). Hook activity renews the run's heartbeat and lease like
 * a phase event once the lease is half used or the last heartbeat is half a
 * lease old (shouldRenewFromHookActivity), and a new todo/note label may emit
 * `activity_note`.
 *
 * Permission events are held in memory until the run's input-block check
 * consumes them (for a claimed run, the run-start nudge check). A coordinator
 * restart in between drops them; the check then falls back to scanning the
 * session output, as it does for providers without hooks.
 */
function ingestHookEvents(claims: Claim[], nowMs: number = Date.now()): boolean {
  const active = (claims ?? []).filter((claim) => claim.state === 'claimed' || claim.state === 'in_progress');
  const hookEvents = new Map<string, RunHookEvents>();
  for (const claim of active) {
    hookEvents.set(claim.run_id, { agentId: claim.agent_id, ...drainHookEvents(claim.agent_id) });
  }
  const { hookActivity } = runSignals.ingest([], hookEvents, nowMs);
  const byRun = new Map(active.map((claim) => [claim.run_id, claim]));
  for (const { runId, previousTs, ts } of hookActivity) {
    const claim = byRun.get(runId);
    if (claim?.state === 'in_progress' && ts && ts !== previousTs
      && shouldRenewFromHookActivity(claim, ts, nowMs, LEASE_CONFIG.default_ms)) {
      try {
        heartbeat(STATE_DIR, claim.run_id, claim.agent_id, { emitEvent: false, at: ts, leaseDurationMs: LEASE_CONFIG.default_ms });
        recordAgentActivity(STATE_DIR, claim.agent_id, { at: ts });
      } catch {
        // Ignore races with terminal events or expired leases.
      }
    }
  }
  for (const claim of active) maybeEmitActivityNote(claim, nowMs);
  return hookActivity.length > 0;
}

/**
 * Forget every run that is no longer active and rewrite run-activity.json
 * when a snapshot changed or was dropped.
 */
function retainActiveRunSignals(claims: Claim[], hookActivityChanged: boolean): void {
  const active = new Set(activeRunIdsOf(claims));
  let changed = hookActivityChanged;
  for (const runId of runSignals.knownRuns()) {
    if (!active.has(runId) && runSignals.forget(runId)) changed = true;
  }
  if (!changed) return;
  try {
    writeRunActivity(STATE_DIR, runSignals.hookActivityMap());
  } catch (error) {
    log(`warning: failed to write run activity: ${(error as Error).message}`);
  }
}

/**
 * Infer each active run's phase from gate commands and this tick's tool hook
 * events (lib/phaseInference.ts) and emit `phase_started {inferred: true}` for
 * every forward transition. Explicit phase events newer than the evidence win.
 * The event is stamped with the emit time, after every event already in the
 * log, and keeps the evidence time in `payload.evidence_ts`: phases are ordered
 * by seq everywhere (isLaterPhaseEvent).
 */
function inferRunPhases(claims: Claim[], nowMs: number = Date.now()): void {
  for (const claim of claims ?? []) {
    if (claim.state !== 'claimed' && claim.state !== 'in_progress') continue;
    const current = runSignals.currentPhase(claim.run_id);
    for (const transition of inferPhaseTransitions(current, runSignals.phaseCandidates(claim, nowMs))) {
      const seq = emit({
        event: 'phase_started',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        run_id: claim.run_id,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        phase: transition.phase,
        payload: { phase: transition.phase, inferred: true, evidence: transition.evidence, evidence_ts: transition.ts },
      });
      runSignals.recordPhase(claim.run_id, transition.phase, transition.ts, nowMs, seq);
      log(`inferred phase ${transition.phase} for run ${claim.run_id} (${transition.evidence})`);
    }
  }
}

function maybeEmitActivityNote(claim: Claim, nowMs: number): void {
  // Tool labels change on nearly every call; they stay in run-activity.json, out of events.db.
  const activity = runSignals.currentActivity(claim.run_id, nowMs);
  if (!activity) return;
  emit({
    event: 'activity_note',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    run_id: claim.run_id,
    task_ref: claim.task_ref,
    agent_id: claim.agent_id,
    payload: { label: activity.label, source: activity.source },
  });
  runSignals.markActivityAnnounced(claim.run_id, activity.label, nowMs);
}

async function enforceRunStartLifecycle(agents: Agent[], claims: Claim[]) {
  const nowMs = Date.now();
  const byAgent = new Map(agents.map((a) => [a.agent_id, a]));
  const nudgeWork = [];

  for (const claim of claims ?? []) {
    if (claim.state !== 'claimed') {
      runStartNudgeAtMs.delete(claim.run_id);
      continue;
    }
    if (claimAwaitingInput(claim)) {
      runStartNudgeAtMs.delete(claim.run_id);
      continue;
    }

    const envelopeAnchor = claim.task_envelope_sent_at ?? null;
    if (!envelopeAnchor) {
      runStartNudgeAtMs.delete(claim.run_id);
      continue;
    }

    const ageMs = nowMs - new Date(envelopeAnchor).getTime();
    if (Number.isNaN(ageMs)) continue;

    if (ageMs >= RUN_START_TIMEOUT_MS) {
      finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
        success: false,
        failureReason: 'run_started timeout: worker did not acknowledge start in time',
        failureCode: 'ERR_RUN_START_TIMEOUT',
        policy: 'requeue',
      });
      await cleanupRunCapacity(claim.agent_id);
      runStartNudgeAtMs.delete(claim.run_id);
      log(`run ${claim.run_id} timed out waiting for run_started; requeued ${claim.task_ref}`);
      continue;
    }

    if (ageMs < RUN_START_NUDGE_MS) continue;
    const lastNudgeAt = runStartNudgeAtMs.get(claim.run_id) ?? 0;
    if (nowMs - lastNudgeAt < RUN_START_NUDGE_INTERVAL_MS) continue;

    const agent = byAgent.get(claim.agent_id);
    if (!agent?.session_handle || agent.status === 'offline') continue;
    const adapter = getAdapter(agent.provider);
    const blockingQuestion = detectBlockingPromptQuestion(adapter, agent.session_handle, runSignals.takePermission(claim.run_id));
    if (blockingQuestion) {
      recordCoordinatorInputRequest(claim, blockingQuestion, 'provider_interactive_prompt');
      runStartNudgeAtMs.delete(claim.run_id);
      continue;
    }

    const claimSnapshot = { ...claim };
    const agentSessionHandle = agent.session_handle
    nudgeWork.push(async () => {
      const adapter = getAdapter(agent.provider);
      await adapter.send(agentSessionHandle, buildRunStartNudge(claimSnapshot));
      emit({
        event: 'need_input',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        run_id: claimSnapshot.run_id,
        task_ref: claimSnapshot.task_ref,
        agent_id: claimSnapshot.agent_id,
        payload: { reason: 'run_start_ack_missing', action: 'nudge_sent' },
      });
      runStartNudgeAtMs.set(claimSnapshot.run_id, nowMs);
      log(`nudged ${claimSnapshot.agent_id} for missing run_started on ${claimSnapshot.run_id}`);
      return claimSnapshot.agent_id; // returned to caller for same-tick exclusion
    });
  }

  return executeNudgeBatch(nudgeWork);
}

async function executeRemediation(
  policyId: string,
  action: string,
  message: string,
  claim: Claim,
  agent: Agent,
) {
  const emitRemediationEvent = (appliedAction = action) => {
    emit({
      event: 'remediation_applied',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: claim.run_id,
      task_ref: claim.task_ref,
      agent_id: claim.agent_id,
      payload: { policy_id: policyId, action: appliedAction, message },
    });
  };

  switch (action) {
    case 'record_input':
      recordCoordinatorInputRequest(claim, message, `remediation_policy:${policyId}`);
      emitRemediationEvent();
      log(`remediation[${policyId}]: recorded input request for run ${claim.run_id}`);
      break;

    case 'nudge_targeted':
      if (agent?.session_handle && agent.status !== 'offline') {
        const adapter = getAdapter(agent.provider);
        await adapter.send(agent.session_handle, buildInProgressNudge(claim, message));
        runNudgeCount.set(claim.run_id, (runNudgeCount.get(claim.run_id) ?? 0) + 1);
        runInactiveNudgeAtMs.set(claim.run_id, Date.now());
      }
      emitRemediationEvent();
      log(`remediation[${policyId}]: sent targeted nudge for run ${claim.run_id}`);
      break;

    case 'requeue_now':
    case 'block': {
      if (policyId === 'session_dead') {
        // A dead session goes through the one resume-or-requeue decision.
        const outcome = await resumeOrRequeue(claim, agent, { reason: `remediation[${policyId}]: ${message}`, code: 'ERR_REMEDIATION_REQUEUE' });
        // The event reports what was done: a resumed run was not requeued.
        emitRemediationEvent(outcome === 'resumed' ? 'resume' : action);
        log(`remediation[${policyId}]: ${outcome} run ${claim.run_id}`);
        if (outcome === 'resumed') break;
        runInactiveNudgeAtMs.delete(claim.run_id);
        runNudgeCount.delete(claim.run_id);
        runLastPhase.delete(claim.run_id);
        break;
      }
      const policy = action === 'block' ? 'block' as const : 'requeue' as const;
      finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
        success: false,
        failureReason: `remediation[${policyId}]: ${message}`,
        failureCode: action === 'block' ? 'ERR_REMEDIATION_BLOCK' : 'ERR_REMEDIATION_REQUEUE',
        policy,
      });
      await cleanupRunCapacity(claim.agent_id);
      runInactiveNudgeAtMs.delete(claim.run_id);
      runNudgeCount.delete(claim.run_id);
      runLastPhase.delete(claim.run_id);
      emitRemediationEvent();
      log(`remediation[${policyId}]: ${action === 'block' ? 'blocked' : 'requeued'} run ${claim.run_id}`);
      break;
    }

    default:
      log(`remediation[${policyId}]: unknown action "${action}"`);
      break;
  }
}

async function handleFinalizationRetry(
  claim: Claim,
  idleMs: number,
  nowMs: number,
  byAgent: Map<string, Agent>,
  workerPoolConfig: WorkerPoolConfig,
): Promise<void> {
  if (!runSignals.isStalled(claim, idleMs, runSignals.thresholds(claim.run_id, nowMs).finalizeRetry, nowMs)) return;
  const lastNudgeAt = runInactiveNudgeAtMs.get(claim.run_id) ?? 0;
  if (nowMs - lastNudgeAt < RUN_INACTIVE_NUDGE_INTERVAL_MS) return;

  const agent = byAgent.get(claim.agent_id);
  if (!agent?.session_handle || agent.status === 'offline') {
    await markFinalizeBlocked(claim, workerPoolConfig, 'live agent session unavailable during finalization retry');
    runInactiveNudgeAtMs.delete(claim.run_id);
    return;
  }
  const adapter = getAdapter(agent.provider);
  // Text scan only, as before the hook bus: this run's permission hook events
  // were already taken by enforceInProgressLifecycle this tick.
  const blockingQuestion = detectBlockingPromptQuestion(adapter, agent.session_handle);
  if (blockingQuestion) {
    recordCoordinatorInputRequest(claim, blockingQuestion, 'provider_interactive_prompt');
    runInactiveNudgeAtMs.delete(claim.run_id);
    return;
  }

  await requestFinalizeRebase(claim, workerPoolConfig, 'finalization retry timed out waiting for worker progress');
  runInactiveNudgeAtMs.set(claim.run_id, nowMs);
}

async function enforceInProgressLifecycle(
  agents: Agent[],
  claims: Claim[],
  attemptsByTask: Map<string, number> = new Map(),
) {
  const nowMs = Date.now();
  const byAgent = new Map(agents.map((a) => [a.agent_id, a]));
  const nudgeWork = [];
  const workerPoolConfig = loadWorkerPoolConfig();

  for (const claim of claims ?? []) {
    if (claim.state !== 'in_progress') {
      runInactiveNudgeAtMs.delete(claim.run_id);
      runNudgeCount.delete(claim.run_id);
      runLastPhase.delete(claim.run_id);
      continue;
    }

    // Permission hook events drained this tick (ingestHookEvents) are taken for
    // every in_progress claim, regardless of finalization or awaiting-input state.
    const hookEvents = runSignals.takePermission(claim.run_id);

    // Liveness: the newest of durable activity events and hook-observed activity.
    const idleMs = runSignals.idleMs(claim, nowMs);
    if (idleMs == null) continue;
    if (claimAwaitingInput(claim)) {
      runInactiveNudgeAtMs.delete(claim.run_id);
      continue;
    }
    if (claim.finalization_state === 'blocked_finalize') {
      runInactiveNudgeAtMs.delete(claim.run_id);
      continue;
    }
    if (claim.finalization_state === 'awaiting_finalize' || claim.finalization_state === 'ready_to_merge') {
      runInactiveNudgeAtMs.delete(claim.run_id);
      continue;
    }
    if (
      claim.finalization_state === 'pr_created'
      || claim.finalization_state === 'pr_review_in_progress'
      || claim.finalization_state === 'pr_merged'
    ) {
      // PR reviewer is doing the work — skip nudging the original worker.
      runInactiveNudgeAtMs.delete(claim.run_id);
      continue;
    }
    if (claim.finalization_state === 'finalize_rebase_requested' || claim.finalization_state === 'finalize_rebase_in_progress') {
      await handleFinalizationRetry(claim, idleMs, nowMs, byAgent, workerPoolConfig);
      continue;
    }

    // ── Remediation policy evaluation ─────────────────────────────────────
    // Collect signals for this claim, evaluate policies, and execute the
    // matched action if any. Falls through to existing time-based escalation
    // when no policy matches.
    const agent = byAgent.get(claim.agent_id);
    const currentPhase = runSignals.currentPhase(claim.run_id).phase;

    // Track worker-reported phase changes across ticks. Inferred transitions
    // (inferRunPhases) count as progress but do not reset the nudge count: a
    // worker cycling tool calls must not escape nudge-count remediation.
    const explicitPhase = runSignals.explicitPhase(claim.run_id);
    const prevPhase = runLastPhase.get(claim.run_id);
    const phaseChanged = explicitPhase != null && prevPhase != null && explicitPhase !== prevPhase;
    if (explicitPhase != null) runLastPhase.set(claim.run_id, explicitPhase);
    if (phaseChanged) runNudgeCount.set(claim.run_id, 0);

    // Remediation requires agent record for signal collection (heartbeat
    // probe, session handle). Skip policy evaluation when agent is missing
    // (e.g. the worker record was already removed) but fall through to the
    // existing time-based escalation which handles agentless claims.
    if (agent) {
      let sessionAlive = false;
      let blockingPrompt: string | null = null;
      if (agent.session_handle && agent.status !== 'offline') {
        const adapter = getAdapter(agent.provider);
        sessionAlive = await adapter.heartbeatProbe(agent.session_handle);
        blockingPrompt = sessionAlive ? detectBlockingPromptQuestion(adapter, agent.session_handle) : null;
      }

      const signals: RemediationSignals = {
        claim,
        agent,
        idleMs,
        phase: currentPhase,
        phaseChanged,
        hookEvents,
        blockingPrompt,
        sessionAlive,
        attemptCount: attemptsByTask.get(claim.task_ref) ?? 0,
        nudgeCount: runNudgeCount.get(claim.run_id) ?? 0,
      };

      const remediationResult = evaluateRemediationPolicies(REMEDIATION_POLICIES, signals);
      if (remediationResult) {
        await executeRemediation(remediationResult.policy.id, remediationResult.policy.action, remediationResult.message, claim, agent);
        continue;
      }
    }
    // ── End remediation policy evaluation ─────────────────────────────────

    // ── Activity-based staleness cascade (tiered inactivity response) ────────
    // Tier 3: Force-fail after WORKER_STALE_FORCE_FAIL_MS of inactivity (2hr default)
    if (idleMs >= WORKER_STALE_FORCE_FAIL_MS) {
      finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
        success: false,
        failureReason: `force-failed after ${Math.round(idleMs / 60000)}min of inactivity`,
        failureCode: 'ERR_STALE_WORKER',
        policy: 'requeue',
      });
      await cleanupRunCapacity(claim.agent_id);
      runInactiveNudgeAtMs.delete(claim.run_id);
      runNudgeCount.delete(claim.run_id);
      runLastPhase.delete(claim.run_id);
      log(`run ${claim.run_id} force-failed after ${Math.round(idleMs / 60000)}min of inactivity; requeued ${claim.task_ref}`);
      continue;
    }

    // Tier 1: Soft alert at WORKER_STALE_SOFT_MS (30min default; HOOK_IDLE_ESCALATE_MS, 10min, with hooks)
    // A tool call still running is not idleness (RunSignals.isStalled, as orc status and MCP read it).
    const thresholds = runSignals.thresholds(claim.run_id, nowMs);
    if (!claim.escalation_notified_at && runSignals.isStalled(claim, idleMs, thresholds.soft, nowMs)) {
      emit({
        event: 'worker_needs_attention',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        run_id: claim.run_id,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        payload: { reason: 'stale', idle_ms: idleMs },
      });
      setEscalationNotified(STATE_DIR, claim.run_id);
      log(`escalated stale worker ${claim.agent_id} for run ${claim.run_id}`);
    }

    // Alive but not progressing: hook activity keeps idleMs low while the run
    // never changes phase, commits, or reports a lifecycle event.
    const progressAt = newestTimestamp(runSignals.progressAt(claim.run_id), claim.started_at);
    const noProgressMs = noProgressEscalationMs({
      progressAt,
      idleMs,
      staleSoftMs: thresholds.soft,
      thresholdMs: RUN_NO_PROGRESS_ESCALATE_MS,
      notifiedFor: runSignals.noProgressNotifiedFor(claim.run_id),
      nowMs,
    });
    if (noProgressMs != null && progressAt) {
      emit({
        event: 'worker_needs_attention',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        run_id: claim.run_id,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        payload: { reason: 'no_progress', idle_ms: idleMs, no_progress_ms: noProgressMs, phase: currentPhase, progress_at: progressAt },
      });
      runSignals.markNoProgressNotified(claim.run_id, progressAt);
      log(`escalated run ${claim.run_id} (${claim.agent_id}): alive but no progress for ${Math.round(noProgressMs / 60000)}min`);
    }

    // Tier 2: Nudge at WORKER_STALE_NUDGE_MS (60min default; HOOK_IDLE_NUDGE_MS, 5min, with hooks)
    if (!runSignals.isStalled(claim, idleMs, thresholds.nudge, nowMs)) continue;
    const lastNudgeAt = runInactiveNudgeAtMs.get(claim.run_id);
    if (lastNudgeAt == null) {
      if (!agent?.session_handle || agent.status === 'offline') continue;

      const claimSnapshot = { ...claim };
      const agentProvider = agent.provider;
      const agentSessionHandle = agent.session_handle;
      nudgeWork.push(async () => {
        const adapter = getAdapter(agentProvider);
        await adapter.send(agentSessionHandle, buildInProgressNudge(claimSnapshot, currentPhase));
        emit({
          event: 'need_input',
          actor_type: 'coordinator',
          actor_id: 'coordinator',
          run_id: claimSnapshot.run_id,
          task_ref: claimSnapshot.task_ref,
          agent_id: claimSnapshot.agent_id,
          payload: { reason: 'run_progress_stale', action: 'nudge_sent', idle_ms: idleMs, phase: currentPhase },
        });
        runInactiveNudgeAtMs.set(claimSnapshot.run_id, nowMs);
        runNudgeCount.set(claimSnapshot.run_id, (runNudgeCount.get(claimSnapshot.run_id) ?? 0) + 1);
        log(`nudged ${claimSnapshot.agent_id} for stale in_progress run ${claimSnapshot.run_id} (phase: ${currentPhase ?? 'unknown'})`);
        return claimSnapshot.agent_id; // returned to caller for same-tick exclusion
      });
      continue;
    }

    if (nowMs - lastNudgeAt < RUN_INACTIVE_NUDGE_INTERVAL_MS) continue;

    if (!agent?.session_handle || agent.status === 'offline') continue;

    const claimSnapshot = { ...claim };
    const agentProvider = agent.provider;
    const agentSessionHandle = agent.session_handle;
    nudgeWork.push(async () => {
      const adapter = getAdapter(agentProvider);
      await adapter.send(agentSessionHandle, buildInProgressNudge(claimSnapshot, currentPhase));
      emit({
        event: 'need_input',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        run_id: claimSnapshot.run_id,
        task_ref: claimSnapshot.task_ref,
        agent_id: claimSnapshot.agent_id,
        payload: { reason: 'run_progress_stale', action: 'nudge_sent', idle_ms: idleMs, phase: currentPhase },
      });
      runInactiveNudgeAtMs.set(claimSnapshot.run_id, nowMs);
      runNudgeCount.set(claimSnapshot.run_id, (runNudgeCount.get(claimSnapshot.run_id) ?? 0) + 1);
      log(`nudged ${claimSnapshot.agent_id} for stale in_progress run ${claimSnapshot.run_id} (phase: ${currentPhase ?? 'unknown'})`);
      return claimSnapshot.agent_id; // returned to caller for same-tick exclusion
    });
  }

  return executeNudgeBatch(nudgeWork);
}

// ── Tick ───────────────────────────────────────────────────────────────────

function reloadTickState(workerPoolConfig: WorkerPoolConfig): { agents: Agent[]; claims: Claim[]; backlog: unknown } {
  const claims = (readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] }).claims ?? [];
  const agents = listCoordinatorAgents(STATE_DIR, workerPoolConfig);
  const backlog = readJson(STATE_DIR, 'backlog.json');
  return { agents, claims, backlog };
}

async function tick() {
  tickCount++;
  log(`tick ${tickCount}`);
  checkCoordinatorPidFile();
  try {
    renewSessionOwnership(STATE_DIR, currentSessionOwnerId(), sessionOwnerTtlMs());
  } catch (error) {
    log(`warning: session ownership renewal failed: ${(error as Error).message}`);
  }

  // 2. Autonomous dispatch.
  if (MODE !== 'autonomous') return;

  const tickInit = initializeTickState();
  if (!tickInit) return;
  const { workerPoolConfig } = tickInit;
  let { agents, claims, tickBacklog } = tickInit;

  reconcileState(STATE_DIR);
  ({ agents, claims, backlog: tickBacklog } = reloadTickState(workerPoolConfig));
  if (await removeStaleWorkers(agents, claims)) {
    ({ agents, claims } = reloadTickState(workerPoolConfig));
  }

  // Drain hook events before lifecycle events; phases are inferred against the
  // claims as they were before this batch, for runs still active after it.
  const hydratedActivityChanged = hydrateRunSignals(claims);
  const hookActivityChanged = ingestHookEvents(claims);
  const claimsBeforeEvents = claims;
  const checkpoint = await processEventCheckpoint(agents, claims, workerPoolConfig);
  ({ agents, claims } = checkpoint);
  const eventActivityChanged = checkpoint.activityChanged;
  inferRunPhases(phaseInferenceClaims(claimsBeforeEvents, claims));
  retainActiveRunSignals([...claimsBeforeEvents, ...claims], hydratedActivityChanged || hookActivityChanged || eventActivityChanged);
  ({ agents, claims } = await expireAndCleanupStaleLeases(agents, claims, workerPoolConfig));
  ({ agents, claims } = await probeActiveWorkerSessions(agents, claims, workerPoolConfig));

  await retireMasterIfDead(agents);
  checkMasterHealth(listCoordinatorAgents(STATE_DIR));
  ({ agents, claims } = reloadTickState(workerPoolConfig));

  const attemptsByTask = buildAttemptCountLookup();

  const nudgedByRunStart = await enforceRunStartLifecycle(agents, claims);
  const nudgedByInProgress = await enforceInProgressLifecycle(agents, claims, attemptsByTask);
  ({ agents, claims } = reloadTickState(workerPoolConfig));
  await processClaimedSessionReadiness(agents, claims);
  ({ agents, claims } = reloadTickState(workerPoolConfig));
  // Agents that received a nudge this tick are excluded from dispatch to avoid
  // sending them a new task envelope in the same tick as an in-flight nudge.
  const nudgedThisTick = new Set([...nudgedByRunStart, ...nudgedByInProgress]);
  await executeDispatchPlan(agents, claims, workerPoolConfig, tickBacklog, nudgedThisTick);

  if (MEMORY_PRUNE_INTERVAL_MS > 0 && Date.now() - lastMemoryPruneAt > MEMORY_PRUNE_INTERVAL_MS) {
    try {
      const expired = pruneExpiredMemories(STATE_DIR);
      const capped = pruneByCapacity(STATE_DIR);
      if (expired + capped > 0) log(`memory pruning: removed ${expired} expired, ${capped} over-capacity`);
      lastMemoryPruneAt = Date.now();
    } catch { /* memory system not initialized */ }
  }
}

function initializeTickState(): {
  agents: Agent[];
  claims: Claim[];
  workerPoolConfig: WorkerPoolConfig;
  tickBacklog: unknown;
} | null {
  try {
    const workerPoolConfig = loadWorkerPoolConfig();
    const preClaims = (readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] }).claims ?? [];
    pruneMissingRunWorktrees(STATE_DIR, preClaims
      .filter((claim) => ['claimed', 'in_progress'].includes(claim.state))
      .map((claim) => claim.run_id));
    const { agents, claims, backlog: tickBacklog } = reloadTickState(workerPoolConfig);
    return { agents, claims, workerPoolConfig, tickBacklog };
  } catch (err) {
    log(`ERROR: failed to load state files: ${(err as Error).message}`);
    return null;
  }
}

async function processEventCheckpoint(
  agents: Agent[],
  claims: Claim[],
  workerPoolConfig: WorkerPoolConfig,
): Promise<{ agents: Agent[]; claims: Claim[]; activityChanged: boolean }> {
  let activityChanged = false;
  try {
    const cursor = getEventCursor();
    const batch = readEventBatch(EVENTS_FILE, cursor, EVENT_BATCH_SIZE);
    for (const row of batch) {
      if (row.event) {
        // A worker note on the event relabels the run's activity snapshot.
        if (runSignals.ingest([row.event]).hookActivity.length > 0) activityChanged = true;
        await processTerminalRunEvents([row.event], workerPoolConfig);
      } else {
        advanceCursor(row.seq);
      }
    }
    ({ agents, claims } = reloadTickState(workerPoolConfig));
  } catch (err) {
    console.error(`[coordinator] ERROR in event processing tick: ${(err as Error)?.message ?? String(err)}`);
    if ((err as Error)?.stack) {
      console.error((err as Error).stack);
    }
  }
  return { agents, claims, activityChanged };
}

async function probeActiveWorkerSessions(
  agents: Agent[],
  claims: Claim[],
  workerPoolConfig: WorkerPoolConfig,
): Promise<{ agents: Agent[]; claims: Claim[] }> {
  const byAgent = new Map(agents.map((a) => [a.agent_id, a]));
  let cleaned = false;

  for (const claim of claims ?? []) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;

    const agent = byAgent.get(claim.agent_id);
    if (!agent?.session_handle || agent.status === 'offline') continue;

    const adapter = getAdapter(agent.provider);
    const alive = await adapter.heartbeatProbe(agent.session_handle);
    if (alive) {
      // Extend lease_expires_at for in_progress runs — PID is confirmed alive,
      // prevent lease expiry during long phases (e.g. >30min implementation)
      // where no phase events fire. Do NOT update last_heartbeat_at — that
      // tracks real worker activity for staleness detection.
      // Skip claimed runs (still in dispatch handshake).
      if (claim.state === 'in_progress') {
        try {
          renewLeaseOnly(STATE_DIR, claim.run_id, { leaseDurationMs: LEASE_CONFIG.default_ms });
        } catch { /* claim may have transitioned — safe to ignore */ }
      }
      continue;
    }

    log(`worker ${claim.agent_id} session process dead — resuming or requeueing run ${claim.run_id} (${claim.task_ref})`);
    await resumeOrRequeue(claim, agent, { reason: 'pty_pid_dead: PTY session exited unexpectedly', code: 'ERR_PTY_DEAD' });
    cleaned = true;
  }

  if (cleaned) {
    ({ agents, claims } = reloadTickState(workerPoolConfig));
  }
  return { agents, claims };
}

async function expireAndCleanupStaleLeases(
  agents: Agent[],
  claims: Claim[],
  workerPoolConfig: WorkerPoolConfig,
): Promise<{ agents: Agent[]; claims: Claim[] }> {
  const expired = expireStaleLeasesDetailed(STATE_DIR);
  if (expired.length > 0) {
    for (const claim of expired) {
      await cleanupRunCapacity(claim.agent_id);
    }
    log(`expired ${expired.length} stale lease(s): ${expired.map((claim) => claim.run_id).join(', ')}`);
    ({ agents, claims } = reloadTickState(workerPoolConfig));
  }
  return { agents, claims };
}

function buildAttemptCountLookup(): Map<string, number> {
  // Build attempt_count lookup from backlog (one read per tick, not per claim)
  const attemptsByTask = new Map<string, number>();
  try {
    const backlog = readBacklog(STATE_DIR);
    for (const feature of backlog.features ?? []) {
      for (const task of feature.tasks ?? []) {
        if (task.attempt_count) attemptsByTask.set(task.ref, task.attempt_count);
      }
    }
  } catch { /* backlog read failure is non-fatal for remediation */ }
  return attemptsByTask;
}

const KNOWN_TASK_TYPES_SET = new Set(TASK_TYPES);
const TASK_PRIORITY_RANK: Record<string, number> = { low: 0, normal: 1, high: 2, critical: 3 };

/**
 * Find the next task eligible for dynamic worker spawning.
 *
 * Unlike agent-bound task selection, this scan does NOT filter on provider —
 * the provider is resolved from the task itself at spawn time. Owner-reserved
 * tasks are excluded since they require a specific pre-known agent identity.
 *
 * Returns `{ ref, required_provider }` for the highest-priority eligible task,
 * or null when no task is ready.
 */
function nextSpawnableTask(
  backlog: unknown,
  { excludeTaskRefs = new Set<string>() }: { excludeTaskRefs?: ReadonlySet<string> } = {},
): { ref: string; required_provider: ProviderName | null } | null {
  const b = backlog as Backlog | null;
  const doneSet = new Set<string>();
  for (const feature of (b?.features ?? [])) {
    for (const task of (feature.tasks ?? [])) {
      if (task.status === 'done' || task.status === 'released') doneSet.add(task.ref);
    }
  }
  const now = new Date();
  const eligible: Array<{ ref: string; required_provider: ProviderName | null; rank: number; index: number }> = [];
  let index = 0;
  for (const feature of (b?.features ?? [])) {
    for (const task of (feature.tasks ?? [])) {
      if (task.status !== 'todo') continue;
      if (task.requeue_eligible_after && new Date(task.requeue_eligible_after) > now) continue;
      if (excludeTaskRefs.has(task.ref)) continue;
      if (task.planning_state && task.planning_state !== 'ready_for_dispatch') continue;
      if (task.task_type && !KNOWN_TASK_TYPES_SET.has(task.task_type)) continue;
      // Owner-reserved tasks require a specific agent identity — skip for generic spawning
      if (task.owner) continue;
      const deps = task.depends_on ?? [];
      if (!deps.every((d) => doneSet.has(d))) continue;
      eligible.push({
        ref: task.ref,
        required_provider: task.required_provider ?? null,
        rank: TASK_PRIORITY_RANK[task.priority ?? ''] ?? TASK_PRIORITY_RANK['normal'],
        index,
      });
      index += 1;
    }
  }
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => b.rank - a.rank || a.index - b.index);
  return { ref: eligible[0].ref, required_provider: eligible[0].required_provider };
}

async function executeDispatchPlan(
  _agents: Agent[],
  claims: Claim[],
  workerPoolConfig: WorkerPoolConfig,
  tickBacklog: unknown,
  _nudgedThisTick: Set<string>,
): Promise<void> {
  // Capacity = configured max minus current active runs
  const activeClaimCount = activeClaimAgents(claims).size;
  const availableCapacity = workerPoolConfig.max_workers - activeClaimCount;
  if (availableCapacity <= 0) return;

  // Find tasks eligible for spawning (up to available capacity slots)
  const reservedTaskRefs = new Set<string>(
    (claims ?? [])
      .filter((c) => ['claimed', 'in_progress'].includes(c.state))
      .map((c) => c.task_ref),
  );
  const dispatchItems: Array<{ ref: string; required_provider: ProviderName | null }> = [];
  for (let i = 0; i < availableCapacity; i++) {
    const next = nextSpawnableTask(tickBacklog, {
      excludeTaskRefs: new Set([
        ...reservedTaskRefs,
        ...dispatchItems.map((d) => d.ref),
      ]),
    });
    if (!next) break;
    dispatchItems.push(next);
  }

  if (dispatchItems.length === 0) return;

  const dispatchResults = await runBounded(dispatchItems.map((item) => async () => {
    const taskRef = item.ref;
    let runId: string | null = null;
    let spawnedAgentId: string | null = null;

    try {
      // Resolve provider from task; fall back to pool default
      const provider = resolveWorkerProvider(item.required_provider, workerPoolConfig);

      // Generate a fresh task-scoped worker name and register + launch it
      const agentId = nextAvailableWorkerName(STATE_DIR);
      spawnedAgentId = agentId;
      const adapter = getAdapter(provider);

      // Claim the task before session work so capacity is held
      const claimed = claimTask(STATE_DIR, taskRef, agentId, {
        leaseDurationMs: LEASE_CONFIG.default_ms,
      });
      runId = claimed.run_id;
      log(`claimed ${taskRef} for ${agentId} (${runId})`);

      const runWorktree = ensureRunWorktree(STATE_DIR, { runId, taskRef, agentId });

      const task = findTask(readBacklog(STATE_DIR), taskRef);
      const spawnResult = await spawnEphemeralWorker(STATE_DIR, {
        agentId,
        provider,
        adapter,
        workingDirectory: runWorktree.worktree_path,
        repoRoot: ORC_PACKAGE_ROOT,
        runId,
        taskRef,
        taskModel: task?.model ?? null,
        executionMode: workerPoolConfig.execution_mode,
        sandboxNetwork: workerPoolConfig.sandbox_network,
        runtime: workerPoolConfig.runtime,
        emit,
      });

      if (!spawnResult.ok) {
        // Session launch failed; agent was cleaned up inside spawnEphemeralWorker
        spawnedAgentId = null;
        const failReason = spawnResult.reason ?? 'worker session could not be launched in assigned worktree';
        finishRun(STATE_DIR, runId, agentId, {
          success: false,
          failureReason: `session_start_failed: ${failReason}`,
          failureCode: 'ERR_SESSION_START_FAILED',
          policy: 'requeue',
        });
        return;
      }

      const agent = spawnResult.agent!;
      if (isAgentSessionReady(agent)) {
        try {
          await sendTaskEnvelope(agent, taskRef, runId);
        } catch (err) {
          // sendTaskEnvelope called finishRun + cleanupRunCapacity internally on failure.
          // cleanupRunCapacity will remove the ephemeral agent.
          spawnedAgentId = null;
          if (!(err instanceof InjectionScanError)) {
            runId = null;
          }
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof InjectionScanError) {
        emit({
          event: 'task_dispatch_blocked',
          actor_type: 'coordinator',
          actor_id: 'coordinator',
          task_ref: taskRef,
          payload: { reason: 'injection_scan', findings: err.findings },
        });
        if (runId && spawnedAgentId) {
          finishRun(STATE_DIR, runId, spawnedAgentId, {
            success: false,
            failureReason: 'injection_scan_blocked',
            failureCode: 'ERR_INJECTION_SCAN',
            policy: 'block',
          });
          await cleanupRunCapacity(spawnedAgentId);
        } else if (spawnedAgentId) {
          // Claim failed before runId was set — remove the agent directly
          removeAgent(STATE_DIR, spawnedAgentId);
        }
        return;
      }
      if (runId && spawnedAgentId) {
        finishRun(STATE_DIR, runId, spawnedAgentId, {
          success: false,
          failureReason: `dispatch_error: ${(err as Error).message}`,
          failureCode: 'ERR_DISPATCH_FAILURE',
          policy: 'requeue',
        });
        await cleanupRunCapacity(spawnedAgentId);
      } else if (spawnedAgentId) {
        removeAgent(STATE_DIR, spawnedAgentId);
      }
      throw new Error(`dispatching ${taskRef}: ${(err as Error).message}`);
    }
  }));

  for (const result of dispatchResults) {
    if (result.status === 'rejected') {
      log(`ERROR ${(result.reason as Error)?.message ?? 'unknown dispatch error'}`);
    }
  }
}

export function buildTaskEnvelope(taskRef: string, runId: string, agentId: string) {
  const claim = (readJson(STATE_DIR, 'claims.json') as { claims: Claim[] }).claims.find((entry) => entry.run_id === runId);
  const snapshot = claim?.task_spec_snapshot;
  if (snapshot) verifyRunTaskSnapshot(snapshot);
  const runWorktree = getRunWorktree(STATE_DIR, runId);
  // A project SQLite revision has no repository file; the pinned snapshot is the spec.
  const taskSpecWorktreePath = snapshot?.snapshot_path ?? '(task spec not found)';
  return renderTemplate('task-envelope-v2.txt', {
    task_ref: taskRef,
    run_id: runId,
    agent_id: agentId,
    task_spec_path: snapshot?.snapshot_path ?? taskSpecWorktreePath,
    task_spec_worktree_path: taskSpecWorktreePath,
    task_spec_sha256: snapshot?.sha256 ?? '(not pinned)',
    task_spec_revision_status: snapshot ? taskSnapshotStatus(snapshot, STATE_DIR) : 'unknown',
    assigned_worktree: runWorktree?.worktree_path ?? join(WORKTREES_DIR, runId),
    orc_bin: resolveOrcBinSh(ORC_PACKAGE_ROOT),
  });
}

function buildRunStartNudge(claim: Claim) {
  return [
    `RUN_NUDGE`,
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    `Missing required run_started acknowledgement.`,
    `Call this command immediately via your Bash tool:`,
    `${resolveOrcBinSh(ORC_PACKAGE_ROOT)} run-start --run-id=${claim.run_id} --agent-id=${claim.agent_id}`,
    `RUN_NUDGE_END`,
  ].join('\n');
}

/** Sent instead of the bootstrap to a resumed session: the conversation already holds the task. */
function buildResumeNudge(claim: Claim, sessionId: string, generation: number) {
  const { phase } = runSignals.currentPhase(claim.run_id);
  return [
    'SESSION_RESUMED',
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    `session_id: ${sessionId}`,
    `generation: ${generation}`,
    `phase: ${phase ?? 'unknown'}`,
    `last_progress_at: ${claim.last_heartbeat_at ?? claim.started_at ?? 'unknown'}`,
    'Your session process exited unexpectedly and was resumed in place: same run, claim, worktree and agent id.',
    'Check git status for work in progress, then continue the task from where you left off.',
    'Lifecycle commands and their flags are unchanged.',
    'SESSION_RESUMED_END',
  ].join('\n');
}

const PHASE_NUDGE_MESSAGES: Record<string, string> = {
  explore: 'Have you started implementing? Move to Phase 2 when exploration is complete.',
  implement: 'Are tests passing? Run npm test and move to Phase 3 when ready.',
  review: 'Have reviewers responded? Check orc review-read and address findings.',
  complete: 'Run orc run-work-complete to hand off to the coordinator.',
  finalize: 'Waiting for coordinator merge. If requested, perform the finalize rebase.',
};

function buildInProgressNudge(claim: Claim, phase: string | null = null) {
  const phaseHint = phase && PHASE_NUDGE_MESSAGES[phase]
    ? `Current phase: ${phase}. ${PHASE_NUDGE_MESSAGES[phase]}`
    : 'No phase signal received. Have you started exploring the task spec?';
  return [
    `RUN_NUDGE`,
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    `No recent activity detected.`,
    phaseHint,
    `Emit the next phase signal via your Bash tool to continue the run.`,
    `RUN_NUDGE_END`,
  ].join('\n');
}

function buildFinalizeWaitNotice(claim: Claim) {
  return [
    'FINALIZE_WAIT',
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    'Task work is complete. Stay idle in this session while the coordinator attempts the trusted final merge.',
    'Do not merge or clean up the branch yourself.',
    'Wait for either a FINALIZE_REBASE request or FINALIZE_SUCCESS notice.',
    'FINALIZE_WAIT_END',
  ].join('\n');
}

function buildFinalizeRebaseRequest(claim: Claim, reason: string) {
  return [
    'FINALIZE_REBASE',
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    `retry_count: ${claim.finalization_retry_count ?? 0}`,
    `reason: ${reason}`,
    'The coordinator could not finalize your branch on the latest main.',
    'In this same worktree, first report the rebase handoff with:',
    `orc progress --event=finalize_rebase_started --run-id=${claim.run_id} --agent-id=${claim.agent_id}`,
    'Then run `git rebase main`, resolve conflicts if needed, rerun the required verification, and report completion again with:',
    `orc run-work-complete --run-id=${claim.run_id} --agent-id=${claim.agent_id}`,
    'Do not merge or delete the worktree yourself.',
    'FINALIZE_REBASE_END',
  ].join('\n');
}

function buildFinalizeSuccessNotice(claim: Claim, branch: string) {
  return [
    'FINALIZE_SUCCESS',
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    `branch: ${branch}`,
    'The coordinator merged your branch successfully.',
    'You do not need to take any further action in this session.',
    'FINALIZE_SUCCESS_END',
  ].join('\n');
}

export async function processTerminalRunEvents(events: ProcessableEvent[], workerPoolConfig: WorkerPoolConfig = loadWorkerPoolConfig()) {
  for (const event of events) {
    const normalizedEventId = eventIdentity(event);
    const seq = typeof event.seq === 'number' ? event.seq : 0;
    const eventTs = coerceTs(event.ts);

    // The SQLite cursor is authoritative. During migration, preserve the old
    // processed-ID set until the cursor has crossed the legacy checkpoint.
    getEventCursor();
    if (seq > 0 && (seq <= readEventOffset(STATE_DIR)
      || (seq <= legacyLastSeq && !wasEventOffsetReset(STATE_DIR) && legacyProcessedIds!.has(normalizedEventId)))) {
      if (seq > 0) advanceCursor(seq);
      continue;
    }

    // ── Route state transitions through the lifecycle reducer ─────────────
    // The reducer decides the correct state transition; the coordinator applies
    // it and handles side effects that are independent of claim state.
    const nowIso = new Date().toISOString();
    const runId = (event as { run_id?: string }).run_id;
    const agentId = (event as { agent_id?: string }).agent_id ?? '';

    if (event.event === 'reported_for_duty') {
      const agent = getAgent(STATE_DIR, agentId);
      const sessionToken = typeof event.payload?.session_token === 'string' ? event.payload.session_token : null;
      if (agent && sessionToken && agent.session_token === sessionToken) {
        updateAgentRuntime(STATE_DIR, agentId, {
          session_ready_at: eventTs,
          last_heartbeat_at: eventTs,
        });
        recordAgentActivity(STATE_DIR, agentId, { at: eventTs });
      }
      if (seq > 0) advanceCursor(seq);
      continue;
    }

    const claim = runId ? getClaim(runId) : null;
    const action = reduceLifecycleEvent(
      event as Parameters<typeof reduceLifecycleEvent>[0],
      claim,
      nowIso,
      LEASE_CONFIG,
    );

    // ── Apply reducer action ───────────────────────────────────────────────

    if (action.type === 'set_input_state') {
      try {
        setRunInputState(STATE_DIR, runId!, agentId, {
          inputState: 'awaiting_input',
          requestedAt: action.requestedAt,
        });
      } catch {
        // Ignore races with terminal events or cleaned-up claims.
      }
    }

    if (action.type === 'start_run') {
      startRun(STATE_DIR, runId!, agentId, { emitEvent: false, at: action.at });
      recordAgentActivity(STATE_DIR, agentId, { at: action.at });
    }

    if (action.type === 'heartbeat' && (!claim?.last_heartbeat_at
      || Date.parse(claim.last_heartbeat_at) < Date.parse(action.at))) {
      try {
        heartbeat(STATE_DIR, runId!, agentId, { emitEvent: false, at: action.at, leaseDurationMs: action.leaseDurationMs });
        recordAgentActivity(STATE_DIR, agentId, { at: action.at });
      } catch {
        // Ignore agent_id mismatches (e.g. review_submitted from a reviewer
        // sub-agent whose agent_id doesn't match the claim owner) and races
        // with terminal events or expired leases.
      }
    }

    if (action.type === 'advance_finalization') {
      setRunFinalizationState(STATE_DIR, runId!, agentId, {
        finalizationState: action.state,
        retryCountDelta: action.retryCountDelta,
        blockedReason: action.blockedReason,
      });
      if (action.extendLeaseMs !== null) {
        // Use wall-clock now (not the event timestamp) so the worker always
        // gets the full lease window regardless of event processing lag.
        try {
          heartbeat(STATE_DIR, runId!, agentId, {
            emitEvent: false,
            leaseDurationMs: action.extendLeaseMs,
          });
        } catch (err) {
          log(`warning: failed to extend lease on ${event.event} for ${runId}: ${(err as Error).message}`);
        }
      }
      if (event.event === 'finalize_rebase_started') {
        // Record activity using the authoritative event timestamp.
        const floorTs = claim?.last_heartbeat_at ?? claim?.started_at ?? claim?.claimed_at;
        const stateTs = authoritativeStateTs(eventTs, floorTs);
        recordAgentActivity(STATE_DIR, agentId, { at: stateTs });
      }
    }

    if (action.type === 'clear_input_state') {
      try {
        setRunInputState(STATE_DIR, runId!, agentId, { inputState: null });
      } catch {
        // Ignore races with terminal events or cleaned-up claims.
      }
    }

    if (action.type === 'finish_run') {
      // ── Worker run_failed during PR review: set pr_failed and requeue ──
      const latestClaimForFinish = runId ? getClaim(runId) : null;
      if (
        !action.success
        && latestClaimForFinish?.finalization_state === 'pr_review_in_progress'
        && latestClaimForFinish.agent_id === agentId
      ) {
        try {
          setRunFinalizationState(STATE_DIR, runId!, latestClaimForFinish.agent_id, { finalizationState: 'pr_failed' });
        } catch { /* ignore races */ }
        try {
          await sendCoordinatorMessage(
            'master',
            `PR review failed for ${latestClaimForFinish.task_ref} (run ${runId}): ${action.failureReason ?? 'worker failed'}`,
          );
        } catch { /* best-effort notification */ }
        finishRun(STATE_DIR, runId!, latestClaimForFinish.agent_id, {
          success: false,
          failureReason: `pr_review_failed: ${action.failureReason ?? 'unknown'}`,
          failureCode: action.failureCode,
          policy: 'requeue',
          emitEvent: false,
          at: action.at,
        });
      } else {
        finishRun(STATE_DIR, runId!, agentId, {
          success: action.success,
          failureReason: action.failureReason,
          failureCode: action.failureCode,
          policy: action.policy,
          emitEvent: false,
          at: action.at,
        });
      }
    }

    // ── Unconditional side effects for terminal run events ────────────────
    // Cleanup happens regardless of current claim state so that a re-delivered
    // terminal event still triggers capacity release and worktree cleanup.
    if (event.event === 'run_finished' || event.event === 'run_failed') {
      if (!hasOtherActiveClaim(agentId, runId!)) {
        await cleanupRunCapacity(agentId);
      }
      deleteRunWorktree(STATE_DIR, runId!);

      const taskRef = claim?.task_ref ?? (event as { task_ref?: string }).task_ref ?? '';
      if (event.event === 'run_finished') {
        try {
          storeDrawer(STATE_DIR, {
            wing: wingFromTaskRef(taskRef),
            hall: 'outcomes', room: 'task-completions',
            content: `Task ${taskRef} completed by ${agentId} (run ${runId})`,
            importance: 5, sourceType: 'event',
            ...(runId ? { sourceRef: runId } : {}),
          });
        } catch { /* memory system not initialized — silently skip */ }
      } else {
        const reason = typeof (event as { payload?: { reason?: unknown } }).payload?.reason === 'string'
          ? (event as { payload: { reason: string } }).payload.reason
          : 'unknown';
        try {
          storeDrawer(STATE_DIR, {
            wing: wingFromTaskRef(taskRef),
            hall: 'errors', room: 'run-failures',
            content: `Task ${taskRef} failed (run ${runId}): ${reason}`,
            importance: 8, sourceType: 'event',
            ...(runId ? { sourceRef: runId } : {}),
          });
        } catch { /* memory system not initialized — silently skip */ }
      }
    }

    // ── Unconditional finalization trigger for work/merge events ──────────
    // finalizeRun is called whenever the claim is in_progress, whether or not
    // the finalization state was advanced above (handles idempotent re-delivery).
    if (event.event === 'work_complete' || event.event === 'ready_to_merge') {
      const latestClaim = runId ? getClaim(runId) : null;
      // The initial work_complete can be replayed after PR review has started.
      // The durable event sequence identifies that handoff independently of
      // worker clock skew; only the later reviewer handoff may merge the PR.
      const stalePrHandoff = event.event === 'work_complete'
        && latestClaim?.finalization_state === 'pr_review_in_progress'
        && seq > 0
        && latestClaim.pr_initial_work_complete_seq === seq;
      if (latestClaim && latestClaim.state === 'in_progress' && !stalePrHandoff) {
        await finalizeRun(latestClaim, workerPoolConfig, seq);
      }
    }

    if (seq > 0) advanceCursor(seq);
  }
}

// ── Coordinator presence lock ──────────────────────────────────────────────
// Prevents two coordinator processes from running against the same state dir.

const COORDINATOR_PID_FILE = join(STATE_DIR, 'coordinator.pid');

function acquireCoordinatorLock() {
  const lockFlags = constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY;
  const record: CoordinatorPidRecord = { pid: process.pid, started_at: new Date().toISOString(), process_start: readProcessStart(process.pid) };
  const payload = JSON.stringify(record);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fd = openSync(COORDINATOR_PID_FILE, lockFlags);
      try {
        writeSync(fd, payload, null, 'utf8');
      } finally {
        closeSync(fd);
      }
      coordinatorLock = record;
      lastPidFileCheck = 'present';
      // A live coordinator whose pid lock went missing is still recorded in control.json.
      const endpointPid = controlEndpointCoordinatorPid(STATE_DIR);
      if (endpointPid !== null && endpointPid !== process.pid) {
        releaseCoordinatorLock();
        console.error(`[coordinator] ERROR: another coordinator is already running (PID ${endpointPid}, recorded in control.json; coordinator.pid was missing). Stop it with orc kill-all. Aborting.`);
        process.exit(1);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;

      let other: unknown;
      try { other = JSON.parse(readFileSync(COORDINATOR_PID_FILE, 'utf8')) as unknown; } catch { /* stale/corrupt */ }
      const otherPid = (other as Record<string, unknown> | undefined)?.pid;
      if (isCoordinatorLockHeld(other as CoordinatorLock | undefined)) {
        console.error(`[coordinator] ERROR: another coordinator is already running (PID ${String(otherPid)}). Aborting.`);
        process.exit(1);
      }
      if (Number.isInteger(otherPid) && (otherPid as number) > 0) {
        log(`stale coordinator.pid removed (PID ${String(otherPid)} is dead or no longer the coordinator)`);
      } else {
        log('stale coordinator.pid removed (missing or invalid pid metadata)');
      }
      try {
        unlinkSync(COORDINATOR_PID_FILE);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException)?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }

  throw new Error(`[coordinator] ERROR: failed to acquire coordinator pid lock: ${COORDINATOR_PID_FILE}`);
}

// Only a lock this process acquired, and that still names it, is removed: a
// coordinator module that never acquired the lock (a test calling doShutdown)
// must not delete the pid file of the coordinator that did.
function releaseCoordinatorLock() {
  const own = coordinatorLock;
  if (!own) return;
  coordinatorLock = null;
  try {
    if (releaseCoordinatorPidFile(COORDINATOR_PID_FILE, own) === 'foreign') {
      log('coordinator.pid names another process; left in place');
    }
  } catch (error) {
    log(`warning: could not release coordinator.pid: ${(error as Error).message}`);
  }
}

/** Restores this coordinator's pid lock when it has disappeared; leaves another process's lock alone. */
function checkCoordinatorPidFile() {
  if (!coordinatorLock) return;
  let check: PidFileCheck;
  try {
    check = ensureCoordinatorPidFile(COORDINATOR_PID_FILE, coordinatorLock);
  } catch (error) {
    log(`warning: coordinator.pid check failed: ${(error as Error).message}`);
    return;
  }
  if (check === 'recreated') {
    log(`coordinator.pid was missing; re-created it (PID ${coordinatorLock.pid})`);
  } else if (check !== lastPidFileCheck) {
    if (check === 'foreign_live') console.error(`[coordinator] ERROR: ${COORDINATOR_PID_FILE} names another running coordinator; left in place`);
    else if (check === 'foreign_stale') log(`warning: ${COORDINATOR_PID_FILE} names another process that is not running; left in place`);
  }
  lastPidFileCheck = check === 'recreated' ? 'present' : check;
}

// ── Session supervision ────────────────────────────────────────────────────

function sessionOwnerTtlMs(): number {
  return Math.max(SESSION_OWNER_TTL_MS, INTERVAL_MS * 3);
}

/** Adapters without inspectSession are judged by probe and ownership alone. */
async function inspectAgentSession(agent: Agent, session: SupervisedSession): Promise<SessionInspection | null> {
  const adapter = getAdapter(agent.provider);
  const inspected = await adapterInspectSession(adapter, agent.session_handle!);
  if (inspected) return inspected;
  const alive = await adapter.heartbeatProbe(agent.session_handle!);
  return {
    transport: agent.session_handle!.startsWith('tmux:') ? 'tmux' : 'legacy',
    alive, writable: alive && adapterOwnsSession(adapter, agent.session_handle!) === true,
    pid: session.process_pid, processStart: session.process_start,
  };
}

/** Adopt live sessions from a previous coordinator instead of killing them. */
async function reconcileSupervisedSessions() {
  try {
    const results = await reconcileSessions(STATE_DIR, {
      owner: currentSessionOwnerId(),
      ownerTtlMs: sessionOwnerTtlMs(),
      agents: listCoordinatorAgents(STATE_DIR),
      inspect: inspectAgentSession,
    });
    for (const result of results) {
      log(`session ${result.session_id} (${result.agent_id}): ${result.previous_state} -> ${result.state} [${result.outcome}]${result.reason ? ` — ${result.reason}` : ''}`);
    }
  } catch (error) {
    log(`warning: session reconciliation failed: ${(error as Error).message}`);
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────

export async function main() {
  try {
    assertProjectMode();
  } catch (error) {
    console.error(`[coordinator] ERROR: ${(error as Error).message}. Aborting.`);
    process.exit(1);
  }
  // Project workers report their lifecycle only through the control API (Task 229).
  if (process.env.ORC_CONTROL_API === 'off') {
    console.error('[coordinator] ERROR: ORC_CONTROL_API=off is not supported for a registered project: its workers report lifecycle through the control API. Aborting.');
    process.exit(1);
  }
  acquireCoordinatorLock();
  // Workers resolve the project from its state directory without the global registry.
  writeProjectDescriptor(ACTIVE_PROJECT!);
  getEventCursor();
  process.on('exit', releaseCoordinatorLock);
  function shutdown() {
    doShutdown().catch((err) => { console.error(err); process.exit(1); });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason) => {
    console.error('[coordinator] unhandled rejection:', reason);
    try {
      emit({ event: 'coordinator_stopped', actor_type: 'coordinator', actor_id: 'coordinator', reason: `unhandled_rejection: ${String(reason).slice(0, 500)}` });
    } catch { /* best-effort */ }
    doShutdown().catch(() => { /* already shutting down */ });
  });
  process.on('uncaughtException', (err) => {
    console.error('[coordinator] uncaught exception:', err);
    try {
      emit({ event: 'coordinator_stopped', actor_type: 'coordinator', actor_id: 'coordinator', reason: `uncaught_exception: ${String(err.message).slice(0, 500)}` });
    } catch { /* best-effort */ }
    doShutdown().catch(() => { /* already shutting down */ });
  });
  log(`starting — mode=${MODE} interval=${INTERVAL_MS}ms run_start_timeout=${RUN_START_TIMEOUT_MS}ms worker_stale_soft=${WORKER_STALE_SOFT_MS}ms worker_stale_nudge=${WORKER_STALE_NUDGE_MS}ms worker_stale_force_fail=${WORKER_STALE_FORCE_FAIL_MS}ms hook_idle_nudge=${HOOK_IDLE_NUDGE_MS}ms hook_idle_escalate=${HOOK_IDLE_ESCALATE_MS}ms run_inactive_nudge=${RUN_INACTIVE_NUDGE_MS}ms run_inactive_nudge_interval=${RUN_INACTIVE_NUDGE_INTERVAL_MS}ms`);
  for (const file of ['backlog.json', 'agents.json', 'claims.json', 'events.db']) {
    if (!existsSync(join(STATE_DIR, file))) {
      console.error(`[coordinator] ERROR: required state file missing: ${file}`);
      process.exit(1);
    }
  }
  // Sweep stale .tmp files left by any interrupted atomicWriteJson call.
  try {
    const staleTemps = readdirSync(STATE_DIR).filter((f) => f.endsWith('.tmp'));
    for (const f of staleTemps) {
      try { unlinkSync(join(STATE_DIR, f)); log(`cleaned stale temp file: ${f}`); }
      catch { /* already gone — fine */ }
    }
  } catch { /* STATE_DIR not readable — file-existence check above would have caught this */ }
  // Hook-event files of sessions that crashed before their adapter's stop() ran.
  const orphanedHookFiles = gcOrphanedHookFiles(STATE_DIR, listCoordinatorAgents(STATE_DIR).map((agent) => agent.agent_id));
  if (orphanedHookFiles.length > 0) log(`removed ${orphanedHookFiles.length} orphaned hook-event file(s)`);

  try {
    const expired = pruneExpiredMemories(STATE_DIR);
    const capped = pruneByCapacity(STATE_DIR);
    if (expired + capped > 0) log(`memory pruning: removed ${expired} expired, ${capped} over-capacity`);
  } catch { /* memory system not initialized */ }

  try {
    pruneOrphanRunTaskSnapshots(STATE_DIR);
  } catch (error) {
    log(`run task snapshot pruning skipped: ${(error as Error).message}`);
  }

  reconcileState(STATE_DIR);
  const tmux = checkTmux();
  log(tmux.ok ? `worker sessions run in ${tmux.version}` : `warning: ${tmux.problem}; no worker session can start`);
  await reconcileSupervisedSessions();
  // Project workers cannot report without the control API.
  try {
    controlServer = await startControlServer(STATE_DIR, { commands: getCommandDispatcher() });
    log(`control API listening on ${controlServer.endpoint.path}`);
  } catch (error) {
    console.error(`[coordinator] ERROR: control API unavailable: ${(error as Error).message}; project workers could not report. Aborting.`);
    process.exit(1);
  }
  // Sandboxed project workers that cannot reach the control socket would fail every run (task 230).
  const sandboxSocket = checkSandboxControlSocket({ project: true });
  if (sandboxSocket.warning) log(`warning: ${sandboxSocket.warning}`);
  // Sweeps queued commands and reconciles in-flight ones whose session or run ended.
  getCommandDispatcher().start();
  emit({ event: 'coordinator_started', actor_type: 'coordinator', actor_id: 'coordinator', payload: { mode: MODE } });

  // First tick immediately.
  await tick();

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  timerHandle = setInterval(async () => {
    if (!running || ticking) return;
    ticking = true;
    try { await tick(); } finally { ticking = false; }
  }, INTERVAL_MS);
}

export async function doShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;

  log('shutting down — waiting for current tick to complete...');
  running = false;
  // Stop accepting control requests before the databases close.
  try { void controlServer?.close(); } catch { /* best-effort */ }
  commandDispatcher?.stop();
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }

  if (ticking) {
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (!ticking) {
          clearInterval(poll);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, 30_000);
    });
  }

  // Stop all managed worker sessions
  try {
    const agents = listCoordinatorAgents(STATE_DIR);
    for (const agent of agents) {
      if (!agent.session_handle) continue;
      try {
        const adapter = getAdapter(agent.provider);
        if (adapterSurvivesCoordinatorExit(adapter, agent.session_handle)) {
          log(`left session running for ${agent.agent_id}; the next coordinator will adopt it`);
        } else if (adapterOwnsSession(adapter, agent.session_handle)) {
          await adapter.stop(agent.session_handle);
          log(`stopped session for ${agent.agent_id}`);
        }
      } catch (err) {
        log(`warning: failed to stop session for ${agent.agent_id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log(`warning: session cleanup failed: ${(err as Error).message}`);
  }
  // With no orc tmux session left, the private server is gone but its socket file is not.
  try { removeDeadTmuxSocket(); } catch { /* best-effort */ }

  emit({ event: 'coordinator_stopped', actor_type: 'coordinator', actor_id: 'coordinator', payload: {} });
  try { closeAllDatabases(); } catch { /* best-effort */ }
  releaseCoordinatorLock();
  log('shutdown complete.');
  process.exit(0);
}

export { tick, getAdapter as getCoordinatorAdapter, getCommandDispatcher as getCoordinatorCommandDispatcher };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
