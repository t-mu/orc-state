import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { describeAutoTargetFailure, selectAutoTarget } from '../lib/dispatchPlanner.ts';
import { appendSequencedEvent, readRecentEvents } from '../lib/eventLog.ts';
import { listAgents } from '../lib/agentRegistry.ts';
import { withLock } from '../lib/lock.ts';
import { appendNotification, readPendingNotifications } from '../lib/masterNotifyQueue.ts';
import { setRunInputState } from '../lib/claimManager.ts';
import { findTask, getNextTaskSeq, readBacklog, readClaims } from '../lib/stateReader.ts';
import { evaluateTaskEligibility, formatRoutingReasons } from '../lib/taskRouting.ts';
import type { Claim } from '../types/claims.ts';
import type { Task } from '../types/backlog.ts';

const TASK_STATUSES = new Set(['todo', 'claimed', 'in_progress', 'done', 'blocked', 'released']);
const AGENT_ROLES = new Set(['worker', 'reviewer', 'master']);
const TASK_TYPES = new Set(['implementation', 'refactor']);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'critical']);
const ACTOR_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function assertStringArray(value: unknown, field: string) {
  if (value == null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
}

function defaultActorId(stateDir: string) {
  return listAgents(stateDir).find((agent) => agent.role === 'master')?.agent_id ?? 'master';
}

// `next_task_seq` always means "the next available numeric sequence from this state snapshot".
// Before create_task mutates backlog.json, it is the number to consume next.
// After create_task commits, it becomes the next number after the task just created.

// Fields returned by list_tasks (summary view). Use get_task() for full detail.
const TERMINAL_STATUSES = new Set(['done', 'released']);

function toTaskSummary(task: Task & { epic_ref: string }) {
  return {
    ref: task.ref,
    title: task.title,
    status: task.status,
    epic_ref: task.epic_ref,
    task_type: task.task_type,
    priority: task.priority ?? 'normal',
    owner: task.owner,
    depends_on: task.depends_on,
  };
}

export function handleListTasks(stateDir: string, { status, epic }: { status?: unknown; epic?: unknown } = {}) {
  if (status != null && !TASK_STATUSES.has(status as string)) {
    throw new Error(`Invalid status: ${typeof status === 'string' ? status : '(unknown)'}`);
  }
  if (epic != null && typeof epic !== 'string') {
    throw new Error('epic must be a string');
  }
  const backlog = readBacklog(stateDir);
  let tasks = backlog.epics.flatMap((epicObj) =>
    epicObj.tasks.map((task): Task & { epic_ref: string } => ({ ...task, epic_ref: epicObj.ref })),
  );

  if (status) {
    tasks = tasks.filter((task) => task.status === status);
  } else {
    // Exclude terminal statuses by default to keep payload small.
    // Use status="done" or status="released" to retrieve those explicitly.
    tasks = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
  }
  if (epic) tasks = tasks.filter((task) => task.epic_ref === epic);

  // Return summary fields only. Full task detail (description, acceptance_criteria, etc.)
  // is available via get_task(task_ref).
  return tasks.map(toTaskSummary);
}

export function handleListAgents(stateDir: string, { role, include_dead = false }: { role?: unknown; include_dead?: unknown } = {}) {
  if (role != null && !AGENT_ROLES.has(role as string)) {
    throw new Error(`Invalid role: ${typeof role === 'string' ? role : '(unknown)'}`);
  }
  if (typeof include_dead !== 'boolean') {
    throw new Error('include_dead must be a boolean');
  }
  let agents = listAgents(stateDir);
  if (!include_dead) agents = agents.filter((agent) => agent.status !== 'dead');
  if (role) agents = agents.filter((agent) => agent.role === role);
  const claims = readClaims(stateDir).claims;
  const activeClaimsByAgent = new Map<string, string | null>();
  for (const claim of claims) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;
    if (!activeClaimsByAgent.has(claim.agent_id)) {
      activeClaimsByAgent.set(claim.agent_id, claim.task_ref ?? null);
    }
  }
  return agents.map((agent) => ({
    ...agent,
    active_task_ref: activeClaimsByAgent.get(agent.agent_id) ?? null,
  }));
}

export function handleListActiveRuns(stateDir: string) {
  return readClaims(stateDir).claims.filter((claim) =>
    ['claimed', 'in_progress'].includes(claim.state),
  );
}

export function handleListStalledRuns(stateDir: string, { stale_after_ms = 600_000, now_ms }: { stale_after_ms?: unknown; now_ms?: unknown } = {}) {
  if (!Number.isInteger(stale_after_ms) || (stale_after_ms as number) < 0) {
    throw new Error('stale_after_ms must be a non-negative integer');
  }
  const now = (now_ms as number) ?? Date.now();
  return readClaims(stateDir).claims
    .filter((claim) => ['claimed', 'in_progress'].includes(claim.state))
    .filter((claim) => {
      const timestamp = claim.last_heartbeat_at ?? claim.claimed_at;
      return (now - new Date(timestamp).getTime()) > (stale_after_ms as number);
    })
    .map((claim) => ({
      ...claim,
      stale_for_ms: now - new Date((claim.last_heartbeat_at ?? claim.claimed_at)).getTime(),
    }));
}

export function handleGetTask(stateDir: string, { task_ref }: { task_ref?: unknown } = {}) {
  if (!task_ref) throw new Error('task_ref is required');
  const backlog = readBacklog(stateDir);
  const task = findTask(backlog, task_ref as string);
  if (!task) return { error: 'not_found', task_ref };
  return task;
}

export function handleGetRecentEvents(stateDir: string, { limit = 50 }: { limit?: unknown } = {}) {
  if (!Number.isInteger(limit) || (limit as number) < 0) {
    throw new Error('limit must be a non-negative integer');
  }
  const cap = Math.min(limit as number, 200);
  if (cap === 0) return [];
  return readRecentEvents(join(stateDir, 'events.jsonl'), cap);
}

export function handleGetStatus(stateDir: string, { include_done_count = false }: { include_done_count?: unknown } = {}) {
  if (typeof include_done_count !== 'boolean') {
    throw new Error('include_done_count must be a boolean');
  }

  const backlog = readBacklog(stateDir);
  const claims = readClaims(stateDir).claims;
  const agents = listAgents(stateDir).filter((agent) => agent.status !== 'dead');

  const activeClaimsByAgent = new Map<string, string | null>();
  for (const claim of claims) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;
    if (!activeClaimsByAgent.has(claim.agent_id)) {
      activeClaimsByAgent.set(claim.agent_id, claim.task_ref ?? null);
    }
  }

  const taskCounts: Record<string, number> = {
    todo: 0,
    claimed: 0,
    in_progress: 0,
    blocked: 0,
  };

  if (include_done_count) {
    taskCounts.done = 0;
    taskCounts.released = 0;
  }

  const activeTasks: Array<{ ref: string; title: string; status: string; epic_ref: string; owner: string | null }> = [];
  for (const epic of backlog.epics) {
    for (const task of epic.tasks) {
      if (Object.hasOwn(taskCounts, task.status)) {
        taskCounts[task.status] += 1;
      }
      if (task.status === 'done' || task.status === 'released') continue;
      activeTasks.push({
        ref: task.ref,
        title: task.title,
        status: task.status,
        epic_ref: epic.ref,
        owner: task.owner ?? null,
      });
    }
  }

  return {
    agents: agents.map((agent) => ({
      agent_id: agent.agent_id,
      role: agent.role ?? null,
      status: agent.status,
      provider: agent.provider,
      active_task_ref: activeClaimsByAgent.get(agent.agent_id) ?? null,
    })),
    task_counts: taskCounts,
    active_tasks: activeTasks,
    pending_notifications: readPendingNotifications(stateDir).length,
    stalled_runs: handleListStalledRuns(stateDir).length,
    next_task_seq: getNextTaskSeq(backlog),
  };
}

export function handleGetAgentWorkview(stateDir: string, { agent_id }: { agent_id?: unknown } = {}) {
  if (!agent_id) throw new Error('agent_id is required');

  const backlog = readBacklog(stateDir);
  const claims = readClaims(stateDir).claims;
  const agents = listAgents(stateDir);
  const agent = agents.find((entry) => entry.agent_id === agent_id);
  if (!agent) return { error: 'not_found', agent_id };

  const activeRun = claims.find((claim) =>
    claim.agent_id === agent_id && ['claimed', 'in_progress'].includes(claim.state),
  ) ?? null;

  const doneSet = new Set(
    backlog.epics.flatMap((epic) =>
      epic.tasks
        .filter((task) => task.status === 'done' || task.status === 'released')
        .map((task) => task.ref),
    ),
  );

  const queuedTasks: Array<{ ref: string; title: string; status: string; task_type: string; blockers: string[] }> = [];
  for (const epic of backlog.epics) {
    for (const task of epic.tasks) {
      if (task.owner !== agent_id) continue;
      if (task.status === 'done' || task.status === 'released') continue;
      if (activeRun?.task_ref === task.ref) continue;

      const blockers: string[] = [];
      if (task.status !== 'todo') blockers.push(`status:${task.status}`);
      if (task.planning_state && task.planning_state !== 'ready_for_dispatch') {
        blockers.push(`planning_state:${task.planning_state}`);
      }
      const unmetDependencies = (task.depends_on ?? []).filter((dep) => !doneSet.has(dep));
      blockers.push(...unmetDependencies.map((dep) => `dependency_not_done:${dep}`));
      blockers.push(...evaluateTaskEligibility(task, agent).reasons);

      queuedTasks.push({
        ref: task.ref,
        title: task.title,
        status: task.status,
        task_type: task.task_type ?? 'implementation',
        blockers,
      });
    }
  }

  let recommendedAction = 'idle';
  if (activeRun?.state === 'claimed') recommendedAction = 'start_run';
  else if (activeRun?.state === 'in_progress') recommendedAction = 'heartbeat';
  else if (queuedTasks.some((task) => task.blockers.length === 0)) recommendedAction = 'start_run';

  const blockers = queuedTasks.flatMap((task) => task.blockers.map((reason) => `${task.ref}:${reason}`));

  return {
    agent_id,
    agent: {
      agent_id: agent.agent_id,
      role: agent.role ?? null,
      status: agent.status,
      provider: agent.provider,
    },
    active_run: activeRun
      ? {
          run_id: activeRun.run_id,
          task_ref: activeRun.task_ref,
          state: activeRun.state,
          last_heartbeat_at: activeRun.last_heartbeat_at ?? null,
        }
      : null,
    queued_tasks: queuedTasks,
    blockers,
    recommended_action: recommendedAction,
  };
}

export function handleReadBacklog(stateDir: string) {
  return readFileSync(join(stateDir, 'backlog.json'), 'utf8');
}

export function handleReadAgents(stateDir: string) {
  return readFileSync(join(stateDir, 'agents.json'), 'utf8');
}

export function handleCreateTask(stateDir: string, args: Record<string, unknown> = {}) {
  const {
    epic,
    title,
    ref,
    task_type = 'implementation',
    priority = 'normal',
    description,
    acceptance_criteria,
    depends_on,
    required_capabilities,
    owner,
    actor_id = defaultActorId(stateDir),
  } = args;

  const resolvedEpic = typeof epic === 'string' && (epic).trim().length > 0 ? epic : 'general';
  if (!title) throw new Error('title is required');
  if (!TASK_TYPES.has(task_type as string)) throw new Error(`Invalid task_type: ${String(task_type)}`);
  if (!TASK_PRIORITIES.has(priority as string)) throw new Error(`Invalid priority: ${String(priority)}`);
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  if (owner && !ACTOR_ID_RE.test(owner as string)) throw new Error(`Invalid owner: ${typeof owner === 'string' ? owner : '(unknown)'}. Must match ^[a-z0-9][a-z0-9-]*$.`);

  assertStringArray(acceptance_criteria, 'acceptance_criteria');
  assertStringArray(depends_on, 'depends_on');
  assertStringArray(required_capabilities, 'required_capabilities');

  const now = new Date().toISOString();
  const taskSlug = (ref as string) ?? slugify(title as string);
  const taskRef = `${resolvedEpic}/${taskSlug}`;
  if (!taskSlug || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(taskRef)) {
    throw new Error(`Invalid task ref: ${taskRef}`);
  }

  return withLock(join(stateDir, '.lock'), () => {
    if (actor_id !== 'human') {
      const allAgents = listAgents(stateDir);
      const actorExists = allAgents.some((agent) => agent.agent_id === actor_id);
      if (!actorExists) {
        throw new Error(`Actor agent not found: ${String(actor_id)}. Registered agents: ${allAgents.map((agent) => agent.agent_id).join(', ') || '(none)'}`);
      }
    }

    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readBacklog(stateDir);
    const currentNextTaskSeq = getNextTaskSeq(backlog);

    if (resolvedEpic === 'general' && !backlog.epics.some((candidate) => candidate.ref === 'general')) {
      backlog.epics = [...backlog.epics, { ref: 'general', title: 'General', tasks: [] }];
    }

    const epicObj = backlog.epics.find((candidate) => candidate.ref === resolvedEpic);
    if (!epicObj) throw new Error(`Epic not found: ${resolvedEpic}`);

    const existing = epicObj.tasks.find((task) => task.ref === taskRef);
    if (existing) throw new Error(`Task already exists: ${taskRef}`);

    if (((depends_on ?? []) as unknown[]).length > 0) {
      const allRefs = new Set(backlog.epics.flatMap((candidate) => candidate.tasks.map((task) => task.ref)));
      for (const dep of depends_on as string[]) {
        if (!allRefs.has(dep)) throw new Error(`depends_on task_ref not found in backlog: ${dep}`);
      }
    }

    const newTask: Task = {
      ref: taskRef,
      title: title as string,
      status: 'todo',
      task_type: task_type as Task['task_type'],
      priority: priority as Task['priority'],
      planning_state: 'ready_for_dispatch',
      delegated_by: actor_id as string,
      depends_on: (depends_on as string[] | undefined) ?? [],
      acceptance_criteria: (acceptance_criteria as string[] | undefined) ?? [],
      required_capabilities: (required_capabilities as string[] | undefined) ?? [],
      created_at: now,
      updated_at: now,
    };
    if (description) newTask.description = description as string;
    if (owner) newTask.owner = owner as string;

    if ((newTask.depends_on?.length ?? 0) === 0) delete newTask.depends_on;
    if ((newTask.acceptance_criteria?.length ?? 0) === 0) delete newTask.acceptance_criteria;
    if ((newTask.required_capabilities?.length ?? 0) === 0) delete newTask.required_capabilities;

    epicObj.tasks = [...epicObj.tasks, newTask];
    backlog.next_task_seq = currentNextTaskSeq + 1;
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_added',
        actor_type: actor_id === 'human' ? 'human' : 'agent',
        actor_id: actor_id as string,
        task_ref: taskRef,
        payload: { title, task_type, epic_ref: resolvedEpic },
      },
      { lockAlreadyHeld: true },
    );
    // Return the post-write value so callers can immediately see the next available sequence.
    return { ...newTask, next_task_seq: backlog.next_task_seq };
  });
}

export function handleUpdateTask(stateDir: string, args: Record<string, unknown> = {}) {
  const {
    task_ref,
    title,
    description,
    priority,
    acceptance_criteria,
    depends_on,
    actor_id = defaultActorId(stateDir),
  } = args;

  if (!task_ref) throw new Error('task_ref is required');
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor_id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  assertStringArray(acceptance_criteria, 'acceptance_criteria');
  assertStringArray(depends_on, 'depends_on');
  if (priority !== undefined && !TASK_PRIORITIES.has(priority as string)) {
    throw new Error(`Invalid priority: ${typeof priority === 'string' ? priority : '(unknown)'}`);
  }

  const now = new Date().toISOString();
  const changedFields: string[] = [];

  return withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readBacklog(stateDir);
    const task = findTask(backlog, task_ref as string);
    if (!task) throw new Error(`Task not found: ${typeof task_ref === 'string' ? task_ref : '(unknown)'}`);

    if (title !== undefined) {
      task.title = title as string;
      changedFields.push('title');
    }
    if (description !== undefined) {
      task.description = description as string;
      changedFields.push('description');
    }
    if (priority !== undefined) {
      task.priority = priority as Task['priority'];
      changedFields.push('priority');
    }
    if (acceptance_criteria !== undefined) {
      task.acceptance_criteria = acceptance_criteria as string[];
      changedFields.push('acceptance_criteria');
    }
    if (depends_on !== undefined) {
      task.depends_on = depends_on as string[];
      changedFields.push('depends_on');
    }

    task.updated_at = now;
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_updated',
        actor_type: actor_id === 'human' ? 'human' : 'agent',
        actor_id: actor_id as string,
        task_ref: task_ref as string,
        payload: { status: task.status, fields: changedFields },
      },
      { lockAlreadyHeld: true },
    );

    return task;
  });
}

export function handleDelegateTask(stateDir: string, args: Record<string, unknown> = {}) {
  const {
    task_ref,
    target_agent_id,
    task_type = 'implementation',
    note = null,
    actor_id = defaultActorId(stateDir),
  } = args;

  if (!task_ref) throw new Error('task_ref is required');
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  if (!TASK_TYPES.has(task_type as string)) throw new Error(`Invalid task type: ${String(task_type)}`);

  const now = new Date().toISOString();

  return withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readBacklog(stateDir);
    const claims = readClaims(stateDir).claims;
    const allAgents = listAgents(stateDir);
    const actorExists = allAgents.some((agent) => agent.agent_id === actor_id);
    if (actor_id !== 'human' && !actorExists) {
      throw new Error(`Actor agent not found: ${String(actor_id)}. Registered agents: ${allAgents.map((agent) => agent.agent_id).join(', ') || '(none)'}`);
    }

    let task: Task | null = null;
    let epicRef: string | null = null;
    for (const epic of backlog.epics) {
      const found = epic.tasks.find((candidate) => candidate.ref === task_ref);
      if (found) {
        task = found;
        epicRef = epic.ref;
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
        stateDir,
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
    if (task.status === 'blocked') task.status = 'todo';
    task.updated_at = now;
    atomicWriteJson(backlogPath, backlog);

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
          epic_ref: epicRef,
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

export function handleCancelTask(stateDir: string, args: Record<string, unknown> = {}) {
  const {
    task_ref,
    reason = null,
    actor_id = defaultActorId(stateDir),
  } = args;

  if (!task_ref) throw new Error('task_ref is required');
  if (reason != null && typeof reason !== 'string') throw new Error('reason must be a string');
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);

  const now = new Date().toISOString();
  let cancelledRuns: Claim[] = [];

  const result = withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const claimsPath = join(stateDir, 'claims.json');
    const backlog = readBacklog(stateDir);
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

    if (task.status === 'done' || task.status === 'released') {
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
      atomicWriteJson(claimsPath, claimsData);
      for (const removed of activeClaims) {
        appendSequencedEvent(
          stateDir,
          {
            ts: now,
            event: 'run_cancelled',
            actor_type: actor_id === 'human' ? 'human' : 'agent',
            actor_id: actor_id as string,
            run_id: removed.run_id,
            task_ref: task_ref as string,
            agent_id: removed.agent_id,
            payload: { reason },
          },
          { lockAlreadyHeld: true },
        );
      }
    }

    task.status = 'blocked';
    task.updated_at = now;
    task.blocked_reason = (reason as string | null) ?? 'cancelled';
    atomicWriteJson(backlogPath, backlog);

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

  for (const cancelledRun of cancelledRuns) {
    const deposited = appendNotification(stateDir, {
      type: 'TASK_COMPLETE',
      task_ref,
      agent_id: cancelledRun.agent_id,
      success: false,
      finished_at: now,
    });
    if (!deposited) {
      console.warn(`[mcp] WARNING: failed to deposit cancellation notification for ${typeof task_ref === 'string' ? task_ref : '(unknown)'} (${cancelledRun.run_id})`);
    }
  }

  return result;
}

export function handleRespondInput(stateDir: string, { run_id, agent_id, response, actor_id }: Record<string, unknown> = {}) {
  if (!run_id) throw new Error('run_id is required');
  if (!agent_id) throw new Error('agent_id is required');
  if (typeof response !== 'string' || (response).length === 0) {
    throw new Error('response is required');
  }

  const effectiveActorId = (actor_id as string) ?? defaultActorId(stateDir);
  if (!ACTOR_ID_RE.test(effectiveActorId)) {
    throw new Error('actor_id must be a valid agent id');
  }

  const rawEvents = readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim();
  const latestRequest = rawEvents
    ? rawEvents.split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .reverse()
      .find((event: Record<string, unknown>) =>
        event.event === 'input_requested'
        && event.run_id === run_id
        && event.agent_id === agent_id
        && typeof (event.payload as Record<string, unknown>)?.question === 'string')
    : null;

  try {
    setRunInputState(stateDir, run_id as string, agent_id as string, { inputState: null });
  } catch {
    // Allow master replies to be recorded even if the claim just completed.
  }

  appendSequencedEvent(stateDir, {
    ts: new Date().toISOString(),
    event: 'input_response',
    actor_type: 'agent',
    actor_id: effectiveActorId,
    run_id: run_id as string,
    task_ref: latestRequest?.task_ref as string | undefined,
    agent_id: agent_id as string,
    payload: {
      response,
      question: (latestRequest?.payload as Record<string, unknown> | undefined)?.question ?? null,
    },
  } as import('../types/events.ts').OrcEventInput);

  return {
    ok: true,
    run_id,
    agent_id,
    responded_by: effectiveActorId,
  };
}
