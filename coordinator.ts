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
import type { Agent } from './types/agents.ts';
import type { Claim } from './types/claims.ts';
import type { WorkerPoolConfig } from './lib/providers.ts';
import type { ActorType, OrcEvent, OrcEventInput } from './types/events.ts';

// Distributive Omit — preserves discriminated union across all members
type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;
// Allow processTerminalRunEvents to accept events without seq/actor fields (e.g. in tests)
type ProcessableEvent = DistributiveOmit<OrcEvent, 'seq' | 'actor_type' | 'actor_id' | 'event_id'>
  & { seq?: number; actor_type?: ActorType; actor_id?: string; event_id?: string };
import { expireStaleLeasesDetailed, claimTask, finishRun, heartbeat, setRunFinalizationState, setRunInputState, setRunSessionStartRetryState, startRun } from './lib/claimManager.ts';
import { getAgent, listCoordinatorAgents, reconcileManagedWorkerSlots, updateAgentRuntime } from './lib/agentRegistry.ts';
import { createAdapter } from './adapters/index.ts';
import { adapterDetectInputBlock, adapterOwnsSession } from './adapters/interface.ts';
import { appendSequencedEvent, eventIdentity, readEvents } from './lib/eventLog.ts';
import { latestRunActivityMap, runIdleMs } from './lib/runActivity.ts';
import { renderTemplate } from './lib/templateRender.ts';
import { selectDispatchableAgents, buildDispatchPlan } from './lib/dispatchPlanner.ts';
import { nextEligibleTask } from './lib/taskScheduler.ts';
import { STATE_DIR, EVENTS_FILE, WORKTREES_DIR, BACKLOG_DOCS_DIR, ORCHESTRATOR_CONFIG_FILE } from './lib/paths.ts';
import { flag, intFlag } from './lib/args.ts';
import { reconcileState } from './lib/reconcile.ts';
import { clearNotifications } from './lib/masterNotifyQueue.ts';
import { loadWorkerPoolConfig } from './lib/providers.ts';
import { cleanupRunWorktree, deleteRunWorktree, ensureRunWorktree, getRunWorktree, pruneMissingRunWorktrees } from './lib/runWorktree.ts';
import { resolveRepoRoot } from './lib/repoRoot.ts';
import { InjectionScanError, readTaskSpecSections } from './lib/taskSpecReader.ts';
import { syncBacklogFromSpecs } from './lib/backlogSync.ts';
import { clearWorkerSessionRuntime, launchWorkerSession, markWorkerOffline } from './lib/workerRuntime.ts';
import { advanceEventCheckpoint, pruneEventCheckpoint, readEventCheckpoint, seedEventCheckpointFromEvents, writeEventCheckpoint } from './lib/eventCheckpoint.ts';
import { recordAgentActivity } from './lib/agentActivity.ts';
import { fileURLToPath } from 'node:url';
import { findTask, readBacklog, readJson } from './lib/stateReader.ts';
import { closeSync, constants, existsSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { FINALIZE_LEASE_MS } from './lib/constants.ts';
import { reduceLifecycleEvent } from './lib/workerLifecycleReducer.ts';

// ── Adapter singleton cache ────────────────────────────────────────────────
// One adapter instance per provider — preserves in-memory session state across
// multiple coordinator functions (ensureSessionReady, nudge, dispatch).

const adapterInstances = new Map<string, ReturnType<typeof createAdapter>>();
function getAdapter(provider: string): ReturnType<typeof createAdapter> {
  if (!adapterInstances.has(provider)) {
    adapterInstances.set(provider, createAdapter(provider));
  }
  return adapterInstances.get(provider)!;
}

// ── CLI args ───────────────────────────────────────────────────────────────

const INTERVAL_MS = intFlag('interval-ms', 30000);
const MODE        = flag('mode') ?? 'autonomous';
const RUN_START_TIMEOUT_MS = intFlag('run-start-timeout-ms', 600000);
const RUN_INACTIVE_TIMEOUT_MS = intFlag('run-inactive-timeout-ms', 1800000);
const RUN_START_NUDGE_MS = Math.floor(RUN_START_TIMEOUT_MS * 0.1);
const RUN_START_NUDGE_INTERVAL_MS = Math.floor(RUN_START_TIMEOUT_MS * 0.2);
const RUN_INACTIVE_NUDGE_MS = intFlag('run-inactive-nudge-ms', 600000);           // 10 min default
const RUN_INACTIVE_NUDGE_INTERVAL_MS = intFlag('run-inactive-nudge-interval-ms', 300000); // 5 min default
const NOTIFICATION_AUTO_EXPIRE_MS = (() => {
  const DEFAULT_MS = 24 * 60 * 60 * 1000;
  try {
    if (existsSync(ORCHESTRATOR_CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(ORCHESTRATOR_CONFIG_FILE, 'utf8')) as Record<string, unknown>;
      const v = Number(cfg.notification_auto_expire_ms);
      if (Number.isFinite(v) && v > 0) return v;
    }
  } catch { /* use default */ }
  return DEFAULT_MS;
})();
const CONCURRENCY_LIMIT = 8;
const AGENT_DEAD_TTL_MS = 2 * 60 * 60 * 1000;
const AGENT_HEARTBEAT_REFRESH_MS = 60_000;
const MANAGED_SESSION_START_MAX_ATTEMPTS = 3;
const MANAGED_SESSION_START_RETRY_DELAY_MS = 30_000;
const GIT_OP_TIMEOUT_MS = 30_000; // abort coordinator git ops after 30s to prevent tick blockage
const REPO_ROOT = resolveRepoRoot();

// ── State ──────────────────────────────────────────────────────────────────

let running = true;
let tickCount = 0;
let ticking = false;
let timerHandle: ReturnType<typeof setInterval> | null = null;
let shutdownStarted = false;
let coordinatorLockReleased = false;
let latestActivityByRun: Map<string, string> = new Map();
const runStartNudgeAtMs = new Map<string, number>();
const runInactiveNudgeAtMs = new Map<string, number>();
// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`[coordinator] ${new Date().toISOString()} ${msg}`); }

function initializeEventCheckpoint() {
  const checkpointPath = join(STATE_DIR, 'event-checkpoint.json');
  if (existsSync(checkpointPath)) {
    return readEventCheckpoint(STATE_DIR);
  }

  const allEvents = readEvents(EVENTS_FILE);
  const seededCheckpoint = seedEventCheckpointFromEvents(
    allEvents.map((event) => eventIdentity(event)),
    allEvents.at(-1)?.seq ?? 0,
  );
  return writeEventCheckpoint(STATE_DIR, seededCheckpoint);
}

let eventCheckpoint = initializeEventCheckpoint();

function emit(event: Omit<OrcEventInput, 'ts'> | Record<string, unknown>) {
  appendSequencedEvent(STATE_DIR, { ts: new Date().toISOString(), ...event } as OrcEventInput);
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

function refreshAgentHeartbeat(agent: Agent, nowIso: string, { force = false } = {}) {
  const nowMs = new Date(nowIso).getTime();
  const lastMs = typeof agent.last_heartbeat_at === 'string'
    ? new Date(agent.last_heartbeat_at).getTime()
    : NaN;
  const shouldRefresh = force || !Number.isFinite(lastMs) || (nowMs - lastMs) >= AGENT_HEARTBEAT_REFRESH_MS;
  if (!shouldRefresh) return;

  updateAgentRuntime(STATE_DIR, agent.agent_id, {
    status: 'running',
    last_heartbeat_at: nowIso,
  });
  agent.status = 'running';
  agent.last_heartbeat_at = nowIso;
}

function readTaskContext(stateDir: string, taskRef: string) {
  try {
    const backlog = readBacklog(stateDir);
    const task = findTask(backlog, taskRef);
    if (task) {
      const feature = backlog.features.find((e) => e.tasks.some((t) => t.ref === taskRef)) ?? null;
      return { feature, task };
    }
  } catch {
    return null;
  }
  return null;
}

function isManagedSlot(agentId: string | null | undefined, workerPoolConfig: WorkerPoolConfig) {
  const match = /^orc-(\d+)$/.exec(agentId ?? '');
  if (!match) return false;
  const slotNumber = Number(match[1]);
  return Number.isInteger(slotNumber) && slotNumber >= 1 && slotNumber <= workerPoolConfig.max_workers;
}

async function ensureSessionReady(agent: Agent, launchConfig: Record<string, unknown> | null = null) {
  const adapter = getAdapter(agent.provider);

  if (agent.session_handle) {
    const alive = await adapter.heartbeatProbe(agent.session_handle);
    if (!alive) {
      updateAgentRuntime(STATE_DIR, agent.agent_id, {
        status: 'idle',   // session dead; coordinator will recreate on next tick
        session_handle: null,
        provider_ref: null,
        last_status_change_at: new Date().toISOString(),
      });
      agent.status = 'idle';
      agent.session_handle = null;
      agent.provider_ref = null;
      log(`worker ${agent.agent_id} session unreachable; cleared stale handle for recreation`);
      return { ok: false, reason: 'session unreachable' };
    }
    if (!adapterOwnsSession(adapter, agent.session_handle)) {
      try {
        await adapter.stop(agent.session_handle);
      } catch {
        // Best-effort cross-process teardown. Runtime is still cleared below.
      }
      updateAgentRuntime(STATE_DIR, agent.agent_id, {
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        last_status_change_at: new Date().toISOString(),
      });
      agent.status = 'idle';
      agent.session_handle = null;
      agent.provider_ref = null;
      log(`worker ${agent.agent_id} session is alive but not owned by this coordinator; cleared handle for recreation`);
      return { ok: false, reason: 'session not owned by this coordinator' };
    }
    refreshAgentHeartbeat(agent, new Date().toISOString());
    return { ok: true };
  }

  if (!launchConfig) {
    return { ok: false, reason: 'no launch config provided' };
  }

  const result = await launchWorkerSession(STATE_DIR, agent, {
    adapter,
    workingDirectory: launchConfig.working_directory as string | null | undefined,
    repoRoot: REPO_ROOT,
    runId: (launchConfig.run_id ?? null) as string | null,
    taskRef: (launchConfig.task_ref ?? null) as string | null,
    retryable: launchConfig.retryable === true,
    emit,
  });
  if (!result.ok) {
    console.error(`[coordinator] Failed to start session for '${agent.agent_id}': ${result.reason}`);
  }
  return { ok: result.ok, reason: result.reason };
}

async function sendTaskEnvelope(agent: Agent, taskRef: string, runId: string, workerPoolConfig: WorkerPoolConfig) {
  const adapter = getAdapter(agent.provider);
  const envelope = buildTaskEnvelope(taskRef, runId, agent.agent_id);
  try {
    await adapter.send(
      agent.session_handle!,
      envelope,
    );
    log(`dispatched ${taskRef} to ${agent.agent_id}`);
    try {
      startRun(STATE_DIR, runId, agent.agent_id, {
        actorType: 'coordinator',
        actorId: 'coordinator',
      });
    } catch {
      // Worker already called orc run-start before us — idempotent, safe to ignore
    }
    return true;
  } catch (err) {
    finishRun(STATE_DIR, runId, agent.agent_id, {
      success: false,
      failureReason: `dispatch_error: ${(err as Error).message}`,
      failureCode: 'ERR_DISPATCH_FAILURE',
      policy: 'requeue',
    });
    const alive = await adapter.heartbeatProbe(agent.session_handle!);
    await cleanupRunCapacity(agent.agent_id, workerPoolConfig, {
      offlineReason: alive ? null : 'dispatch_failed_session_unreachable',
    });
    throw err;
  }
}

async function processManagedSessionStartRetries(
  agents: Agent[],
  claims: Claim[],
  workerPoolConfig: WorkerPoolConfig,
) {
  const nowMs = Date.now();
  const agentsById = new Map(agents.map((agent) => [agent.agent_id, agent]));
  for (const claim of claims) {
    const retryCount = claim.session_start_retry_count ?? 0;
    const nextRetryAt = claim.session_start_retry_next_at ?? null;
    if (claim.state !== 'claimed' || retryCount <= 0 || nextRetryAt == null) continue;

    const agent = agentsById.get(claim.agent_id);
    if (!agent || !isManagedSlot(claim.agent_id, workerPoolConfig)) {
      continue;
    }
    if (nowMs < new Date(nextRetryAt).getTime()) continue;

    const ready = await ensureSessionReady(agent, {
      working_directory: getRunWorktree(STATE_DIR, claim.run_id)?.worktree_path ?? null,
      run_id: claim.run_id,
      task_ref: claim.task_ref,
      retryable: true,
    });
    if (ready.ok && agent.session_handle && agent.status !== 'offline') {
      setRunSessionStartRetryState(STATE_DIR, claim.run_id, claim.agent_id, {
        retryCount: 0,
      });
      try {
        await sendTaskEnvelope(agent, claim.task_ref, claim.run_id, workerPoolConfig);
      } catch (err) {
        log(`ERROR dispatching ${claim.task_ref} to ${agent.agent_id}: ${(err as Error).message}`);
      }
      continue;
    }

    const nextFailedAttempts = retryCount + 1;
    if (nextFailedAttempts >= MANAGED_SESSION_START_MAX_ATTEMPTS) {
      const failReason = ready.reason ?? 'worker session could not be launched in assigned worktree';
      emit({
        event: 'session_start_failed',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        run_id: claim.run_id,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
        payload: {
          reason: failReason,
          code: 'ERR_SESSION_START_FAILED',
          working_directory: getRunWorktree(STATE_DIR, claim.run_id)?.worktree_path ?? undefined,
        },
      });
      finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
        success: false,
        failureReason: `session_start_failed: ${failReason}`,
        failureCode: 'ERR_SESSION_START_FAILED',
        policy: 'requeue',
      });
      if (agent.status !== 'offline') {
        await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
      }
      console.error(`[coordinator] Failed to start session for '${claim.agent_id}': bounded retries exhausted — ${failReason}`);
      continue;
    }

    setRunSessionStartRetryState(STATE_DIR, claim.run_id, claim.agent_id, {
      retryCount: nextFailedAttempts,
      nextRetryAt: new Date(nowMs + MANAGED_SESSION_START_RETRY_DELAY_MS).toISOString(),
      lastError: ready.reason ?? claim.session_start_last_error ?? 'worker session could not be launched in assigned worktree',
    });
  }
}

function claimAwaitingInput(claim: Claim) {
  return claim?.input_state === 'awaiting_input';
}

function detectBlockingPromptQuestion(adapter: ReturnType<typeof createAdapter>, sessionHandle: string) {
  const prompt = adapterDetectInputBlock(adapter, sessionHandle);
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
  const result = spawnSync('git', ['merge-base', '--is-ancestor', 'main', branch], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_OP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
}

function mergeTaskBranch(branch: string, taskRef: string) {
  const result = spawnSync('git', ['merge', branch, '--no-ff', '-m', `task(${taskRef}): merge worktree`], {
    cwd: REPO_ROOT,
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
  await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
  log(`run ${claim.run_id} blocked during finalization: ${reason}`);
  return true;
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

  // Extend the lease before attempting to send so the claim stays alive even
  // if the send fails and the coordinator must retry on the next tick.
  try {
    heartbeat(STATE_DIR, updatedClaim.run_id, updatedClaim.agent_id, {
      emitEvent: false,
      leaseDurationMs: FINALIZE_LEASE_MS,
    });
  } catch (error) {
    log(`warning: failed to extend lease during finalize rebase request for ${updatedClaim.run_id}: ${(error as Error).message}`);
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

async function finalizeRun(claim: Claim, workerPoolConfig: WorkerPoolConfig) {
  const runWorktree = getRunWorktree(STATE_DIR, claim.run_id);
  if (!runWorktree?.branch) {
    return markFinalizeBlocked(claim, workerPoolConfig, 'missing run worktree metadata for finalization');
  }

  await sendCoordinatorMessage(claim.agent_id, buildFinalizeWaitNotice(claim));

  let mainIncluded = false;
  try {
    mainIncluded = branchContainsMain(runWorktree.branch);
  } catch (error) {
    return markFinalizeBlocked(claim, workerPoolConfig, (error as Error).message);
  }

  if (!mainIncluded) {
    return requestFinalizeRebase(claim, workerPoolConfig, 'branch is not rebased onto latest main');
  }

  try {
    mergeTaskBranch(runWorktree.branch, claim.task_ref);
  } catch (error) {
    return requestFinalizeRebase(claim, workerPoolConfig, (error as Error).message);
  }

  finishRun(STATE_DIR, claim.run_id, claim.agent_id, { success: true });
  await sendCoordinatorMessage(claim.agent_id, buildFinalizeSuccessNotice(claim, runWorktree.branch));
  await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
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

function recordCoordinatorInputRequest(claim: Claim, question: string, reason: string) {
  const nowIso = new Date().toISOString();
  try {
    heartbeat(STATE_DIR, claim.run_id, claim.agent_id, { emitEvent: false });
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

async function releaseAgentCapacity(agent: Agent | null | undefined) {
  if (!agent) return;
  await stopAgentSession(agent);
  clearWorkerSessionRuntime(STATE_DIR, agent, { status: 'idle' });
}

async function cleanupRunCapacity(agentId: string, workerPoolConfig: WorkerPoolConfig, { offlineReason = null as string | null } = {}) {
  const agent = getAgent(STATE_DIR, agentId);
  if (!agent) return;
  await stopAgentSession(agent);
  if (offlineReason && !isManagedSlot(agent.agent_id, workerPoolConfig)) {
    markWorkerOffline(STATE_DIR, agent, { emit, reason: offlineReason });
    return;
  }
  if (agent.status === 'offline' && !isManagedSlot(agent.agent_id, workerPoolConfig)) {
    clearWorkerSessionRuntime(STATE_DIR, agent, { status: 'offline' });
    return;
  }
  clearWorkerSessionRuntime(STATE_DIR, agent, { status: 'idle' });
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

async function ensureSessionPoolReady(agents: Agent[], _workerPoolConfig: WorkerPoolConfig) {
  const candidates = (agents ?? []).filter(
    (agent) => agent?.role !== 'master'
      && agent.status !== 'offline'
      && agent.status !== 'dead'
      && agent.session_handle,
  );
  const results = await runBounded(candidates.map((agent) => async () => {
    try {
      await ensureSessionReady(agent);
    } catch (error) {
      throw new Error(`ensuring session for ${agent.agent_id}: ${(error as Error).message}`);
    }
  }));
  for (const result of results) {
    if (result.status === 'rejected') {
      log(`warning: failed to ensure worker session: ${(result.reason as Error)?.message ?? 'unknown error'}`);
    }
  }
}

function markStaleAgentsDead(agents: Agent[], claims: Claim[], nowMs = Date.now()) {
  const busyAgents = activeClaimAgents(claims);
  for (const agent of agents ?? []) {
    if (!agent?.agent_id) continue;
    if (agent.role === 'master') continue;
    if (agent.status === 'dead') continue;
    if (busyAgents.has(agent.agent_id)) continue;
    if (typeof agent.last_heartbeat_at !== 'string') continue;

    const lastHeartbeatMs = new Date(agent.last_heartbeat_at).getTime();
    if (!Number.isFinite(lastHeartbeatMs)) continue;

    const elapsedMs = nowMs - lastHeartbeatMs;
    if (elapsedMs < AGENT_DEAD_TTL_MS) continue;

    updateAgentRuntime(STATE_DIR, agent.agent_id, {
      status: 'dead',
      session_handle: null,
      provider_ref: null,
      last_status_change_at: new Date(nowMs).toISOString(),
    });
    emit({
      event: 'agent_marked_dead',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      agent_id: agent.agent_id,
      payload: { elapsed_ms: elapsedMs },
    });
    agent.status = 'dead';
    agent.session_handle = null;
    agent.provider_ref = null;
  }
}

async function enforceRunStartLifecycle(agents: Agent[], claims: Claim[]) {
  const nowMs = Date.now();
  const byAgent = new Map(agents.map((a) => [a.agent_id, a]));
  const nudgeWork = [];
  const workerPoolConfig = loadWorkerPoolConfig();

  for (const claim of claims ?? []) {
    if (claim.state !== 'claimed') {
      runStartNudgeAtMs.delete(claim.run_id);
      continue;
    }
    if (claimAwaitingInput(claim)) {
      runStartNudgeAtMs.delete(claim.run_id);
      continue;
    }

    const ageMs = nowMs - new Date(claim.claimed_at).getTime();
    if (Number.isNaN(ageMs)) continue;

    if (ageMs >= RUN_START_TIMEOUT_MS) {
      finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
        success: false,
        failureReason: 'run_started timeout: worker did not acknowledge start in time',
        failureCode: 'ERR_RUN_START_TIMEOUT',
        policy: 'requeue',
      });
      await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
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
    const blockingQuestion = detectBlockingPromptQuestion(adapter, agent.session_handle);
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

  const results = await runBounded(nudgeWork);
  const nudgedAgentIds = new Set<string>();
  for (const result of results) {
    if (result.status === 'rejected') {
      log(`warning: failed to send run-start nudge: ${(result.reason as Error)?.message ?? 'unknown error'}`);
    } else if (result.value) {
      nudgedAgentIds.add(result.value as string);
    }
  }
  return nudgedAgentIds;
}

async function enforceInProgressLifecycle(agents: Agent[], claims: Claim[], activityByRun: Map<string, string>) {
  const nowMs = Date.now();
  const byAgent = new Map(agents.map((a) => [a.agent_id, a]));
  const nudgeWork = [];
  const workerPoolConfig = loadWorkerPoolConfig();

  for (const claim of claims ?? []) {
    if (claim.state !== 'in_progress') {
      runInactiveNudgeAtMs.delete(claim.run_id);
      continue;
    }

    const idleMs = runIdleMs(claim, activityByRun.get(claim.run_id), nowMs);
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
    if (claim.finalization_state === 'finalize_rebase_requested' || claim.finalization_state === 'finalize_rebase_in_progress') {
      if (idleMs < RUN_INACTIVE_NUDGE_MS) continue;
      const lastNudgeAt = runInactiveNudgeAtMs.get(claim.run_id) ?? 0;
      if (nowMs - lastNudgeAt < RUN_INACTIVE_NUDGE_INTERVAL_MS) continue;

      const agent = byAgent.get(claim.agent_id);
      if (!agent?.session_handle || agent.status === 'offline') {
        await markFinalizeBlocked(claim, workerPoolConfig, 'live agent session unavailable during finalization retry');
        runInactiveNudgeAtMs.delete(claim.run_id);
        continue;
      }
      const adapter = getAdapter(agent.provider);
      const blockingQuestion = detectBlockingPromptQuestion(adapter, agent.session_handle);
      if (blockingQuestion) {
        recordCoordinatorInputRequest(claim, blockingQuestion, 'provider_interactive_prompt');
        runInactiveNudgeAtMs.delete(claim.run_id);
        continue;
      }

      await requestFinalizeRebase(claim, workerPoolConfig, 'finalization retry timed out waiting for worker progress');
      runInactiveNudgeAtMs.set(claim.run_id, nowMs);
      continue;
    }

    if (idleMs >= RUN_INACTIVE_TIMEOUT_MS) {
      finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
        success: false,
        failureReason: `run inactivity timeout: no progress for ${Math.round(idleMs / 1000)}s`,
        failureCode: 'ERR_RUN_INACTIVITY_TIMEOUT',
        policy: 'requeue',
      });
      await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
      runInactiveNudgeAtMs.delete(claim.run_id);
      log(`run ${claim.run_id} timed out for inactivity; requeued ${claim.task_ref}`);
      continue;
    }

    if (idleMs < RUN_INACTIVE_NUDGE_MS) continue;
    const lastNudgeAt = runInactiveNudgeAtMs.get(claim.run_id) ?? 0;
    if (nowMs - lastNudgeAt < RUN_INACTIVE_NUDGE_INTERVAL_MS) continue;

    const agent = byAgent.get(claim.agent_id);
    if (!agent?.session_handle || agent.status === 'offline') continue;
    const adapter = getAdapter(agent.provider);
    const blockingQuestion = detectBlockingPromptQuestion(adapter, agent.session_handle);
    if (blockingQuestion) {
      recordCoordinatorInputRequest(claim, blockingQuestion, 'provider_interactive_prompt');
      runInactiveNudgeAtMs.delete(claim.run_id);
      continue;
    }

    const claimSnapshot = { ...claim };
    const agentProvider = agent.provider;
    const agentSessionHandle = agent.session_handle;
    nudgeWork.push(async () => {
      const adapter = getAdapter(agentProvider);
      await adapter.send(agentSessionHandle, buildInProgressNudge(claimSnapshot));
      emit({
        event: 'need_input',
        actor_type: 'coordinator',
        actor_id: 'coordinator',
        run_id: claimSnapshot.run_id,
        task_ref: claimSnapshot.task_ref,
        agent_id: claimSnapshot.agent_id,
        payload: { reason: 'run_progress_stale', action: 'nudge_sent', idle_ms: idleMs },
      });
      runInactiveNudgeAtMs.set(claimSnapshot.run_id, nowMs);
      log(`nudged ${claimSnapshot.agent_id} for stale in_progress run ${claimSnapshot.run_id}`);
      return claimSnapshot.agent_id; // returned to caller for same-tick exclusion
    });
  }

  const results = await runBounded(nudgeWork);
  const nudgedAgentIds = new Set<string>();
  for (const result of results) {
    if (result.status === 'rejected') {
      log(`warning: failed to send progress nudge: ${(result.reason as Error)?.message ?? 'unknown error'}`);
    } else if (result.value) {
      nudgedAgentIds.add(result.value as string);
    }
  }
  return nudgedAgentIds;
}

// ── Tick ───────────────────────────────────────────────────────────────────

async function tick() {
  tickCount++;
  log(`tick ${tickCount}`);

  // 2. Autonomous dispatch.
  if (MODE !== 'autonomous') return;

  let tickBacklog: unknown;
  let tickAgents: { version: string; agents: Agent[] } = { version: '1', agents: [] };
  let tickClaims: { claims?: Claim[] } = {};
  let workerPoolConfig: WorkerPoolConfig;
  try {
    workerPoolConfig = loadWorkerPoolConfig();
    reconcileManagedWorkerSlots(STATE_DIR, workerPoolConfig);
    tickBacklog = readJson(STATE_DIR, 'backlog.json');
    tickClaims = readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] };
    pruneMissingRunWorktrees(STATE_DIR, (tickClaims.claims ?? [])
      .filter((claim) => ['claimed', 'in_progress'].includes(claim.state))
      .map((claim) => claim.run_id));
    tickAgents = { version: '1', agents: listCoordinatorAgents(STATE_DIR, workerPoolConfig) };
  } catch (err) {
    log(`ERROR: failed to load state files: ${(err as Error).message}`);
    return;
  }

  let agents = tickAgents.agents ?? [];
  let claims = tickClaims.claims ?? [];
  reconcileState(STATE_DIR);
  tickBacklog = readJson(STATE_DIR, 'backlog.json');
  tickClaims = readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] };
  tickAgents = { version: '1', agents: listCoordinatorAgents(STATE_DIR, workerPoolConfig) };
  agents = tickAgents.agents ?? [];
  claims = tickClaims.claims ?? [];
  markStaleAgentsDead(agents, claims);

  try {
    // TODO(perf): latestRunActivityMap currently scans all events.
    // A future task should window this to recent events only.
    const allEvents = readEvents(EVENTS_FILE);
    const allEventIds = allEvents.map((event) => eventIdentity(event));
    const prunedCheckpoint = pruneEventCheckpoint(eventCheckpoint, allEventIds);
    if (prunedCheckpoint.processed_event_ids.length !== eventCheckpoint.processed_event_ids.length) {
      eventCheckpoint = writeEventCheckpoint(STATE_DIR, prunedCheckpoint);
    }
    const processedEventIds = new Set(eventCheckpoint.processed_event_ids);
    const newEvents = allEvents.filter((event) => !processedEventIds.has(eventIdentity(event)));
    latestActivityByRun = latestRunActivityMap(allEvents);
    if (newEvents.length > 0) {
      await processTerminalRunEvents(newEvents, workerPoolConfig);
    }
    tickClaims = readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] };
    tickAgents = { version: '1', agents: listCoordinatorAgents(STATE_DIR, workerPoolConfig) };
    agents = tickAgents.agents ?? [];
    claims = tickClaims.claims ?? [];
  } catch (err) {
    console.error(`[coordinator] ERROR in event processing tick: ${(err as Error)?.message ?? String(err)}`);
    if ((err as Error)?.stack) {
      console.error((err as Error).stack);
    }
    latestActivityByRun = new Map();
  }

  const expired = expireStaleLeasesDetailed(STATE_DIR);
  if (expired.length > 0) {
    for (const claim of expired) {
      await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
    }
    log(`expired ${expired.length} stale lease(s): ${expired.map((claim) => claim.run_id).join(', ')}`);
    tickClaims = readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] };
    tickAgents = { version: '1', agents: listCoordinatorAgents(STATE_DIR, workerPoolConfig) };
    agents = tickAgents.agents ?? [];
    claims = tickClaims.claims ?? [];
  }

  checkMasterHealth(agents);
  await processManagedSessionStartRetries(agents, claims, workerPoolConfig);
  tickClaims = readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] };
  tickAgents = { version: '1', agents: listCoordinatorAgents(STATE_DIR, workerPoolConfig) };
  agents = tickAgents.agents ?? [];
  claims = tickClaims.claims ?? [];

  const nudgedByRunStart = await enforceRunStartLifecycle(agents, claims);
  const nudgedByInProgress = await enforceInProgressLifecycle(agents, claims, latestActivityByRun);
  tickClaims = readJson(STATE_DIR, 'claims.json') as { claims?: Claim[] };
  tickAgents = { version: '1', agents: listCoordinatorAgents(STATE_DIR, workerPoolConfig) };
  agents = tickAgents.agents ?? [];
  claims = tickClaims.claims ?? [];
  await ensureSessionPoolReady(agents, workerPoolConfig);
  // Agents that received a nudge this tick are excluded from dispatch to avoid
  // sending them a new task envelope in the same tick as an in-flight nudge.
  const nudgedThisTick = new Set([...nudgedByRunStart, ...nudgedByInProgress]);

  const busyAgents = activeClaimAgents(claims);
  const availableAgents = selectDispatchableAgents(agents, { busyAgents });
  const dispatchableAgents = availableAgents.filter((a) => !nudgedThisTick.has(a.agent_id));
  const dispatchPlan = buildDispatchPlan(dispatchableAgents, (agent) =>
    nextEligibleTask(STATE_DIR, agent.agent_id, { backlog: tickBacklog, agents: tickAgents }),
  );
  const dispatchResults = await runBounded(dispatchPlan.map((item) => async () => {
    const agent = item.agent;
    const taskRef = item.task_ref;
    let runId = null;

    try {
      if (agent.status === 'dead') return;

      const claimed = claimTask(STATE_DIR, taskRef, agent.agent_id);
      runId = claimed.run_id;
      log(`claimed ${taskRef} for ${agent.agent_id} (${runId})`);
      const runWorktree = ensureRunWorktree(STATE_DIR, {
        runId,
        taskRef,
        agentId: agent.agent_id,
      });
      if (agent.session_handle) {
        await releaseAgentCapacity(agent);
      }
      const ready = await ensureSessionReady(agent, {
        working_directory: runWorktree.worktree_path,
        run_id: runId,
        task_ref: taskRef,
        retryable: isManagedSlot(agent.agent_id, workerPoolConfig),
      });
      if (!ready.ok || !agent.session_handle || agent.status === 'offline') {
        if (isManagedSlot(agent.agent_id, workerPoolConfig) && agent.status !== 'offline') {
          setRunSessionStartRetryState(STATE_DIR, runId, agent.agent_id, {
            retryCount: 1,
            nextRetryAt: new Date(Date.now() + MANAGED_SESSION_START_RETRY_DELAY_MS).toISOString(),
            lastError: ready.reason ?? 'worker session could not be launched in assigned worktree',
          });
          return;
        }
        const failReason = ready.reason ?? 'worker session could not be launched in assigned worktree';
        finishRun(STATE_DIR, runId, agent.agent_id, {
          success: false,
          failureReason: `session_start_failed: ${failReason}`,
          failureCode: 'ERR_SESSION_START_FAILED',
          policy: 'requeue',
        });
        if (agent.status !== 'offline') {
          await cleanupRunCapacity(agent.agent_id, workerPoolConfig);
        }
        return;
      }

      try {
        await sendTaskEnvelope(agent, taskRef, runId, workerPoolConfig);
      } catch (err) {
        // InjectionScanError: finishRun not yet called — preserve runId for outer catch
        if (!(err instanceof InjectionScanError)) {
          runId = null;
        }
        throw err;
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
        if (runId) {
          finishRun(STATE_DIR, runId, agent.agent_id, {
            success: false,
            failureReason: 'injection_scan_blocked',
            failureCode: 'ERR_INJECTION_SCAN',
            policy: 'block',
          });
        }
        return;
      }
      if (runId) {
        finishRun(STATE_DIR, runId, agent.agent_id, {
          success: false,
          failureReason: `dispatch_error: ${(err as Error).message}`,
          failureCode: 'ERR_DISPATCH_FAILURE',
          policy: 'requeue',
        });
      }
      throw new Error(`dispatching ${taskRef} to ${agent.agent_id}: ${(err as Error).message}`);
    }
  }));

  for (const result of dispatchResults) {
    if (result.status === 'rejected') {
      log(`ERROR ${(result.reason as Error)?.message ?? 'unknown dispatch error'}`);
    }
  }
}

export function buildTaskEnvelope(taskRef: string, runId: string, agentId: string) {
  const ctx = readTaskContext(STATE_DIR, taskRef);
  const taskSpec = readTaskSpecSections(taskRef);
  const criteria = ctx?.task?.acceptance_criteria ?? [];
  const description = ctx?.task?.description ?? '';
  const taskType = ctx?.task?.task_type ?? 'implementation';
  const planningState = ctx?.task?.planning_state ?? 'ready_for_dispatch';
  const acceptanceCriteriaLines = criteria.length > 0
    ? criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '  (none listed)';
  const fallback = '  (not provided)';
  const runWorktree = getRunWorktree(STATE_DIR, runId);
  const taskContract = {
    contract_version: '1',
    task_ref: taskRef,
    run_id: runId,
    assigned_agent_id: agentId,
    task_type: taskType,
    planning_state: planningState,
    delegated_by: ctx?.task?.delegated_by ?? null,
    title: ctx?.task?.title ?? '(untitled task)',
    feature: ctx?.feature?.ref ?? '(unknown)',
    description,
    acceptance_criteria: criteria,
  };
  return renderTemplate('task-envelope-v2.txt', {
    task_ref: taskRef,
    run_id: runId,
    title: ctx?.task?.title ?? '(untitled task)',
    feature: ctx?.feature?.ref ?? '(unknown)',
    description,
    agent_id: agentId,
    acceptance_criteria_lines: acceptanceCriteriaLines,
    current_state: taskSpec.current_state || fallback,
    desired_state: taskSpec.desired_state || fallback,
    start_here: taskSpec.start_here || fallback,
    files_to_change: taskSpec.files_to_change || fallback,
    avoid_reading: taskSpec.avoid_reading || fallback,
    implementation_notes: taskSpec.implementation_notes || fallback,
    verification: taskSpec.verification || fallback,
    task_spec_path: taskSpec.source_path ?? '(task spec not found)',
    assigned_worktree: runWorktree?.worktree_path ?? join(WORKTREES_DIR, runId),
    task_contract_json: JSON.stringify(taskContract, null, 2),
  });
}

function buildRunStartNudge(claim: Claim) {
  return [
    `RUN_NUDGE`,
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    `Missing required run_started acknowledgement.`,
    `Call this command immediately via your Bash tool:`,
    `orc run-start --run-id=${claim.run_id} --agent-id=${claim.agent_id}`,
    `RUN_NUDGE_END`,
  ].join('\n');
}

function buildInProgressNudge(claim: Claim) {
  return [
    `RUN_NUDGE`,
    `run_id: ${claim.run_id}`,
    `task_ref: ${claim.task_ref}`,
    `Run is in_progress but no recent heartbeat was received.`,
    `Call this command via your Bash tool to keep the run active:`,
    `orc run-heartbeat --run-id=${claim.run_id} --agent-id=${claim.agent_id}`,
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

    // ── Duplicate / already-processed events ──────────────────────────────
    if (eventCheckpoint.processed_event_ids.includes(normalizedEventId)) {
      if (seq > 0) {
        eventCheckpoint = writeEventCheckpoint(STATE_DIR, advanceEventCheckpoint(eventCheckpoint, normalizedEventId, seq, eventTs));
      }
      continue;
    }

    // ── Route state transitions through the lifecycle reducer ─────────────
    // The reducer decides the correct state transition; the coordinator applies
    // it and handles side effects that are independent of claim state.
    const nowIso = new Date().toISOString();
    const runId = (event as { run_id?: string }).run_id;
    const agentId = (event as { agent_id?: string }).agent_id ?? '';
    const claim = runId ? getClaim(runId) : null;
    const action = reduceLifecycleEvent(
      event as Parameters<typeof reduceLifecycleEvent>[0],
      claim,
      nowIso,
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

    if (action.type === 'heartbeat') {
      heartbeat(STATE_DIR, runId!, agentId, { emitEvent: false, at: action.at, leaseDurationMs: action.leaseDurationMs });
      recordAgentActivity(STATE_DIR, agentId, { at: action.at });
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
      finishRun(STATE_DIR, runId!, agentId, {
        success: action.success,
        failureReason: action.failureReason,
        failureCode: action.failureCode,
        policy: action.policy,
        emitEvent: false,
        at: action.at,
      });
    }

    // ── Unconditional side effects for terminal run events ────────────────
    // Cleanup happens regardless of current claim state so that a re-delivered
    // terminal event still triggers capacity release and worktree cleanup.
    if (event.event === 'run_finished' || event.event === 'run_failed') {
      if (!hasOtherActiveClaim(agentId, runId!)) {
        await cleanupRunCapacity(agentId, workerPoolConfig);
      }
      deleteRunWorktree(STATE_DIR, runId!);
    }

    // ── Unconditional finalization trigger for work/merge events ──────────
    // finalizeRun is called whenever the claim is in_progress, whether or not
    // the finalization state was advanced above (handles idempotent re-delivery).
    if (event.event === 'work_complete' || event.event === 'ready_to_merge') {
      const latestClaim = runId ? getClaim(runId) : null;
      if (latestClaim && latestClaim.state === 'in_progress') {
        await finalizeRun(latestClaim, workerPoolConfig);
      }
    }

    if (seq > 0) {
      eventCheckpoint = writeEventCheckpoint(STATE_DIR, advanceEventCheckpoint(eventCheckpoint, normalizedEventId, seq, eventTs));
    }
  }
}

// ── Coordinator presence lock ──────────────────────────────────────────────
// Prevents two coordinator processes from running against the same state dir.

const COORDINATOR_PID_FILE = join(STATE_DIR, 'coordinator.pid');

function isCoordinatorPidAlive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function acquireCoordinatorLock() {
  const lockFlags = constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY;
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(COORDINATOR_PID_FILE, lockFlags);
      try {
        writeSync(fd, payload, null, 'utf8');
      } finally {
        closeSync(fd);
      }
      coordinatorLockReleased = false;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;

      let other: unknown;
      try { other = JSON.parse(readFileSync(COORDINATOR_PID_FILE, 'utf8')) as unknown; } catch { /* stale/corrupt */ }
      const otherPid = (other as Record<string, unknown> | undefined)?.pid;
      if (Number.isInteger(otherPid) && (otherPid as number) > 0 && isCoordinatorPidAlive(otherPid as number)) {
        console.error(`[coordinator] ERROR: another coordinator is already running (PID ${String(otherPid)}). Aborting.`);
        process.exit(1);
      }
      if (Number.isInteger(otherPid) && (otherPid as number) > 0) {
        log(`stale coordinator.pid removed (PID ${String(otherPid)} is dead)`);
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

function releaseCoordinatorLock() {
  if (coordinatorLockReleased) return;
  coordinatorLockReleased = true;
  try { unlinkSync(COORDINATOR_PID_FILE); } catch { /* already gone */ }
}

// ── Main loop ──────────────────────────────────────────────────────────────

export async function main() {
  acquireCoordinatorLock();
  process.on('exit', releaseCoordinatorLock);
  function shutdown() {
    doShutdown().catch((err) => { console.error(err); process.exit(1); });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log(`starting — mode=${MODE} interval=${INTERVAL_MS}ms run_start_timeout=${RUN_START_TIMEOUT_MS}ms run_inactive_timeout=${RUN_INACTIVE_TIMEOUT_MS}ms run_inactive_nudge=${RUN_INACTIVE_NUDGE_MS}ms run_inactive_nudge_interval=${RUN_INACTIVE_NUDGE_INTERVAL_MS}ms`);
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

  try {
    syncBacklogFromSpecs(STATE_DIR, BACKLOG_DOCS_DIR);
  } catch (error) {
    log(`backlog sync from specs skipped: ${(error as Error).message}`);
  }

  reconcileState(STATE_DIR);
  clearNotifications(STATE_DIR, NOTIFICATION_AUTO_EXPIRE_MS);
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

  emit({ event: 'coordinator_stopped', actor_type: 'coordinator', actor_id: 'coordinator', payload: {} });
  releaseCoordinatorLock();
  log('shutdown complete.');
  process.exit(0);
}

export { tick };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
