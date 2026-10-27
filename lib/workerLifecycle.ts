import { sessionForCredential } from './sessionCredentials.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { appendSequencedEvent, readEventsSince, withEventDb } from './eventLog.ts';
import { validateProgressCommandInput, validateProgressInput } from './progressValidation.ts';
import { finishRun, heartbeat, startRun } from './claimManager.ts';
import { readClaims } from './stateReader.ts';
import { bridgeInputRequest, bridgeReviewFeedback } from './messageBridge.ts';
import { assertRunMayFinish } from './projectTasks.ts';
import { storeDrawer, wingFromTaskRef } from './memoryStore.ts';
import { getAgent, updateAgentRuntime } from './agentRegistry.ts';
import { ControlError } from './controlProtocol.ts';
import type { Claim } from '../types/claims.ts';
import type { EventFinalizationStatus, OrcEvent, OrcEventInput } from '../types/events.ts';

/**
 * Worker lifecycle requests (Task 229). A legacy installation applies them in
 * the worker's own process; in a registered project the worker sends them to
 * its coordinator's control socket and the coordinator applies them, so it is
 * the only writer of the project's state.
 */
export type LifecycleRequest =
  | { op: 'run-start' | 'run-finish' | 'run-work-complete' | 'input-timeout'; run_id: string; agent_id: string }
  | { op: 'run-fail'; run_id: string; agent_id: string; reason: string; code: string; policy: string }
  | { op: 'progress'; run_id: string; agent_id: string; event: string; phase?: string | null; reason?: string | null; policy?: string | null }
  | { op: 'review-submit'; run_id: string; agent_id: string; outcome: 'approved' | 'findings'; reason: string }
  | { op: 'input-request'; run_id: string; agent_id: string; question: string }
  | { op: 'input-poll'; run_id: string; agent_id: string; request_id: string; request_seq: number; heartbeat?: boolean }
  | { op: 'memory-record'; content: string; wing?: string | null; hall?: string | null; room?: string | null; importance?: number }
  | { op: 'report-for-duty'; agent_id: string; session_token: string };

export type LifecycleOp = LifecycleRequest['op'];

export interface LifecycleResult {
  /** The line the CLI prints on success. */
  message: string;
  request_id?: string;
  request_seq?: number;
  /** input-poll: the master's answer, or null while none has arrived. */
  response?: string | null;
  /** input-poll / input-request: whether the run is still active for this agent. */
  active?: boolean;
}

/** Ops that act on a run; the rest act on the caller's session only. */
const SESSION_OPS = new Set<LifecycleOp>(['memory-record', 'report-for-duty']);
const OPS = new Set<LifecycleOp>(['run-start', 'run-finish', 'run-work-complete', 'input-timeout', 'run-fail', 'progress',
  'review-submit', 'input-request', 'input-poll', 'memory-record', 'report-for-duty']);

function loadClaim(stateDir: string, runId: string): Claim | null {
  try {
    return readClaims(stateDir).claims.find((claim) => claim.run_id === runId) ?? null;
  } catch {
    return null;
  }
}

function isActiveRunClaim(claim: Claim | null, agentId: string): claim is Claim {
  return claim != null && claim.agent_id === agentId && ['claimed', 'in_progress'].includes(claim.state);
}

function finalizationPayload(eventName: string): { status: EventFinalizationStatus } | null {
  if (eventName === 'work_complete') return { status: 'awaiting_finalize' };
  if (eventName === 'finalize_rebase_started') return { status: 'finalize_rebase_in_progress' };
  if (eventName === 'ready_to_merge') return { status: 'ready_to_merge' };
  return null;
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

function command(event: string, request: { run_id: string; agent_id: string }, extra: { reason?: string | null; policy?: string | null; phase?: string | null } = {}) {
  return { event, runId: request.run_id, agentId: request.agent_id, phase: extra.phase ?? null, reason: extra.reason ?? null, policy: extra.policy ?? null };
}

function latestInputResponse(stateDir: string, request: { run_id: string; agent_id: string; request_id: string; request_seq: number }): string | null {
  // Only this run's own request: a request id from another run reads nothing.
  const durable = withEventDb(stateDir, (db) => db
    .prepare("SELECT response FROM input_requests WHERE request_id = ? AND run_id = ? AND state = 'answered'")
    .get(request.request_id, request.run_id) as { response: string | null } | undefined);
  if (durable?.response != null) return durable.response;
  // Any answer follows its request, so the scan starts there rather than at the start of the log.
  const events = readEventsSince(join(stateDir, 'events.db'), request.request_seq);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const matchesRequestId = payload.request_id === request.request_id;
    const isLegacyMatch = payload.request_id === undefined && typeof event.seq === 'number' && event.seq > request.request_seq;
    if (event.event === 'input_response' && event.run_id === request.run_id && event.agent_id === request.agent_id
      && (matchesRequestId || isLegacyMatch) && typeof payload.response === 'string') {
      return payload.response;
    }
  }
  return null;
}

/** Apply one lifecycle request to `stateDir`. Throws on a rejected transition. */
export function applyLifecycle(stateDir: string, request: LifecycleRequest): LifecycleResult {
  const at = new Date().toISOString();
  switch (request.op) {
    case 'run-start': {
      const claim = loadClaim(stateDir, request.run_id);
      // Idempotent: if coordinator already auto-acked this run, treat as no-op success
      if (!(claim?.state === 'in_progress' && claim.agent_id === request.agent_id)) {
        validateProgressCommandInput(command('run_started', request), claim);
        startRun(stateDir, request.run_id, request.agent_id, { at });
      }
      return { message: `run_started: ${request.run_id} (${request.agent_id})` };
    }
    case 'run-fail': {
      validateProgressCommandInput(command('run_failed', request, request), loadClaim(stateDir, request.run_id));
      finishRun(stateDir, request.run_id, request.agent_id, {
        success: false, failureReason: request.reason, failureCode: request.code, policy: request.policy, at,
      });
      return { message: `run_failed: ${request.run_id} (${request.agent_id}) reason=${request.reason}` };
    }
    case 'run-finish': {
      const { claim } = validateProgressCommandInput(command('run_finished', request), loadClaim(stateDir, request.run_id));
      assertRunMayFinish(stateDir, claim.task_ref);
      finishRun(stateDir, request.run_id, request.agent_id, { success: true, at });
      return { message: `run_finished: ${request.run_id} (${request.agent_id})` };
    }
    case 'run-work-complete': {
      const { claim } = validateProgressCommandInput(command('work_complete', request), loadClaim(stateDir, request.run_id));
      const transition = nextFinalizationTransition(claim);
      appendSequencedEvent(stateDir, {
        ts: at, event: transition.event as 'work_complete' | 'ready_to_merge',
        actor_type: 'agent', actor_id: request.agent_id, run_id: request.run_id, task_ref: claim.task_ref, agent_id: request.agent_id,
        payload: { status: transition.status as 'awaiting_finalize' | 'ready_to_merge' },
      } as OrcEventInput, { lockStrategy: 'none' });
      return { message: `${transition.event}: ${request.run_id} (${request.agent_id}) ${transition.message}` };
    }
    case 'progress': {
      const { event, run_id: runId, agent_id: agentId, phase = null, reason = null } = request;
      const policy = request.policy ?? 'requeue';
      const claim = loadClaim(stateDir, runId);
      const validator = event === 'heartbeat' ? validateProgressInput : validateProgressCommandInput;
      const { claim: validatedClaim } = validator({ event, runId, agentId, phase, reason, policy }, claim);
      if (event === 'run_started') {
        // Idempotent like run-start: the coordinator may already have acknowledged the run.
        if (validatedClaim.state !== 'in_progress') startRun(stateDir, runId, agentId, { at });
      } else if (event === 'run_finished') {
        assertRunMayFinish(stateDir, validatedClaim.task_ref);
        finishRun(stateDir, runId, agentId, { success: true });
      } else if (event === 'run_failed') {
        finishRun(stateDir, runId, agentId, { success: false, failureReason: reason, failureCode: 'ERR_WORKER_REPORTED_FAILURE', policy });
      } else if (event === 'heartbeat') {
        heartbeat(stateDir, runId, agentId);
      } else {
        const payload = finalizationPayload(event) ?? (reason ? { reason } : undefined);
        appendSequencedEvent(stateDir, {
          ts: at, event: event as OrcEvent['event'],
          actor_type: 'agent', actor_id: agentId, run_id: runId, task_ref: validatedClaim.task_ref, agent_id: agentId,
          ...(phase ? { phase } : {}),
          ...(payload ? { payload } : {}),
        } as OrcEvent, { lockStrategy: 'none' });
      }
      return { message: `progress event accepted: ${event} run=${runId} agent=${agentId}` };
    }
    case 'review-submit': {
      const messageId = bridgeReviewFeedback(stateDir, request.run_id, request.agent_id, request.outcome, request.reason);
      appendSequencedEvent(stateDir, {
        ts: at, event: 'review_submitted', actor_type: 'agent', actor_id: request.agent_id,
        run_id: request.run_id, agent_id: request.agent_id,
        payload: { outcome: request.outcome, findings: request.reason, message_id: messageId },
      });
      if (request.outcome === 'findings') {
        try {
          storeDrawer(stateDir, {
            wing: wingFromTaskRef(loadClaim(stateDir, request.run_id)?.task_ref ?? ''),
            hall: 'reviews', room: 'review-findings', content: request.reason,
            importance: 6, sourceType: 'review', sourceRef: request.run_id,
          });
        } catch { /* memory system not initialized — silently skip */ }
      }
      return { message: `review_submitted: run=${request.run_id} agent=${request.agent_id} outcome=${request.outcome}` };
    }
    case 'input-request': {
      const { claim } = validateProgressCommandInput(
        command('need_input', request, { reason: 'master_input_required' }), loadClaim(stateDir, request.run_id));
      // Not yet started: the caller reports the same timeout a stale request would.
      if (claim.state !== 'in_progress') return { message: 'run is not in progress', active: false };
      const requestId = randomUUID();
      const requestSeq = appendSequencedEvent(stateDir, {
        ts: at, event: 'input_requested', actor_type: 'agent', actor_id: request.agent_id,
        run_id: request.run_id, task_ref: claim.task_ref, agent_id: request.agent_id,
        payload: { question: request.question, request_id: requestId },
      });
      bridgeInputRequest(stateDir, request.run_id, request.agent_id, requestId, request.question);
      return { message: `input_requested: ${request.run_id} (${request.agent_id})`, request_id: requestId, request_seq: requestSeq, active: true };
    }
    case 'input-poll': {
      const response = latestInputResponse(stateDir, request);
      const claim = loadClaim(stateDir, request.run_id);
      const active = isActiveRunClaim(claim, request.agent_id);
      if (response === null && active && request.heartbeat) {
        appendSequencedEvent(stateDir, {
          ts: at, event: 'heartbeat', actor_type: 'agent', actor_id: request.agent_id,
          run_id: request.run_id, task_ref: claim.task_ref, agent_id: request.agent_id,
        }, { lockStrategy: 'none' });
      }
      return { message: response === null ? 'waiting' : 'answered', response, active };
    }
    case 'input-timeout': {
      if (isActiveRunClaim(loadClaim(stateDir, request.run_id), request.agent_id)) {
        finishRun(stateDir, request.run_id, request.agent_id, {
          success: false, failureReason: 'input_request_timeout', failureCode: 'ERR_INPUT_REQUEST_TIMEOUT', policy: 'requeue',
        });
      }
      return { message: `input_request_timeout: ${request.run_id} (${request.agent_id})` };
    }
    case 'memory-record': {
      if (!existsSync(join(stateDir, 'memory.db'))) return { message: 'Memory store not initialized (memory.db not found).' };
      const id = storeDrawer(stateDir, {
        content: request.content,
        wing: request.wing ?? 'general', hall: request.hall ?? 'default', room: request.room ?? 'default',
        ...(request.importance !== undefined ? { importance: request.importance } : {}),
      });
      return { message: `stored: drawer ${id}` };
    }
    case 'report-for-duty': {
      const agent = getAgent(stateDir, request.agent_id);
      if (!agent) throw new Error(`Agent not found: ${request.agent_id}`);
      if (agent.session_token !== request.session_token) throw new Error(`Session id mismatch for ${request.agent_id}`);
      appendSequencedEvent(stateDir, {
        ts: at, event: 'reported_for_duty', actor_type: 'agent', actor_id: request.agent_id, agent_id: request.agent_id,
        payload: { session_token: request.session_token },
      }, { lockStrategy: 'none' });
      updateAgentRuntime(stateDir, request.agent_id, { session_ready_at: at, last_heartbeat_at: at });
      return { message: `reported_for_duty: ${request.agent_id}` };
    }
  }
}

function optionalString(body: Record<string, unknown>, field: string): void {
  if (body[field] !== undefined && body[field] !== null && typeof body[field] !== 'string') {
    throw new ControlError('bad_request', `${field} must be a string`, 400);
  }
}

/** Validate the wire shape of a lifecycle request body. */
export function parseLifecycleRequest(body: Record<string, unknown>): LifecycleRequest {
  const op = body.op as LifecycleOp;
  if (typeof op !== 'string' || !OPS.has(op)) throw new ControlError('bad_request', `Unknown lifecycle op: ${String(body.op)}`, 400);
  const required = [...(op === 'memory-record' ? [] : ['agent_id']), ...(SESSION_OPS.has(op) ? [] : ['run_id']), ...({
    'run-fail': ['reason', 'code', 'policy'], progress: ['event'], 'review-submit': ['outcome', 'reason'],
    'input-request': ['question'], 'input-poll': ['request_id'], 'memory-record': ['content'], 'report-for-duty': ['session_token'],
  } as Partial<Record<LifecycleOp, string[]>>)[op] ?? []];
  for (const field of required) {
    if (typeof body[field] !== 'string' || !body[field]) throw new ControlError('bad_request', `${field} is required`, 400);
  }
  for (const field of ['phase', 'reason', 'policy', 'wing', 'hall', 'room']) optionalString(body, field);
  if (op === 'input-poll' && !Number.isSafeInteger(body.request_seq)) throw new ControlError('bad_request', 'request_seq must be an integer', 400);
  if (op === 'review-submit' && !['approved', 'findings'].includes(body.outcome as string)) {
    throw new ControlError('bad_request', "outcome must be 'approved' or 'findings'", 400);
  }
  if (body.importance !== undefined && !Number.isSafeInteger(body.importance)) throw new ControlError('bad_request', 'importance must be an integer', 400);
  return body as unknown as LifecycleRequest;
}

/**
 * Scope a request to its caller: the authenticated session must not be
 * offline, must belong to the named agent, and — for run ops — be the session
 * launched for that run. The `--agent-id` a worker passes is no longer trusted
 * on its own. A `recoverable` or `unknown` session (one the coordinator cannot
 * type into, or whose process identity it could not confirm after a restart)
 * still reports its lifecycle: the session id it presents is the credential,
 * not its PID.
 */
export function authorizeLifecycle(stateDir: string, credential: string, request: LifecycleRequest): { live: boolean } {
  const session = sessionForCredential(stateDir, credential) ?? undefined;
  const sessionId = session?.session_id;
  // After the merge the coordinator finishes the run and closes its session. The
  // worker's own run-finish may still follow and repeats a finished run as a
  // no-op; a waiting input request learns from its poll that the run ended.
  const live = session !== undefined && session.state !== 'offline';
  const ownRun = session !== undefined && 'run_id' in request && session.run_id === request.run_id;
  const finishing = request.op === 'run-finish' || (request.op === 'progress' && request.event === 'run_finished');
  const endedRunAllowed = ownRun && (request.op === 'input-poll'
    || (finishing && loadClaim(stateDir, request.run_id)?.state === 'done'));
  if (!session || (!live && !endedRunAllowed)) {
    throw new ControlError('unauthenticated', 'Lifecycle caller is not an authenticated running session', 401);
  }
  // A memory belongs to the project, not a run: any running session may record one.
  if (request.op === 'memory-record') return { live };
  if (session.agent_id !== request.agent_id) {
    throw new ControlError('forbidden', `Session belongs to ${session.agent_id}, not ${request.agent_id}`, 403);
  }
  if ('run_id' in request && session.run_id !== request.run_id) {
    throw new ControlError('forbidden', `Session is not scoped to run ${request.run_id}`, 403);
  }
  if (request.op === 'report-for-duty' && request.session_token !== sessionId) {
    throw new ControlError('forbidden', 'report-for-duty must present the caller\'s own session id', 403);
  }
  return { live };
}
