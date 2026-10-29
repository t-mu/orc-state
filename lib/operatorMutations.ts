import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listAgents } from './agentRegistry.ts';
import { syncBacklogFromSpecs } from './backlogSync.ts';
import { setRunInputState } from './claimManager.ts';
import { AGENT_ID_RE, TASK_TYPES } from './constants.ts';
import { describeAutoTargetFailure, selectAutoTarget } from './dispatchPlanner.ts';
import { appendSequencedEvent, queryEvents } from './eventLog.ts';
import { withLock } from './lock.ts';
import { storeDrawer, wingFromTaskRef } from './memoryStore.ts';
import { ControlError } from './controlProtocol.ts';
import { bridgeInputResponse } from './messageBridge.ts';
import { BACKLOG_DOCS_DIR } from './paths.ts';
import { commitBacklog, projectTaskStoreFor } from './projectTasks.ts';
import { commitClaims } from './runStore.ts';
import { sessionForCredential } from './sessionCredentials.ts';
import { findTask, readBacklog, readClaims } from './stateReader.ts';
import { evaluateTaskEligibility, formatRoutingReasons } from './taskRouting.ts';
import type { Claim } from '../types/claims.ts';
import type { Task } from '../types/backlog.ts';

/**
 * Master and operator mutations (task 232): cancel, reset, unblock and
 * delegate a task, and answer a worker's input request. In a registered
 * project the coordinator applies them (POST /v1/operator); the MCP tools
 * and operator CLIs apply them in their own process only in a legacy
 * installation or while no coordinator is running.
 */

/** Task statuses no lifecycle transition leaves (other than an operator reset). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'released', 'cancelled']);

/** The registered master's agent id, the default actor of master tools. */
export function masterActorId(stateDir: string): string {
  return listAgents(stateDir).find((agent) => agent.role === 'master')?.agent_id ?? 'master';
}

/** A legacy installation's Markdown spec directory: colocated with its state, else the configured one. */
export function backlogDocsDirForState(stateDir: string) {
  const colocatedDocsDir = join(stateDir, 'backlog');
  return existsSync(colocatedDocsDir) ? colocatedDocsDir : BACKLOG_DOCS_DIR;
}

/** Read the backlog after registering any new legacy Markdown specs. */
export function readBacklogFresh(stateDir: string, { lockAlreadyHeld = false }: { lockAlreadyHeld?: boolean } = {}) {
  syncBacklogFromSpecs(stateDir, backlogDocsDirForState(stateDir), { lockAlreadyHeld });
  return readBacklog(stateDir);
}

export function delegateTask(stateDir: string, args: Record<string, unknown> = {}) {
  const {
    task_ref,
    target_agent_id,
    task_type = 'implementation',
    note = null,
    actor_id = masterActorId(stateDir),
  } = args;

  if (!task_ref) throw new Error('task_ref is required');
  if (!AGENT_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  if (!TASK_TYPES.includes(task_type as string)) throw new Error(`Invalid task type: ${String(task_type)}`);

  const now = new Date().toISOString();

  return withLock(join(stateDir, '.lock'), () => {
    const backlog = readBacklogFresh(stateDir, { lockAlreadyHeld: true });
    const claims = readClaims(stateDir).claims;
    const allAgents = listAgents(stateDir);
    const actorExists = allAgents.some((agent) => agent.agent_id === actor_id);
    if (actor_id !== 'human' && !actorExists) {
      throw new Error(`Actor agent not found: ${String(actor_id)}. Registered agents: ${allAgents.map((agent) => agent.agent_id).join(', ') || '(none)'}`);
    }

    let task: Task | null = null;
    let featureRef: string | null = null;
    for (const feature of backlog.features) {
      const found = feature.tasks.find((candidate) => candidate.ref === task_ref);
      if (found) {
        task = found;
        featureRef = feature.ref;
        break;
      }
    }
    if (!task) throw new Error(`Task not found: ${typeof task_ref === 'string' ? task_ref : '(unknown)'}`);
    const taskForDiagnostics = { ...task };

    let assignedTarget: string | null = (target_agent_id as string) ?? null;
    if (assignedTarget) {
      const target = allAgents.find((agent) => agent.agent_id === assignedTarget);
      if (!target) throw new Error(`Target agent not found: ${assignedTarget}`);
      const activeClaim = claims.find((claim) =>
        claim.agent_id === assignedTarget && ['claimed', 'in_progress'].includes(claim.state),
      );
      if (activeClaim) {
        throw new Error(`Target agent ${assignedTarget} already has active run ${activeClaim.run_id}`);
      }
      const evaluation = evaluateTaskEligibility({ ...task, task_type: task_type as string | undefined }, target);
      if (!evaluation.eligible) {
        throw new Error(
          `Target agent ${assignedTarget} cannot execute task: ` +
          `${evaluation.reasons.join(', ')} (${formatRoutingReasons(evaluation.reasons).join('; ')})`,
        );
      }
    } else {
      assignedTarget = selectAutoTarget({
        task,
        taskType: task_type as string,
        allAgents,
        claims,
      });
    }

    task.task_type = task_type as Task['task_type'];
    task.planning_state = 'ready_for_dispatch';
    task.delegated_by = actor_id as string;
    if (assignedTarget) {
      task.owner = assignedTarget;
    } else if (task.owner) {
      delete task.owner;
    }
    const unblocked = task.status === 'blocked';
    if (unblocked) task.status = 'todo';
    task.updated_at = now;
    commitBacklog(stateDir, backlog, unblocked ? { [task_ref as string]: { cause: 'unblock', actorId: actor_id as string } } : {});

    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_delegated',
        actor_type: actor_id === 'human' ? 'human' : 'agent',
        actor_id: actor_id as string,
        task_ref: task_ref as string,
        ...(assignedTarget ? { agent_id: assignedTarget } : {}),
        payload: {
          target_agent_id: assignedTarget ?? null,
          task_type,
          note,
          feature_ref: featureRef,
          auto_assigned: !target_agent_id,
        },
      },
      { lockAlreadyHeld: true },
    );

    if (!assignedTarget) {
      return {
        warning: 'no_eligible_worker',
        task_ref,
        message: `No eligible worker for ${typeof task_ref === 'string' ? task_ref : '(unknown)'}; inspect candidate_diagnostics for routing blockers.`,
        candidate_diagnostics: describeAutoTargetFailure({
          task: taskForDiagnostics,
          taskType: task_type as string,
          allAgents,
          claims,
        }),
      };
    }
    return { task_ref, assigned_to: assignedTarget };
  });
}

export function cancelTask(stateDir: string, args: Record<string, unknown> = {}) {
  const {
    task_ref,
    reason = null,
    actor_id = masterActorId(stateDir),
  } = args;

  if (!task_ref) throw new Error('task_ref is required');
  if (reason != null && typeof reason !== 'string') throw new Error('reason must be a string');
  if (!AGENT_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);

  const now = new Date().toISOString();
  let cancelledRuns: Claim[] = [];

  const result = withLock(join(stateDir, '.lock'), () => {
    const backlog = readBacklogFresh(stateDir, { lockAlreadyHeld: true });
    const claimsData = readClaims(stateDir);
    const claims = claimsData.claims;

    if (actor_id !== 'human') {
      const allAgents = listAgents(stateDir);
      const actorExists = allAgents.some((agent) => agent.agent_id === actor_id);
      if (!actorExists) {
        throw new Error(`Actor agent not found: ${String(actor_id)}. Registered agents: ${allAgents.map((agent) => agent.agent_id).join(', ') || '(none)'}`);
      }
    }

    const task = findTask(backlog, task_ref as string);
    if (!task) throw new Error(`Task not found: ${typeof task_ref === 'string' ? task_ref : '(unknown)'}`);

    if (TERMINAL_STATUSES.has(task.status)) {
      return { error: 'already_terminal', task_ref, status: task.status };
    }

    const activeClaims = claims.filter((claim) =>
      claim.task_ref === task_ref && ['claimed', 'in_progress'].includes(claim.state),
    );
    if (activeClaims.length > 0) {
      claimsData.claims = claims.filter((claim) =>
        !(claim.task_ref === task_ref && ['claimed', 'in_progress'].includes(claim.state)),
      );
      cancelledRuns = activeClaims;
      commitClaims(stateDir, claimsData, activeClaims.map((removed) => ({
        ts: now,
        event: 'run_cancelled' as const,
        actor_type: actor_id === 'human' ? 'human' as const : 'agent' as const,
        actor_id: actor_id as string,
        run_id: removed.run_id,
        task_ref: task_ref as string,
        agent_id: removed.agent_id,
        payload: { reason },
      })));
    }

    if (projectTaskStoreFor(stateDir)) {
      // Project SQLite follows the contract: cancellation is its own terminal status.
      task.status = 'cancelled';
      delete task.blocked_reason;
      commitBacklog(stateDir, backlog, { [task_ref as string]: { cause: 'cancel', actorId: actor_id as string, reason: (reason as string | null) ?? null } });
    } else {
      task.status = 'blocked';
      task.updated_at = now;
      task.blocked_reason = (reason as string | null) ?? 'cancelled';
      commitBacklog(stateDir, backlog);
    }

    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_cancelled',
        actor_type: actor_id === 'human' ? 'human' : 'agent',
        actor_id: actor_id as string,
        task_ref: task_ref as string,
        ...(cancelledRuns[0] ? { run_id: cancelledRuns[0].run_id, agent_id: cancelledRuns[0].agent_id } : {}),
        payload: {
          reason,
          had_active_run: cancelledRuns.length > 0,
        },
      },
      { lockAlreadyHeld: true },
    );

    return {
      cancelled: true,
      task_ref,
      status: task.status,
      ...(cancelledRuns[0]
        ? {
            cancelled_run_id: cancelledRuns[0].run_id,
            cancelled_run_count: cancelledRuns.length,
          }
        : {}),
    };
  });

  return result;
}

/** Reset a task to todo from any status, failing its active runs (an operator recovery). */
export function resetTask(stateDir: string, { task_ref, actor_id = 'human' }: Record<string, unknown> = {}) {
  if (!task_ref) throw new Error('task_ref is required');
  if (typeof actor_id !== 'string' || !AGENT_ID_RE.test(actor_id)) {
    throw new Error(`Invalid actor_id: ${typeof actor_id === 'string' ? actor_id : '(unknown)'}`);
  }

  return withLock(join(stateDir, '.lock'), () => {
    const now = new Date().toISOString();

    const backlog = readBacklogFresh(stateDir, { lockAlreadyHeld: true });
    const task = findTask(backlog, task_ref as string);
    if (!task) throw new Error(`task not found: ${typeof task_ref === 'string' ? task_ref : '(unknown)'}`);

    const previousStatus = task.status;
    task.status = 'todo';
    delete task.blocked_reason;
    delete task.requeue_eligible_after;
    task.updated_at = now;

    const claimsState = readClaims(stateDir);
    const activeClaims = claimsState.claims.filter(
      (c) => c.task_ref === task_ref && (c.state === 'claimed' || c.state === 'in_progress'),
    );

    for (const c of activeClaims) {
      c.state = 'failed';
      c.failure_reason = 'manual_reset';
      c.finished_at = now;
    }

    commitClaims(stateDir, claimsState, [{
      ts: now,
      event: 'task_updated',
      actor_type: actor_id === 'human' ? 'human' : 'agent',
      actor_id,
      task_ref: task_ref as string,
      payload: { reset: true, previous_status: previousStatus, status: 'todo' },
    }, ...activeClaims.map((claim) => ({
      ts: now, event: 'run_cancelled' as const, actor_type: actor_id === 'human' ? 'human' as const : 'agent' as const, actor_id,
      run_id: claim.run_id, task_ref: claim.task_ref, agent_id: claim.agent_id,
      payload: { reason: 'manual_reset' },
    }))]);
    commitBacklog(stateDir, backlog, previousStatus === 'todo' ? {} : { [task_ref as string]: { cause: 'operator_reset', actorId: actor_id } });

    return {
      reset: true,
      task_ref,
      previous_status: previousStatus,
      cancelled_claims: activeClaims.length,
    };
  });
}

/** Return a blocked task to todo (an operator recovery). */
export function unblockTask(stateDir: string, { task_ref, reason = null, actor_id = 'human' }: Record<string, unknown> = {}) {
  if (!task_ref || typeof task_ref !== 'string') throw new Error('task_ref is required');
  if (reason != null && typeof reason !== 'string') throw new Error('reason must be a string');
  if (typeof actor_id !== 'string' || !AGENT_ID_RE.test(actor_id)) throw new Error(`Invalid actor_id: ${String(actor_id)}`);

  return withLock(join(stateDir, '.lock'), () => {
    const now = new Date().toISOString();
    const backlog = readBacklog(stateDir);
    const task = findTask(backlog, task_ref);
    if (!task) throw new Error(`task not found: ${task_ref}`);
    if (task.status !== 'blocked') throw new Error(`task is not blocked (status: ${task.status}): ${task_ref}`);

    task.status = 'todo';
    delete task.blocked_reason;
    task.updated_at = now;
    commitBacklog(stateDir, backlog, { [task_ref]: { cause: 'unblock', actorId: actor_id, reason: (reason as string | null) ?? null } });

    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_updated',
        actor_type: actor_id === 'human' ? 'human' : 'agent',
        actor_id,
        task_ref,
        payload: { status: 'todo', previous_status: 'blocked', unblocked: true, ...(reason ? { reason } : {}) },
      },
      { lockAlreadyHeld: true },
    );
    return { unblocked: true, task_ref };
  });
}

/**
 * Answer a worker's input request. `authority` is how the caller proved it may
 * answer: the coordinator and the master's own tools are trusted; a direct
 * operator call must name the running master session.
 */
export function respondInput(stateDir: string, { run_id, agent_id, response, actor_id, request_id, record_memory = false }: Record<string, unknown> = {},
  authority: { sessionId?: string | null; trustedMaster?: boolean } = { trustedMaster: true }) {
  if (!run_id) throw new Error('run_id is required');
  if (!agent_id) throw new Error('agent_id is required');
  if (typeof response !== 'string' || (response).length === 0) {
    throw new Error('response is required');
  }

  const effectiveActorId = (actor_id as string) ?? masterActorId(stateDir);
  if (!AGENT_ID_RE.test(effectiveActorId)) {
    throw new Error('actor_id must be a valid agent id');
  }

  if (request_id != null && typeof request_id !== 'string') throw new Error('request_id must be a string');
  const inputRequests = queryEvents(stateDir, {
    event_type: 'input_requested',
    run_id: run_id as string,
    agent_id: agent_id as string,
  });
  const latestRequest = (request_id
    ? [...inputRequests].reverse().find((event) => (event.payload as Record<string, unknown> | undefined)?.request_id === request_id)
    : inputRequests.at(-1)) as unknown as Record<string, unknown> | undefined ?? null;
  const latestRequestId = request_id ?? (latestRequest?.payload as Record<string, unknown> | undefined)?.request_id;
  const messageId = bridgeInputResponse(stateDir, run_id as string, agent_id as string, response,
    typeof latestRequestId === 'string' ? latestRequestId : null, authority);
  if (request_id && !messageId) throw new Error('Input request is not pending for this run');
  // Nothing to answer: an unknown run, or one that never asked. A run that asked and then ended keeps the event-only answer.
  if (!messageId && !latestRequest) throw new Error('Input request is not pending for this run');

  try {
    setRunInputState(stateDir, run_id as string, agent_id as string, { inputState: null });
  } catch {
    // Allow master replies to be recorded even if the claim just completed.
  }

  appendSequencedEvent(stateDir, {
    ts: new Date().toISOString(),
    event: 'input_response',
    actor_type: effectiveActorId === 'human' ? 'human' : 'agent',
    actor_id: effectiveActorId,
    run_id: run_id as string,
    task_ref: latestRequest?.task_ref as string | undefined,
    agent_id: agent_id as string,
    payload: {
      response,
      question: (latestRequest?.payload as Record<string, unknown> | undefined)?.question ?? null,
      request_id: typeof latestRequestId === 'string' ? latestRequestId : null,
      message_id: messageId,
    },
  } as import('../types/events.ts').OrcEventInput);

  if (record_memory) {
    const question = (latestRequest?.payload as Record<string, unknown> | undefined)?.question;
    try {
      storeDrawer(stateDir, {
        wing: wingFromTaskRef((latestRequest?.task_ref as string | undefined) ?? ''),
        hall: 'decisions', room: 'master-input',
        content: `Q: ${typeof question === 'string' ? question : '(unknown)'}\nA: ${response}`,
        importance: 7, sourceType: 'event', sourceRef: run_id as string,
      });
    } catch { /* memory system not initialized — silently skip */ }
  }

  return {
    ok: true,
    run_id,
    agent_id,
    responded_by: effectiveActorId,
  };
}

export type OperatorOp = 'cancel-task' | 'reset-task' | 'unblock-task' | 'delegate-task' | 'respond-input';

/** A master or operator mutation sent to the coordinator: `op` plus the same arguments as the MCP tool. */
export type OperatorRequest = { op: OperatorOp; actor_id?: string } & Record<string, unknown>;

const OPERATOR_OPS: Readonly<Record<OperatorOp, readonly string[]>> = {
  'cancel-task': ['task_ref', 'reason'],
  'reset-task': ['task_ref'],
  'unblock-task': ['task_ref', 'reason'],
  'delegate-task': ['task_ref', 'target_agent_id', 'task_type', 'note'],
  'respond-input': ['run_id', 'agent_id', 'response', 'request_id', 'record_memory'],
};

export function parseOperatorRequest(body: Record<string, unknown>): OperatorRequest {
  const op = body.op as OperatorOp;
  const fields = OPERATOR_OPS[op];
  if (!fields) throw new ControlError('bad_request', `Unknown operator op: ${String(body.op)}`, 400);
  const unknown = Object.keys(body).filter((key) => key !== 'op' && key !== 'actor_id' && !fields.includes(key));
  if (unknown.length > 0) throw new ControlError('bad_request', `Unknown field(s) for ${op}: ${unknown.join(', ')}`, 400);
  if (body.actor_id !== undefined && (typeof body.actor_id !== 'string' || !AGENT_ID_RE.test(body.actor_id))) {
    throw new ControlError('bad_request', `Invalid actor_id: ${JSON.stringify(body.actor_id)}`, 400);
  }
  return body as OperatorRequest;
}

/**
 * Who may send an operator mutation, and as whom it is recorded.
 * - A session credential must be the master's (not `offline`), and the
 *   mutation is recorded as the master; a worker or scout session is refused,
 *   so a worker shell's `orc task-reset` fails instead of acting as operator.
 * - A caller without a session must present the operator token the
 *   coordinator writes on every start (task 231); it is recorded as `human`
 *   or a registered agent it names.
 * - Answering an input request needs the master session, as it always has.
 */
/** The master agent a live session credential belongs to; any other session is refused. */
export function masterForCredential(stateDir: string, credential: string): string {
  const resolved = sessionForCredential(stateDir, credential);
  const session = resolved && resolved.state !== 'offline' ? resolved : undefined;
  if (!session) throw new ControlError('unauthenticated', 'Operator caller is not authenticated', 401);
  const agent = listAgents(stateDir).find((entry) => entry.agent_id === session.agent_id);
  if (agent?.role !== 'master') throw new ControlError('forbidden', 'Only the master session or an operator may send operator mutations', 403);
  return agent.agent_id;
}

export function authorizeOperator(stateDir: string, caller: { credential: string | null; operator: boolean }, request: OperatorRequest): { actorId: string } {
  const { credential } = caller;
  if (credential !== null) {
    const masterId = masterForCredential(stateDir, credential);
    if (request.actor_id !== undefined && request.actor_id !== masterId) {
      throw new ControlError('forbidden', `A master session acts as ${masterId}, not ${request.actor_id}`, 403);
    }
    return { actorId: masterId };
  }
  if (!caller.operator) throw new ControlError('unauthenticated', 'Operator mutations need a session credential or operator intent', 401);
  if (request.op === 'respond-input') throw new ControlError('forbidden', 'Input response requires a running master session', 403);
  const actorId = request.actor_id ?? 'human';
  if (actorId !== 'human' && !listAgents(stateDir).some((entry) => entry.agent_id === actorId)) {
    throw new ControlError('bad_request', `Actor agent not found: ${actorId}`, 400);
  }
  return { actorId };
}

/** Apply an authorized operator mutation; the coordinator calls this, as does a direct fallback. */
export function applyOperatorMutation(stateDir: string, request: OperatorRequest,
  authority: { sessionId?: string | null; trustedMaster?: boolean } = { trustedMaster: true }): Record<string, unknown> {
  const { op, ...args } = request;
  switch (op) {
    case 'cancel-task': return cancelTask(stateDir, args) as Record<string, unknown>;
    case 'reset-task': return resetTask(stateDir, args);
    case 'unblock-task': return unblockTask(stateDir, args);
    case 'delegate-task': return delegateTask(stateDir, args) as Record<string, unknown>;
    case 'respond-input': return respondInput(stateDir, args, authority);
  }
}
