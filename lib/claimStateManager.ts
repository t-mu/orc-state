import { withLock, lockPath } from './lock.ts';
import { commitClaims } from './runStore.ts';
import { readJson } from './stateReader.ts';
import type { Claim, ClaimsState, FinalizationState, InputSource, InputState } from '../types/claims.ts';
import type { ActorType } from '../types/events.ts';

const FINALIZATION_STATES = new Set<FinalizationState | null>([
  'awaiting_finalize',
  'finalize_rebase_requested',
  'finalize_rebase_in_progress',
  'ready_to_merge',
  'blocked_finalize',
  'pr_created',
  'pr_review_in_progress',
  'pr_merged',
  'pr_failed',
  null,
]);

function assertValidTimestamp(ts: string, label: string): void {
  if (!Number.isFinite(new Date(ts).getTime())) {
    throw new Error(`Invalid ${label} timestamp: ${ts}`);
  }
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
    assertValidTimestamp(at, 'task envelope');
    if (claim.task_envelope_sent_at) {
      return claim;
    }

    claim.task_envelope_sent_at = at;
    commitClaims(stateDir, claims, emitEvent ? [{
        ts: at,
        event: 'task_envelope_sent',
        actor_type: actorType,
        actor_id: actorId,
        run_id: runId,
        task_ref: claim.task_ref,
        agent_id: agentId,
        payload: {},
      }] : []);

    return claim;
  });
}

/**
 * Legal finalization moves (a write to the same state, e.g. a retry bump, is always legal).
 * `ready_to_merge → finalize_rebase_requested` is the merge-failure path.
 * Documented in docs/contracts.md → Invariants 6.
 */
export const FINALIZATION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  none: ['awaiting_finalize'],
  awaiting_finalize: ['finalize_rebase_requested', 'pr_created', 'blocked_finalize', 'pr_failed'],
  finalize_rebase_requested: ['finalize_rebase_in_progress', 'blocked_finalize', 'pr_failed'],
  finalize_rebase_in_progress: ['ready_to_merge', 'finalize_rebase_requested', 'blocked_finalize', 'pr_failed'],
  ready_to_merge: ['finalize_rebase_requested', 'blocked_finalize', 'pr_failed'],
  blocked_finalize: [],
  pr_created: ['pr_review_in_progress', 'finalize_rebase_requested', 'blocked_finalize', 'pr_failed'],
  pr_review_in_progress: ['pr_merged', 'finalize_rebase_requested', 'blocked_finalize', 'pr_failed'],
  pr_merged: [],
  pr_failed: [],
};

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

    const from = claim.finalization_state ?? null;
    const to = finalizationState ?? null;
    if (to !== from && !FINALIZATION_TRANSITIONS[from ?? 'none']?.includes(to ?? '')) {
      throw new Error(`Illegal finalization transition for ${runId}: ${String(from)} → ${String(to)}`);
    }
    const previousRetryCount = claim.finalization_retry_count ?? 0;
    const previousBlockedReason = claim.finalization_blocked_reason ?? null;
    claim.finalization_state = finalizationState ?? null;
    claim.finalization_retry_count = Math.max(0, previousRetryCount + retryCountDelta);
    claim.finalization_blocked_reason = blockedReason;
    const changed = claim.finalization_state !== from
      || claim.finalization_retry_count !== previousRetryCount
      || claim.finalization_blocked_reason !== previousBlockedReason;
    // The event commits in the same events.db transaction as the claim, so a stream reader sees every change.
    commitClaims(stateDir, claims, changed ? [{
      ts: new Date().toISOString(),
      event: 'finalization_changed',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: runId,
      task_ref: claim.task_ref,
      agent_id: agentId,
      payload: {
        from,
        to: claim.finalization_state,
        retry_count: claim.finalization_retry_count,
        blocked_reason: claim.finalization_blocked_reason,
        pr_ref: claim.pr_ref ?? null,
        pr_created_at: claim.pr_created_at ?? null,
      },
    }] : []);

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
    source = 'worker_request',
  }: {
    inputState?: InputState;
    requestedAt?: string | null;
    /** What the wait is for (`awaiting_input` only). A provider prompt never relabels a pending worker request. */
    source?: InputSource;
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

    const pendingWorkerRequest = claim.input_state === 'awaiting_input' && claim.input_source !== 'provider_prompt';
    claim.input_source = inputState !== 'awaiting_input' ? null
      : pendingWorkerRequest ? 'worker_request'
      : source;
    claim.input_state = inputState;
    claim.input_requested_at = inputState === 'awaiting_input'
      ? (requestedAt ?? new Date().toISOString())
      : null;
    commitClaims(stateDir, claims);

    return claim;
  });
}

/**
 * Clear a provider-prompt input wait the worker has moved past, and renew the lease from now
 * as a heartbeat would (even when it lapsed during the wait), in one commit with an
 * `input_response` from the coordinator recording how the prompt was resolved.
 * `at` dates the worker's activity; it renews `last_heartbeat_at` only when later.
 * A `worker_request` wait, or no wait, is left alone: returns false.
 */
export function resolveProviderPromptWait(
  stateDir: string,
  runId: string,
  agentId: string,
  { at, leaseDurationMs, resolution }: {
    at: string;
    leaseDurationMs: number;
    /** `worker_activity` (a lifecycle event after the request) or `prompt_gone` (no longer on screen). */
    resolution: 'worker_activity' | 'prompt_gone';
  },
): boolean {
  assertValidTimestamp(at, 'activity');
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim || claim.agent_id !== agentId || !['claimed', 'in_progress'].includes(claim.state)) return false;
    if (claim.input_state !== 'awaiting_input' || claim.input_source !== 'provider_prompt') return false;

    const nowIso = new Date().toISOString();
    const requestedAt = claim.input_requested_at ?? null;
    claim.input_state = null;
    claim.input_requested_at = null;
    claim.input_source = null;
    if (!claim.last_heartbeat_at || Date.parse(claim.last_heartbeat_at) < Date.parse(at)) claim.last_heartbeat_at = at;
    const renewedMs = Date.now() + leaseDurationMs;
    const currentMs = claim.lease_expires_at ? Date.parse(claim.lease_expires_at) : NaN;
    claim.lease_expires_at = new Date(Number.isFinite(currentMs) ? Math.max(currentMs, renewedMs) : renewedMs).toISOString();
    commitClaims(stateDir, claims, [{
      ts: nowIso, event: 'input_response',
      actor_type: 'coordinator', actor_id: 'coordinator',
      run_id: runId, task_ref: claim.task_ref, agent_id: agentId,
      payload: {
        response: resolution === 'prompt_gone'
          ? 'provider prompt resolved in the worker terminal (no longer on screen)'
          : 'provider prompt resolved in the worker terminal (worker active again)',
        request_id: null,
        resolution,
        requested_at: requestedAt,
        activity_at: at,
      },
    }]);
    return true;
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
    commitClaims(stateDir, claims);

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
    commitClaims(stateDir, claims);

    return claim;
  });
}

export function setPrRef(
  stateDir: string,
  runId: string,
  prRef: string,
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.state !== 'in_progress') {
      throw new Error(`PR ref update requires in_progress claim state (got: ${claim.state})`);
    }
    if (typeof prRef !== 'string' || !prRef) {
      throw new Error('prRef must be a non-empty string');
    }

    claim.pr_ref = prRef;
    commitClaims(stateDir, claims);

    return claim;
  });
}

export function setPrCreatedAt(
  stateDir: string,
  runId: string,
  createdAt: string,
  initialWorkCompleteSeq?: number,
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.state !== 'in_progress') {
      throw new Error(`PR created_at update requires in_progress claim state (got: ${claim.state})`);
    }
    assertValidTimestamp(createdAt, 'pr_created_at');
    if (initialWorkCompleteSeq !== undefined && (!Number.isSafeInteger(initialWorkCompleteSeq) || initialWorkCompleteSeq < 1)) {
      throw new Error('initial work_complete seq must be a positive safe integer');
    }

    claim.pr_created_at = createdAt;
    if (initialWorkCompleteSeq !== undefined) claim.pr_initial_work_complete_seq = initialWorkCompleteSeq;
    commitClaims(stateDir, claims);

    return claim;
  });
}

