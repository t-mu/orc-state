import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import { appendSequencedEvent, readEventsSince } from './eventLog.ts';
import { validateProgressCommandInput } from './progressValidation.ts';
import { startRun } from './claimManager.ts';
import { STATE_DIR, EVENTS_FILE } from './paths.ts';
import { readBacklog, findTask, readClaims } from './stateReader.ts';
import { INPUT_REQUEST_HEARTBEAT_INTERVAL_MS } from './constants.ts';
import { DEFAULT_INPUT_REQUEST_TIMEOUT_MS } from './inputRequestConfig.ts';
import type { Claim } from '../types/claims.ts';
import type { FailurePolicy } from '../types/events.ts';

const INPUT_REQUEST_TIMEOUT_GRACE_MS = 250;

function loadClaim(runId: string): Claim | null {
  try {
    return readClaims(STATE_DIR).claims.find((claim) => claim.run_id === runId) ?? null;
  } catch {
    return null;
  }
}

function isActiveRunClaim(claim: Claim | null, agentId: string): claim is Claim {
  return claim != null
    && claim.agent_id === agentId
    && ['claimed', 'in_progress'].includes(claim.state);
}

export function executeRunStart(runId: string, agentId: string): void {
  const claim = loadClaim(runId);

  // Idempotent: if coordinator already auto-acked this run, treat as no-op success
  if (claim?.state === 'in_progress' && claim?.agent_id === agentId) {
    console.log(`run_started: ${runId} (${agentId})`);
    return;
  }

  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'run_started',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);

  const at = new Date().toISOString();
  appendSequencedEvent(STATE_DIR, {
    ts: at,
    event: 'run_started',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {},
  }, { lockStrategy: 'none' });

  // Update claims.json synchronously so enforceRunStartLifecycle sees in_progress
  // immediately, without waiting for the coordinator's event polling cycle (~30 s).
  try {
    startRun(STATE_DIR, runId, agentId, { emitEvent: false, at });
  } catch {
    // Ignore: coordinator may have already transitioned the claim via event processing.
  }

  console.log(`run_started: ${runId} (${agentId})`);
}

export function executeRunFail(runId: string, agentId: string, reason: string, code: string, policy: string): void {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'run_failed',
    runId,
    agentId,
    phase: null,
    reason,
    policy,
  }, claim);

  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'run_failed',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {
      reason,
      code,
      policy: policy as FailurePolicy,
    },
  }, { lockStrategy: 'none' });
  console.log(`run_failed: ${runId} (${agentId}) reason=${reason}`);
}

export function executeRunFinish(runId: string, agentId: string): void {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'run_finished',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);

  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'run_finished',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {},
  }, { lockStrategy: 'none' });
  console.log(`run_finished: ${runId} (${agentId})`);
}

function nextFinalizationTransition(claim: Claim | null) {
  const currentState = claim?.finalization_state ?? null;
  if (currentState === null) {
    return { event: 'work_complete', status: 'awaiting_finalize', message: 'awaiting coordinator finalization' };
  }
  if (currentState === 'finalize_rebase_in_progress') {
    return { event: 'ready_to_merge', status: 'ready_to_merge', message: 'ready to merge after finalize rebase' };
  }
  throw new Error(`run-work-complete cannot be reported from finalization_state '${currentState}'`);
}

export function executeRunWorkComplete(runId: string, agentId: string): void {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'work_complete',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);

  // Gate: reject if task not marked done
  const taskRef = validatedClaim.task_ref;
  if (taskRef) {
    const backlog = readBacklog(STATE_DIR);
    const task = findTask(backlog, taskRef);
    if (task && task.status !== 'done') {
      throw new Error(`task not marked done — call orc task-mark-done ${taskRef} first`);
    }
  }

  const transition = nextFinalizationTransition(validatedClaim);
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: transition.event as 'work_complete' | 'ready_to_merge',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {
      status: transition.status as 'awaiting_finalize' | 'ready_to_merge',
    },
  } as import('../types/events.ts').OrcEventInput, { lockStrategy: 'none' });
  console.log(`${transition.event}: ${runId} (${agentId}) ${transition.message}`);
}

export async function executeRunInputRequest(
  runId: string,
  agentId: string,
  question: string,
  timeoutMs: number = DEFAULT_INPUT_REQUEST_TIMEOUT_MS,
  pollMs: number = 1000,
): Promise<void> {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'need_input',
    runId,
    agentId,
    phase: null,
    reason: 'master_input_required',
    policy: null,
  }, claim);
  if (validatedClaim.state !== 'in_progress') {
    console.error(`Timed out waiting for input_response for run ${runId} after ${timeoutMs}ms`);
    process.exit(1);
  }
  const taskRef = validatedClaim.task_ref;

  const nowIso = new Date().toISOString();
  const requestId = randomUUID();
  const requestSeq = appendSequencedEvent(STATE_DIR, {
    ts: nowIso,
    event: 'input_requested',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: { question, request_id: requestId },
  });

  function readLatestInputResponse() {
    const events = readEventsSince(EVENTS_FILE, 0);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      const payload = event.payload as Record<string, unknown>;
      const matchesRequestId = payload.request_id === requestId;
      const isLegacyMatch = payload.request_id === undefined
        && typeof event.seq === 'number'
        && event.seq > requestSeq;
      if (
        event.event === 'input_response'
        && event.run_id === runId
        && event.agent_id === agentId
        && (matchesRequestId || isLegacyMatch)
        && typeof payload.response === 'string'
      ) {
        return event;
      }
    }
    return null;
  }

  const deadline = Date.now() + timeoutMs;
  let lastHeartbeatAt = Date.now();

  while (true) {
    const responseEvent = readLatestInputResponse();
    if (responseEvent) {
      process.stdout.write(`${String((responseEvent.payload as Record<string, unknown>).response)}\n`);
      process.exit(0);
    }

    const currentClaim = loadClaim(runId);
    const now = Date.now();
    if (!isActiveRunClaim(currentClaim, agentId) || now >= deadline) {
      break;
    }

    if ((now - lastHeartbeatAt) >= INPUT_REQUEST_HEARTBEAT_INTERVAL_MS) {
      appendSequencedEvent(STATE_DIR, {
        ts: new Date().toISOString(),
        event: 'heartbeat',
        actor_type: 'agent',
        actor_id: agentId,
        run_id: runId,
        task_ref: taskRef,
        agent_id: agentId,
      }, { lockStrategy: 'none' });
      lastHeartbeatAt = now;
    }

    await delay(Math.max(1, Math.min(pollMs, deadline - now)));
  }

  const timeoutGraceDeadline = Date.now() + INPUT_REQUEST_TIMEOUT_GRACE_MS;
  while (Date.now() < timeoutGraceDeadline) {
    const finalResponseEvent = readLatestInputResponse();
    if (finalResponseEvent) {
      process.stdout.write(`${String((finalResponseEvent.payload as Record<string, unknown>).response)}\n`);
      process.exit(0);
    }

    const graceClaim = loadClaim(runId);
    if (!isActiveRunClaim(graceClaim, agentId)) {
      break;
    }

    await delay(Math.max(5, Math.min(25, timeoutGraceDeadline - Date.now())));
  }

  const currentClaim = loadClaim(runId);
  const shouldEmitTimeoutFailure = isActiveRunClaim(currentClaim, agentId);

  if (shouldEmitTimeoutFailure) {
    appendSequencedEvent(STATE_DIR, {
      ts: new Date().toISOString(),
      event: 'run_failed',
      actor_type: 'agent',
      actor_id: agentId,
      run_id: runId,
      task_ref: taskRef,
      agent_id: agentId,
      payload: {
        reason: 'input_request_timeout',
        code: 'ERR_INPUT_REQUEST_TIMEOUT',
        policy: 'requeue' as FailurePolicy,
      },
    }, { lockStrategy: 'none' });
  }
  console.error(`Timed out waiting for input_response for run ${runId} after ${timeoutMs}ms`);
  process.exit(1);
}
