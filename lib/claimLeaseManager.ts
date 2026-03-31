import { join } from 'node:path';
import { withLock, lockPath } from './lock.ts';
import { INPUT_WAIT_TIMEOUT_MS } from './constants.ts';
import { atomicWriteJson } from './atomicWrite.ts';
import { appendSequencedEvent } from './eventLog.ts';
import { readJson, findTask } from './stateReader.ts';
import type { Claim, ClaimsState } from '../types/claims.ts';
import type { Backlog } from '../types/backlog.ts';
import type { OrcEventInput } from '../types/events.ts';

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS  = 600_000;

export function requeueBackoffMs(attemptCount: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, attemptCount - 1), BACKOFF_MAX_MS);
}

function resetClaimVolatileFields(claim: Claim): void {
  claim.input_state = null;
  claim.input_requested_at = null;
  claim.session_start_retry_count = 0;
  claim.session_start_retry_next_at = null;
  claim.session_start_last_error = null;
}

function emit(stateDir: string, event: OrcEventInput): void {
  appendSequencedEvent(stateDir, event, {
    fsyncPolicy: 'always',
    lockAlreadyHeld: true,
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
    resetClaimVolatileFields(claim);
    expired.push({ run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id, code });

    const task = findTask(backlog, claim.task_ref);
    if (task) {
      if (policy === 'block') {
        task.status = 'blocked';
      } else {
        const attempts = (task.attempt_count ?? 0) + 1;
        task.attempt_count = attempts;
        if (attempts >= MAX_ATTEMPTS) {
          task.status = 'blocked';
          task.blocked_reason = `max_attempts_exceeded: expired ${attempts} times`;
        } else {
          task.status = 'todo';
          task.requeue_eligible_after = new Date(now.getTime() + requeueBackoffMs(attempts)).toISOString();
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
