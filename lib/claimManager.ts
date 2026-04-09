import { join } from 'node:path';
import { withLock, lockPath } from './lock.ts';
import { DEFAULT_LEASE_MS } from './constants.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { readJson, findTask } from './stateReader.ts';
import type { ClaimsState } from '../types/claims.ts';
import type { Backlog } from '../types/backlog.ts';
import type { ActorType, OrcEventInput } from '../types/events.ts';
import { requeueBackoffMs as _requeueBackoffMs } from './claimLeaseManager.ts';

const MAX_ATTEMPTS = 5; // auto-block a task after this many dispatch+fail cycles

export { requeueBackoffMs } from './claimLeaseManager.ts';
export { expireStaleLeases, expireStaleLeasesDetailed } from './claimLeaseManager.ts';
export { markTaskEnvelopeSent, setRunFinalizationState, setRunInputState, setRunSessionStartRetryState, setEscalationNotified } from './claimStateManager.ts';

// ── Helpers ────────────────────────────────────────────────────────────────

function assertValidTimestamp(ts: string, label: string): void {
  if (!Number.isFinite(new Date(ts).getTime())) {
    throw new Error(`Invalid ${label} timestamp: ${ts}`);
  }
}

function resetClaimVolatileFields(claim: import('../types/claims.ts').Claim): void {
  claim.input_state = null;
  claim.input_requested_at = null;
  claim.session_start_retry_count = 0;
  claim.session_start_retry_next_at = null;
  claim.session_start_last_error = null;
}

function makeRunId(): string {
  const ts   = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 6);
  return `run-${ts}-${rand}`;
}

function emit(stateDir: string, event: OrcEventInput): void {
  appendSequencedEvent(stateDir, event, {
    fsyncPolicy: 'always',
    lockAlreadyHeld: true,
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Atomically claim a task for an agent. Returns { run_id, lease_expires_at }.
 * Throws if task not found, not in 'todo' state, or already claimed.
 */
export function claimTask(
  stateDir: string,
  taskRef: string,
  agentId: string,
  { leaseDurationMs = DEFAULT_LEASE_MS }: { leaseDurationMs?: number } = {},
): { run_id: string; lease_expires_at: string } {
  return withLock(lockPath(stateDir), () => {
    const backlog = readJson(stateDir, 'backlog.json') as Backlog;
    const claims  = readJson(stateDir, 'claims.json') as ClaimsState;

    const task = findTask(backlog, taskRef);
    if (!task) throw new Error(`Task not found: ${taskRef}`);
    if (task.status !== 'todo') throw new Error(`Task not claimable (status: ${task.status}): ${taskRef}`);
    if (task.owner && task.owner !== agentId) {
      throw new Error(`Task ${taskRef} is reserved for agent "${task.owner}" - claiming agent "${agentId}" is not the owner`);
    }

    const active = claims.claims.find(
      (c) => c.task_ref === taskRef && ['claimed', 'in_progress'].includes(c.state),
    );
    if (active) throw new Error(`Task already claimed by ${active.agent_id} (${active.run_id}): ${taskRef}`);

    const run_id = makeRunId();
    const now    = new Date();
    const lease_expires_at = new Date(now.getTime() + leaseDurationMs).toISOString();

    task.status = 'claimed';
    atomicWriteJson(join(stateDir, 'backlog.json'), backlog);

    claims.claims.push({
      run_id, task_ref: taskRef, agent_id: agentId,
      state: 'claimed', claimed_at: now.toISOString(), lease_expires_at,
      task_envelope_sent_at: null,
      last_heartbeat_at: null, started_at: null, finished_at: null,
      finalization_state: null, finalization_retry_count: 0, finalization_blocked_reason: null,
      input_state: null, input_requested_at: null,
      session_start_retry_count: 0, session_start_retry_next_at: null, session_start_last_error: null,
    });
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    emit(stateDir, {
      ts: now.toISOString(), event: 'claim_created',
      actor_type: 'agent', actor_id: agentId,
      run_id, task_ref: taskRef, agent_id: agentId,
      payload: { lease_expires_at },
    });

    return { run_id, lease_expires_at };
  });
}

/**
 * Transition a claimed run to in_progress.
 */
export function startRun(
  stateDir: string,
  runId: string,
  agentId: string,
  {
    emitEvent = true,
    at = new Date().toISOString(),
    actorType = 'agent' as ActorType,
    actorId,
  }: { emitEvent?: boolean; at?: string; actorType?: ActorType; actorId?: string } = {},
): void {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim  = claims.claims.find((c) => c.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    // Idempotent: if already in_progress, silently return without error or duplicate event
    if (claim.state === 'in_progress') return;
    if (claim.state !== 'claimed') throw new Error(`Claim ${runId} is not in 'claimed' state (got: ${claim.state})`);

    assertValidTimestamp(at, 'startRun');
    claim.state = 'in_progress';
    claim.started_at = at;
    resetClaimVolatileFields(claim);
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    const backlog = readJson(stateDir, 'backlog.json') as Backlog;
    const task    = findTask(backlog, claim.task_ref);
    if (task) { task.status = 'in_progress'; atomicWriteJson(join(stateDir, 'backlog.json'), backlog); }

    if (emitEvent) {
      emit(stateDir, {
        ts: at, event: 'run_started',
        actor_type: actorType, actor_id: actorId ?? agentId,
        run_id: runId, task_ref: claim.task_ref, agent_id: agentId,
      });
    }
  });
}

/**
 * Renew the lease on an active claim. Returns { lease_expires_at }.
 */
export function heartbeat(
  stateDir: string,
  runId: string,
  agentId: string,
  {
    leaseDurationMs = DEFAULT_LEASE_MS,
    emitEvent = true,
    at = new Date().toISOString(),
  }: { leaseDurationMs?: number; emitEvent?: boolean; at?: string } = {},
): { lease_expires_at: string } {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim  = claims.claims.find((c) => c.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (!['claimed', 'in_progress'].includes(claim.state)) {
      throw new Error(`Cannot heartbeat claim in state: ${claim.state}`);
    }

    assertValidTimestamp(at, 'heartbeat');
    const now = new Date(at);
    if (claim.lease_expires_at && new Date(claim.lease_expires_at) < now) {
      throw new Error(`Lease has already expired for run ${runId} (expired at ${claim.lease_expires_at})`);
    }
    const lease_expires_at = new Date(now.getTime() + leaseDurationMs).toISOString();
    claim.last_heartbeat_at = at;
    claim.lease_expires_at  = lease_expires_at;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    if (emitEvent) {
      emit(stateDir, {
        ts: at, event: 'heartbeat',
        actor_type: 'agent', actor_id: agentId,
        run_id: runId, task_ref: claim.task_ref, agent_id: agentId,
        payload: { lease_expires_at },
      });
    }

    return { lease_expires_at };
  });
}

/**
 * Extend lease_expires_at without updating last_heartbeat_at.
 * Used by the coordinator PID probe to prevent lease expiry for alive workers
 * during long phases, without resetting the activity timestamp that drives
 * staleness detection.
 */
export function renewLeaseOnly(
  stateDir: string,
  runId: string,
  { leaseDurationMs = DEFAULT_LEASE_MS }: { leaseDurationMs?: number } = {},
): void {
  withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim  = claims.claims.find((c) => c.run_id === runId);
    if (!claim || !['claimed', 'in_progress'].includes(claim.state)) return;
    const now = new Date();
    if (claim.lease_expires_at && new Date(claim.lease_expires_at) < now) return; // already expired
    claim.lease_expires_at = new Date(now.getTime() + leaseDurationMs).toISOString();
    atomicWriteJson(join(stateDir, 'claims.json'), claims);
  });
}

/**
 * Finish a run. success=true → task 'done'; false → requeue or block.
 */
export function finishRun(
  stateDir: string,
  runId: string,
  agentId: string,
  { success = true, failureReason = null, failureCode = null, policy = 'requeue', emitEvent = true, at = new Date().toISOString() }: {
    success?: boolean;
    failureReason?: string | null;
    failureCode?: string | null;
    policy?: string;
    emitEvent?: boolean;
    at?: string;
  } = {},
): void {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim  = claims.claims.find((c) => c.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);

    assertValidTimestamp(at, 'finishRun');
    claim.state       = success ? 'done' : 'failed';
    claim.finished_at = at;
    if (!success && failureReason) claim.failure_reason = failureReason;
    resetClaimVolatileFields(claim);
    claim.finalization_state = null;
    claim.finalization_retry_count = 0;
    claim.finalization_blocked_reason = null;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    const backlog = readJson(stateDir, 'backlog.json') as Backlog;
    const task    = findTask(backlog, claim.task_ref);
    if (task) {
      if (success) {
        task.status = 'done';
      } else if (policy === 'block') {
        task.status = 'blocked';
      } else {
        // Requeue path: increment attempt counter, auto-block at MAX_ATTEMPTS.
        // Infrastructure failures (dispatch, session-start) do not count against
        // the task's attempt budget — only genuine execution failures do.
        const isInfraFailure = failureCode === 'ERR_DISPATCH_FAILURE'
          || failureCode === 'ERR_RUN_START_TIMEOUT'
          || failureCode === 'ERR_SESSION_START_FAILED';
        if (!isInfraFailure) {
          const attempts = (task.attempt_count ?? 0) + 1;
          task.attempt_count = attempts;
          if (attempts >= MAX_ATTEMPTS) {
            task.status = 'blocked';
            task.blocked_reason = `max_attempts_exceeded: failed ${attempts} times`;
          } else {
            task.status = 'todo';
            task.requeue_eligible_after = new Date(new Date(at).getTime() + _requeueBackoffMs(attempts)).toISOString();
          }
        } else {
          task.status = 'todo';
        }
      }
      atomicWriteJson(join(stateDir, 'backlog.json'), backlog);
    }

    if (emitEvent) {
      if (success) {
        emit(stateDir, {
          ts: at, event: 'run_finished',
          actor_type: 'agent', actor_id: agentId,
          run_id: runId, task_ref: claim.task_ref, agent_id: agentId,
          payload: {},
        });
      } else {
        emit(stateDir, {
          ts: at, event: 'run_failed',
          actor_type: 'agent', actor_id: agentId,
          run_id: runId, task_ref: claim.task_ref, agent_id: agentId,
          payload: { reason: failureReason ?? undefined, code: failureCode ?? undefined, policy: policy as import('../types/events.ts').FailurePolicy },
        });
      }
    }
  });
}
