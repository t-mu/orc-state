import { join } from 'node:path';
import { withLock, lockPath } from './lock.ts';
import { DEFAULT_LEASE_MS, INPUT_WAIT_TIMEOUT_MS } from './constants.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { readJson, findTask } from './stateReader.ts';
import type { Claim, ClaimsState, FinalizationState, InputState } from '../types/claims.ts';
import type { Backlog } from '../types/backlog.ts';
import type { ActorType, OrcEventInput } from '../types/events.ts';

const MAX_ATTEMPTS = 5; // auto-block a task after this many dispatch+fail cycles
const FINALIZATION_STATES = new Set<FinalizationState | null>([
  'awaiting_finalize',
  'finalize_rebase_requested',
  'finalize_rebase_in_progress',
  'ready_to_merge',
  'blocked_finalize',
  null,
]);

// ── Helpers ────────────────────────────────────────────────────────────────

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

    if (!Number.isFinite(new Date(at).getTime())) {
      throw new Error(`Invalid startRun timestamp: ${at}`);
    }
    claim.state = 'in_progress';
    claim.started_at = at;
    claim.input_state = null;
    claim.input_requested_at = null;
    claim.session_start_retry_count = 0;
    claim.session_start_retry_next_at = null;
    claim.session_start_last_error = null;
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

export function markTaskEnvelopeSent(
  stateDir: string,
  runId: string,
  agentId: string,
  {
    emitEvent = true,
    at = new Date().toISOString(),
    actorType = 'coordinator' as ActorType,
    actorId = 'coordinator',
  }: { emitEvent?: boolean; at?: string; actorType?: ActorType; actorId?: string } = {},
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (!['claimed', 'in_progress'].includes(claim.state)) {
      throw new Error(`Claim ${runId} cannot record envelope delivery from state '${claim.state}'`);
    }
    if (!Number.isFinite(new Date(at).getTime())) {
      throw new Error(`Invalid task envelope timestamp: ${at}`);
    }
    if (claim.task_envelope_sent_at) {
      return claim;
    }

    claim.task_envelope_sent_at = at;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    if (emitEvent) {
      emit(stateDir, {
        ts: at,
        event: 'task_envelope_sent',
        actor_type: actorType,
        actor_id: actorId,
        run_id: runId,
        task_ref: claim.task_ref,
        agent_id: agentId,
        payload: {},
      });
    }

    return claim;
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

    const now = new Date(at);
    if (!Number.isFinite(now.getTime())) {
      throw new Error(`Invalid heartbeat timestamp: ${at}`);
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

    if (!Number.isFinite(new Date(at).getTime())) {
      throw new Error(`Invalid finishRun timestamp: ${at}`);
    }
    claim.state       = success ? 'done' : 'failed';
    claim.finished_at = at;
    if (!success && failureReason) claim.failure_reason = failureReason;
    claim.input_state = null;
    claim.input_requested_at = null;
    claim.finalization_state = null;
    claim.finalization_retry_count = 0;
    claim.finalization_blocked_reason = null;
    claim.session_start_retry_count = 0;
    claim.session_start_retry_next_at = null;
    claim.session_start_last_error = null;
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

export function setRunFinalizationState(
  stateDir: string,
  runId: string,
  agentId: string,
  {
    finalizationState,
    retryCountDelta = 0,
    blockedReason = null,
  }: {
    finalizationState?: FinalizationState;
    retryCountDelta?: number;
    blockedReason?: string | null;
  } = {},
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (claim.state !== 'in_progress') {
      throw new Error(`Finalization updates require in_progress claim state (got: ${claim.state})`);
    }
    if (!FINALIZATION_STATES.has(finalizationState ?? null)) {
      throw new Error(`Unsupported finalization state: ${String(finalizationState)}`);
    }
    if (!Number.isInteger(retryCountDelta)) {
      throw new Error(`retryCountDelta must be an integer (got: ${retryCountDelta})`);
    }
    if (blockedReason !== null && typeof blockedReason !== 'string') {
      throw new Error('blockedReason must be a string or null');
    }

    claim.finalization_state = finalizationState ?? null;
    claim.finalization_retry_count = Math.max(0, (claim.finalization_retry_count ?? 0) + retryCountDelta);
    claim.finalization_blocked_reason = blockedReason;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

export function setRunInputState(
  stateDir: string,
  runId: string,
  agentId: string,
  {
    inputState = null,
    requestedAt = null,
  }: {
    inputState?: InputState;
    requestedAt?: string | null;
  } = {},
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (!['claimed', 'in_progress'].includes(claim.state)) {
      throw new Error(`Input state updates require claimed or in_progress claim state (got: ${claim.state})`);
    }
    if (![null, 'awaiting_input'].includes(inputState)) {
      throw new Error(`Unsupported input state: ${String(inputState)}`);
    }
    if (requestedAt !== null && !Number.isFinite(new Date(requestedAt ?? '').getTime())) {
      throw new Error(`requestedAt must be an ISO date-time string or null (got: ${String(requestedAt)})`);
    }

    claim.input_state = inputState;
    claim.input_requested_at = inputState === 'awaiting_input'
      ? (requestedAt ?? new Date().toISOString())
      : null;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

export function setRunSessionStartRetryState(
  stateDir: string,
  runId: string,
  agentId: string,
  {
    retryCount = 0,
    nextRetryAt = null,
    lastError = null,
  }: {
    retryCount?: number;
    nextRetryAt?: string | null;
    lastError?: string | null;
  } = {},
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (claim.state !== 'claimed') {
      throw new Error(`Session start retry updates require claimed claim state (got: ${claim.state})`);
    }
    if (!Number.isInteger(retryCount) || retryCount < 0) {
      throw new Error(`retryCount must be a non-negative integer (got: ${String(retryCount)})`);
    }
    if (nextRetryAt !== null && !Number.isFinite(new Date(nextRetryAt).getTime())) {
      throw new Error(`nextRetryAt must be an ISO date-time string or null (got: ${String(nextRetryAt)})`);
    }
    if (lastError !== null && typeof lastError !== 'string') {
      throw new Error('lastError must be a string or null');
    }

    claim.session_start_retry_count = retryCount;
    claim.session_start_retry_next_at = retryCount > 0 ? nextRetryAt : null;
    claim.session_start_last_error = retryCount > 0 ? lastError : null;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

export function setEscalationNotified(
  stateDir: string,
  runId: string,
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);

    claim.escalation_notified_at = new Date().toISOString();
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

function _expireLeasesCore(
  stateDir: string,
  { policy = 'requeue', actorId = 'coordinator' }: { policy?: string; actorId?: string } = {},
): Array<{ run_id: string; task_ref: string; agent_id: string }> {
  const claims  = readJson(stateDir, 'claims.json') as ClaimsState;
  const backlog = readJson(stateDir, 'backlog.json') as Backlog;
  const now     = new Date();
  const expired: Array<{ run_id: string; task_ref: string; agent_id: string; code: string }> = [];

  for (const claim of claims.claims) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;

    if (claim.input_state === 'awaiting_input') {
      const inputRequestedAt = claim.input_requested_at
        ? new Date(claim.input_requested_at).getTime()
        : new Date(claim.last_heartbeat_at ?? claim.claimed_at).getTime();
      if (now.getTime() - inputRequestedAt < INPUT_WAIT_TIMEOUT_MS) continue;
      // Input wait exceeded — fall through to expiry with ERR_INPUT_TIMEOUT
    } else if (!claim.lease_expires_at || new Date(claim.lease_expires_at) > now) {
      continue;
    }

    const code = claim.input_state === 'awaiting_input' ? 'ERR_INPUT_TIMEOUT' : 'ERR_LEASE_EXPIRED';
    claim.state       = 'failed';
    claim.finished_at = now.toISOString();
    if (code === 'ERR_INPUT_TIMEOUT') claim.failure_reason = 'ERR_INPUT_TIMEOUT';
    claim.input_state = null;
    claim.input_requested_at = null;
    claim.session_start_retry_count = 0;
    claim.session_start_retry_next_at = null;
    claim.session_start_last_error = null;
    expired.push({ run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id, code });

    const task = findTask(backlog, claim.task_ref);
    if (task) {
      if (policy === 'block') {
        task.status = 'blocked';
      } else {
        // Requeue path: increment attempt counter, auto-block at MAX_ATTEMPTS.
        const attempts = (task.attempt_count ?? 0) + 1;
        task.attempt_count = attempts;
        if (attempts >= MAX_ATTEMPTS) {
          task.status = 'blocked';
          task.blocked_reason = `max_attempts_exceeded: expired ${attempts} times`;
        } else {
          task.status = 'todo';
        }
      }
    }
  }

  if (expired.length > 0) {
    atomicWriteJson(join(stateDir, 'claims.json'), claims);
    atomicWriteJson(join(stateDir, 'backlog.json'), backlog);
    for (const { run_id, task_ref, code } of expired) {
      emit(stateDir, {
        ts: now.toISOString(), event: 'claim_expired',
        actor_type: 'coordinator', actor_id: actorId,
        run_id, task_ref, payload: { policy: policy as import('../types/events.ts').FailurePolicy, code },
      });
    }
  }

  return expired;
}

/**
 * Expire all stale leases (lease_expires_at < now).
 * Returns array of expired run_ids.
 */
export function expireStaleLeases(
  stateDir: string,
  options: { policy?: string; actorId?: string } = {},
): string[] {
  return withLock(lockPath(stateDir), () => _expireLeasesCore(stateDir, options).map((e) => e.run_id));
}

export function expireStaleLeasesDetailed(
  stateDir: string,
  options: { policy?: string; actorId?: string } = {},
): Array<{ run_id: string; task_ref: string; agent_id: string }> {
  return withLock(lockPath(stateDir), () => _expireLeasesCore(stateDir, options));
}
