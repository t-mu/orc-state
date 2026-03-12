import { join } from 'node:path';
import { withLock } from './lock.mjs';
import { atomicWriteJson } from './atomicWrite.mjs';
import { appendSequencedEvent } from './eventLog.mjs';
import { readJson, findTask } from './stateReader.mjs';

const DEFAULT_LEASE_MS = 30 * 60 * 1000; // 30 minutes
const MAX_ATTEMPTS = 5; // auto-block a task after this many dispatch+fail cycles
const FINALIZATION_STATES = new Set([
  'awaiting_finalize',
  'finalize_rebase_requested',
  'finalize_rebase_in_progress',
  'ready_to_merge',
  'blocked_finalize',
  null,
]);

// ── Helpers ────────────────────────────────────────────────────────────────

function lp(stateDir)  { return join(stateDir, '.lock'); }

function makeRunId() {
  const ts   = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 6);
  return `run-${ts}-${rand}`;
}

function emit(stateDir, event) {
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
export function claimTask(stateDir, taskRef, agentId, { leaseDurationMs = DEFAULT_LEASE_MS } = {}) {
  return withLock(lp(stateDir), () => {
    const backlog = readJson(stateDir, 'backlog.json');
    const claims  = readJson(stateDir, 'claims.json');

    const task = findTask(backlog, taskRef);
    if (!task) throw new Error(`Task not found: ${taskRef}`);
    if (task.status !== 'todo') throw new Error(`Task not claimable (status: ${task.status}): ${taskRef}`);
    if (task.owner && task.owner !== agentId) {
      throw new Error(`Task ${taskRef} is reserved for agent "${task.owner}" - claiming agent "${agentId}" is not the owner`);
    }

    const active = claims.claims.find(
      c => c.task_ref === taskRef && ['claimed', 'in_progress'].includes(c.state)
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
      last_heartbeat_at: null, started_at: null, finished_at: null,
      finalization_state: null, finalization_retry_count: 0, finalization_blocked_reason: null,
      input_state: null, input_requested_at: null,
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
export function startRun(stateDir, runId, agentId) {
  return withLock(lp(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json');
    const claim  = claims.claims.find(c => c.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (claim.state !== 'claimed') throw new Error(`Claim ${runId} is not in 'claimed' state (got: ${claim.state})`);

    const now = new Date().toISOString();
    claim.state = 'in_progress';
    claim.started_at = now;
    claim.input_state = null;
    claim.input_requested_at = null;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    const backlog = readJson(stateDir, 'backlog.json');
    const task    = findTask(backlog, claim.task_ref);
    if (task) { task.status = 'in_progress'; atomicWriteJson(join(stateDir, 'backlog.json'), backlog); }

    emit(stateDir, {
      ts: now, event: 'run_started',
      actor_type: 'agent', actor_id: agentId,
      run_id: runId, task_ref: claim.task_ref, agent_id: agentId,
    });
  });
}

/**
 * Renew the lease on an active claim. Returns { lease_expires_at }.
 */
export function heartbeat(
  stateDir,
  runId,
  agentId,
  { leaseDurationMs = DEFAULT_LEASE_MS, emitEvent = true } = {},
) {
  return withLock(lp(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json');
    const claim  = claims.claims.find(c => c.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (!['claimed', 'in_progress'].includes(claim.state)) {
      throw new Error(`Cannot heartbeat claim in state: ${claim.state}`);
    }

    const now  = new Date();
    const lease_expires_at = new Date(now.getTime() + leaseDurationMs).toISOString();
    claim.last_heartbeat_at = now.toISOString();
    claim.lease_expires_at  = lease_expires_at;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    if (emitEvent) {
      emit(stateDir, {
        ts: now.toISOString(), event: 'heartbeat',
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
  stateDir,
  runId,
  agentId,
  { success = true, failureReason = null, failureCode = null, policy = 'requeue' } = {},
) {
  return withLock(lp(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json');
    const claim  = claims.claims.find(c => c.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);

    const now = new Date().toISOString();
    claim.state       = success ? 'done' : 'failed';
    claim.finished_at = now;
    if (!success && failureReason) claim.failure_reason = failureReason;
    claim.input_state = null;
    claim.input_requested_at = null;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    const backlog = readJson(stateDir, 'backlog.json');
    const task    = findTask(backlog, claim.task_ref);
    if (task) {
      if (success) {
        task.status = 'done';
      } else if (policy === 'block') {
        task.status = 'blocked';
      } else {
        // Requeue path: increment attempt counter, auto-block at MAX_ATTEMPTS.
        const attempts = (task.attempt_count ?? 0) + 1;
        task.attempt_count = attempts;
        if (attempts >= MAX_ATTEMPTS) {
          task.status = 'blocked';
          task.blocked_reason = `max_attempts_exceeded: failed ${attempts} times`;
        } else {
          task.status = 'todo';
        }
      }
      atomicWriteJson(join(stateDir, 'backlog.json'), backlog);
    }

    emit(stateDir, {
      ts: now,
      event: success ? 'run_finished' : 'run_failed',
      actor_type: 'agent', actor_id: agentId,
      run_id: runId, task_ref: claim.task_ref, agent_id: agentId,
      payload: success ? {} : { reason: failureReason, code: failureCode, policy },
    });
  });
}

export function setRunFinalizationState(
  stateDir,
  runId,
  agentId,
  {
    finalizationState,
    retryCountDelta = 0,
    blockedReason = null,
  } = {},
) {
  return withLock(lp(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json');
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (claim.state !== 'in_progress') {
      throw new Error(`Finalization updates require in_progress claim state (got: ${claim.state})`);
    }
    if (!FINALIZATION_STATES.has(finalizationState)) {
      throw new Error(`Unsupported finalization state: ${finalizationState}`);
    }
    if (!Number.isInteger(retryCountDelta)) {
      throw new Error(`retryCountDelta must be an integer (got: ${retryCountDelta})`);
    }
    if (blockedReason !== null && typeof blockedReason !== 'string') {
      throw new Error('blockedReason must be a string or null');
    }

    claim.finalization_state = finalizationState;
    claim.finalization_retry_count = Math.max(0, (claim.finalization_retry_count ?? 0) + retryCountDelta);
    claim.finalization_blocked_reason = blockedReason;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

export function setRunInputState(
  stateDir,
  runId,
  agentId,
  {
    inputState = null,
    requestedAt = null,
  } = {},
) {
  return withLock(lp(stateDir), () => {
    const claims = readJson(stateDir, 'claims.json');
    const claim = claims.claims.find((candidate) => candidate.run_id === runId);
    if (!claim) throw new Error(`Claim not found: ${runId}`);
    if (claim.agent_id !== agentId) throw new Error(`Claim ${runId} belongs to ${claim.agent_id}`);
    if (claim.state !== 'in_progress') {
      throw new Error(`Input state updates require in_progress claim state (got: ${claim.state})`);
    }
    if (![null, 'awaiting_input'].includes(inputState)) {
      throw new Error(`Unsupported input state: ${inputState}`);
    }
    if (requestedAt !== null && !Number.isFinite(new Date(requestedAt).getTime())) {
      throw new Error(`requestedAt must be an ISO date-time string or null (got: ${requestedAt})`);
    }

    claim.input_state = inputState;
    claim.input_requested_at = inputState === 'awaiting_input'
      ? (requestedAt ?? new Date().toISOString())
      : null;
    atomicWriteJson(join(stateDir, 'claims.json'), claims);

    return claim;
  });
}

/**
 * Expire all stale leases (lease_expires_at < now).
 * Returns array of expired run_ids.
 */
export function expireStaleLeases(stateDir, { policy = 'requeue', actorId = 'coordinator' } = {}) {
  return withLock(lp(stateDir), () => {
    const claims  = readJson(stateDir, 'claims.json');
    const backlog = readJson(stateDir, 'backlog.json');
    const now     = new Date();
    const expired = [];

    for (const claim of claims.claims) {
      if (!['claimed', 'in_progress'].includes(claim.state)) continue;
      if (claim.input_state === 'awaiting_input') continue;
      if (!claim.lease_expires_at || new Date(claim.lease_expires_at) > now) continue;

      claim.state       = 'failed';
      claim.finished_at = now.toISOString();
      expired.push({ run_id: claim.run_id, task_ref: claim.task_ref });

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
      for (const { run_id, task_ref } of expired) {
        emit(stateDir, {
          ts: now.toISOString(), event: 'claim_expired',
          actor_type: 'coordinator', actor_id: actorId,
          run_id, task_ref, payload: { policy, code: 'ERR_LEASE_EXPIRED' },
        });
      }
    }

    return expired.map(e => e.run_id);
  });
}

export function expireStaleLeasesDetailed(stateDir, options = {}) {
  return withLock(lp(stateDir), () => {
    const claims  = readJson(stateDir, 'claims.json');
    const backlog = readJson(stateDir, 'backlog.json');
    const now     = new Date();
    const expired = [];
    const policy = options.policy ?? 'requeue';
    const actorId = options.actorId ?? 'coordinator';

    for (const claim of claims.claims) {
      if (!['claimed', 'in_progress'].includes(claim.state)) continue;
      if (claim.input_state === 'awaiting_input') continue;
      if (!claim.lease_expires_at || new Date(claim.lease_expires_at) > now) continue;

      claim.state = 'failed';
      claim.finished_at = now.toISOString();
      expired.push({
        run_id: claim.run_id,
        task_ref: claim.task_ref,
        agent_id: claim.agent_id,
      });

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
          }
        }
      }
    }

    if (expired.length > 0) {
      atomicWriteJson(join(stateDir, 'claims.json'), claims);
      atomicWriteJson(join(stateDir, 'backlog.json'), backlog);
      for (const { run_id, task_ref } of expired) {
        emit(stateDir, {
          ts: now.toISOString(),
          event: 'claim_expired',
          actor_type: 'coordinator',
          actor_id: actorId,
          run_id,
          task_ref,
          payload: { policy, code: 'ERR_LEASE_EXPIRED' },
        });
      }
    }

    return expired;
  });
}
