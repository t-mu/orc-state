import { join } from 'node:path';
import { withLock, lockPath } from './lock.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { readJson } from './stateReader.ts';
import type { Claim, ClaimsState, FinalizationState, InputState } from '../types/claims.ts';
import type { ActorType, OrcEventInput } from '../types/events.ts';

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

function emit(stateDir: string, event: OrcEventInput): void {
  appendSequencedEvent(stateDir, event, {
    fsyncPolicy: 'always',
    lockAlreadyHeld: true,
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
    assertValidTimestamp(at, 'task envelope');
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
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

export function setPrCreatedAt(
  stateDir: string,
  runId: string,
  createdAt: string,
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.state !== 'in_progress') {
      throw new Error(`PR created_at update requires in_progress claim state (got: ${claim.state})`);
    }
    assertValidTimestamp(createdAt, 'pr_created_at');

    claim.pr_created_at = createdAt;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

export function setPrReviewerAgentId(
  stateDir: string,
  runId: string,
  reviewerAgentId: string,
): Claim {
  return withLock(lockPath(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json') as ClaimsState;
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.state !== 'in_progress') {
      throw new Error(`PR reviewer agent_id update requires in_progress claim state (got: ${claim.state})`);
    }
    if (typeof reviewerAgentId !== 'string' || !reviewerAgentId) {
      throw new Error('reviewerAgentId must be a non-empty string');
    }

    claim.pr_reviewer_agent_id = reviewerAgentId;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}
