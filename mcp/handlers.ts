import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { describeAutoTargetFailure, selectAutoTarget } from '../lib/dispatchPlanner.ts';
import { appendSequencedEvent, readRecentEvents } from '../lib/eventLog.ts';
import { listAgents } from '../lib/agentRegistry.ts';
import { withLock } from '../lib/lock.ts';
import { appendNotification } from '../lib/masterNotifyQueue.ts';
import { readPendingNotifications } from '../lib/masterNotifyQueue.ts';
import { setRunInputState } from '../lib/claimManager.ts';
import { findTask, getNextTaskSeq, readClaims, readJson } from '../lib/stateReader.ts';
import { canAgentExecuteTask, evaluateTaskEligibility, formatRoutingReasons } from '../lib/taskRouting.ts';

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
  const master = listAgents(stateDir).find((agent) => (agent as unknown as Record<string, unknown>).role === 'master');
  return (master as Record<string, unknown> | undefined)?.agent_id ?? 'master';
}

// `next_task_seq` always means "the next available numeric sequence from this state snapshot".
// Before create_task mutates backlog.json, it is the number to consume next.
// After create_task commits, it becomes the next number after the task just created.

// Fields returned by list_tasks (summary view). Use get_task() for full detail.
const LIST_TASK_FIELDS = new Set(['ref', 'title', 'status', 'epic_ref', 'task_type', 'priority', 'owner', 'depends_on']);
const TERMINAL_STATUSES = new Set(['done', 'released']);

function toTaskSummary(task: Record<string, unknown>) {
  const summary = Object.fromEntries(Object.entries(task).filter(([k]) => LIST_TASK_FIELDS.has(k)));
  summary.priority = task.priority ?? 'normal';
  return summary;
}

export function handleListTasks(stateDir: string, { status, epic }: { status?: unknown; epic?: unknown } = {}) {
  if (status != null && !TASK_STATUSES.has(status as string)) {
    throw new Error(`Invalid status: ${String(status)}`);
  }
  if (epic != null && typeof epic !== 'string') {
    throw new Error('epic must be a string');
  }
  const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
  let tasks: Array<Record<string, unknown>> = ((backlog.epics ?? []) as unknown as Array<Record<string, unknown>>).flatMap((epicObj) =>
    ((epicObj.tasks ?? []) as unknown as Array<Record<string, unknown>>).map((task): Record<string, unknown> => ({ ...task, epic_ref: epicObj.ref })),
  );

  if (status) {
    tasks = tasks.filter((task) => task.status === status);
  } else {
    // Exclude terminal statuses by default to keep payload small.
    // Use status="done" or status="released" to retrieve those explicitly.
    tasks = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status as string));
  }
  if (epic) tasks = tasks.filter((task) => task.epic_ref === epic);

  // Return summary fields only. Full task detail (description, acceptance_criteria, etc.)
  // is available via get_task(task_ref).
  return tasks.map(toTaskSummary);
}

export function handleListAgents(stateDir: string, { role, include_dead = false }: { role?: unknown; include_dead?: unknown } = {}) {
  if (role != null && !AGENT_ROLES.has(role as string)) {
    throw new Error(`Invalid role: ${String(role)}`);
  }
  if (typeof include_dead !== 'boolean') {
    throw new Error('include_dead must be a boolean');
  }
  let agents = listAgents(stateDir);
  if (!include_dead) agents = agents.filter((agent) => (agent as unknown as Record<string, unknown>).status !== 'dead');
  if (role) agents = agents.filter((agent) => (agent as unknown as Record<string, unknown>).role === role);
  const activeClaimsByAgent = new Map<string, string | null>();
  for (const claim of (readClaims(stateDir).claims ?? []) as unknown as Array<Record<string, unknown>>) {
    if (!['claimed', 'in_progress'].includes(claim.state as string)) continue;
    if (!activeClaimsByAgent.has(claim.agent_id as string)) {
      activeClaimsByAgent.set(claim.agent_id as string, (claim.task_ref as string) ?? null);
    }
  }
  return agents.map((agent) => ({
    ...(agent as unknown as Record<string, unknown>),
    active_task_ref: activeClaimsByAgent.get((agent as unknown as Record<string, unknown>).agent_id as string) ?? null,
  }));
}

export function handleListActiveRuns(stateDir: string) {
  return ((readClaims(stateDir).claims ?? []) as unknown as Array<Record<string, unknown>>).filter((claim) =>
    ['claimed', 'in_progress'].includes(claim.state as string),
  );
}

export function handleListStalledRuns(stateDir: string, { stale_after_ms = 600_000, now_ms }: { stale_after_ms?: unknown; now_ms?: unknown } = {}) {
  if (!Number.isInteger(stale_after_ms) || (stale_after_ms as number) < 0) {
    throw new Error('stale_after_ms must be a non-negative integer');
  }
  const now = (now_ms as number) ?? Date.now();
  return ((readClaims(stateDir).claims ?? []) as unknown as Array<Record<string, unknown>>)
    .filter((claim) => ['claimed', 'in_progress'].includes(claim.state as string))
    .filter((claim) => {
      const timestamp = claim.last_heartbeat_at ?? claim.claimed_at;
      return (now - new Date(timestamp as string).getTime()) > (stale_after_ms as number);
    })
    .map((claim) => ({
      ...claim,
      stale_for_ms: now - new Date((claim.last_heartbeat_at ?? claim.claimed_at) as string).getTime(),
    }));
}

export function handleGetTask(stateDir: string, { task_ref }: { task_ref?: unknown } = {}) {
  if (!task_ref) throw new Error('task_ref is required');
  const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
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

  const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
  const claims = (readClaims(stateDir).claims ?? []) as unknown as Array<Record<string, unknown>>;
  const agents = listAgents(stateDir).filter((agent) => (agent as unknown as Record<string, unknown>).status !== 'dead');

  const activeClaimsByAgent = new Map<string, string | null>();
  for (const claim of claims) {
    if (!['claimed', 'in_progress'].includes(claim.state as string)) continue;
    if (!activeClaimsByAgent.has(claim.agent_id as string)) {
      activeClaimsByAgent.set(claim.agent_id as string, (claim.task_ref as string) ?? null);
    }
  }

  const status: Record<string, unknown> = {
    agents: agents.map((agent) => ({
      agent_id: (agent as unknown as Record<string, unknown>).agent_id ?? null,
      role: (agent as unknown as Record<string, unknown>).role ?? null,
      status: (agent as unknown as Record<string, unknown>).status ?? null,
      provider: (agent as unknown as Record<string, unknown>).provider ?? null,
      active_task_ref: activeClaimsByAgent.get((agent as unknown as Record<string, unknown>).agent_id as string) ?? null,
    })),
    task_counts: {
      todo: 0,
      claimed: 0,
      in_progress: 0,
      blocked: 0,
    },
    active_tasks: [],
    pending_notifications: readPendingNotifications(stateDir).length,
    stalled_runs: handleListStalledRuns(stateDir).length,
    next_task_seq: getNextTaskSeq(backlog),
  };

  if (include_done_count) {
    (status.task_counts as Record<string, number>).done = 0;
    (status.task_counts as Record<string, number>).released = 0;
  }

  for (const epic of (backlog.epics ?? []) as unknown as Array<Record<string, unknown>>) {
    for (const task of (epic.tasks ?? []) as unknown as Array<Record<string, unknown>>) {
      if (Object.hasOwn(status.task_counts as object, task.status as string)) {
        (status.task_counts as Record<string, number>)[task.status as string] += 1;
      }
      if (task.status === 'done' || task.status === 'released') continue;
      (status.active_tasks as unknown[]).push({
        ref: task.ref,
        title: task.title,
        status: task.status,
        epic_ref: epic.ref,
        owner: task.owner ?? null,
      });
    }
  }

  return status;
}

export function handleGetAgentWorkview(stateDir: string, { agent_id }: { agent_id?: unknown } = {}) {
  if (!agent_id) throw new Error('agent_id is required');

  const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
  const claims = (readClaims(stateDir).claims ?? []) as unknown as Array<Record<string, unknown>>;
  const agents = listAgents(stateDir);
  const agent = agents.find((entry) => (entry as unknown as Record<string, unknown>).agent_id === agent_id);
  if (!agent) return { error: 'not_found', agent_id };

  const activeRun = claims.find((claim) =>
    claim.agent_id === agent_id && ['claimed', 'in_progress'].includes(claim.state as string),
  ) ?? null;

  const doneSet = new Set(
    ((backlog.epics ?? []) as unknown as Array<Record<string, unknown>>).flatMap((epic) =>
      ((epic.tasks ?? []) as unknown as Array<Record<string, unknown>>)
        .filter((task) => task.status === 'done' || task.status === 'released')
        .map((task) => task.ref),
    ),
  );

  const queuedTasks: unknown[] = [];
  for (const epic of (backlog.epics ?? []) as unknown as Array<Record<string, unknown>>) {
    for (const task of (epic.tasks ?? []) as unknown as Array<Record<string, unknown>>) {
      if (task.owner !== agent_id) continue;
      if (task.status === 'done' || task.status === 'released') continue;
      if (activeRun?.task_ref === task.ref) continue;

      const blockers: string[] = [];
      if (task.status !== 'todo') blockers.push(`status:${task.status}`);
      if (task.planning_state && task.planning_state !== 'ready_for_dispatch') {
        blockers.push(`planning_state:${task.planning_state}`);
      }
      const unmetDependencies = ((task.depends_on ?? []) as string[]).filter((dependency) => !doneSet.has(dependency));
      blockers.push(...unmetDependencies.map((dependency) => `dependency_not_done:${dependency}`));
      blockers.push(...(evaluateTaskEligibility(task, agent as unknown as Record<string, unknown>) as { reasons: string[] }).reasons);

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
  else if ((queuedTasks as Array<{ blockers: string[] }>).some((task) => task.blockers.length === 0)) recommendedAction = 'start_run';

  const blockers = (queuedTasks as Array<{ ref: unknown; blockers: string[] }>).flatMap((task) => task.blockers.map((reason) => `${task.ref}:${reason}`));

  return {
    agent_id,
    agent: {
      agent_id: (agent as unknown as Record<string, unknown>).agent_id ?? null,
      role: (agent as unknown as Record<string, unknown>).role ?? null,
      status: (agent as unknown as Record<string, unknown>).status ?? null,
      provider: (agent as unknown as Record<string, unknown>).provider ?? null,
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

  const resolvedEpic = typeof epic === 'string' && (epic as string).trim().length > 0 ? epic as string : 'general';
  if (!title) throw new Error('title is required');
  if (!TASK_TYPES.has(task_type as string)) throw new Error(`Invalid task_type: ${task_type}`);
  if (!TASK_PRIORITIES.has(priority as string)) throw new Error(`Invalid priority: ${priority}`);
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${actor_id}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  if (owner && !ACTOR_ID_RE.test(owner as string)) throw new Error(`Invalid owner: ${owner}. Must match ^[a-z0-9][a-z0-9-]*$.`);

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
      const actorExists = allAgents.some((agent) => (agent as unknown as Record<string, unknown>).agent_id === actor_id);
      if (!actorExists) {
        throw new Error(`Actor agent not found: ${actor_id}. Registered agents: ${allAgents.map((agent) => (agent as unknown as Record<string, unknown>).agent_id).join(', ') || '(none)'}`);
      }
    }

    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
    const currentNextTaskSeq = getNextTaskSeq(backlog);

    if (resolvedEpic === 'general' && !((backlog.epics ?? []) as unknown as Array<Record<string, unknown>>).some((candidate) => candidate.ref === 'general')) {
      backlog.epics = [...((backlog.epics ?? []) as unknown[]), { ref: 'general', title: 'General', tasks: [] }];
    }

    const epicObj = ((backlog.epics ?? []) as unknown as Array<Record<string, unknown>>).find((candidate) => candidate.ref === resolvedEpic);
    if (!epicObj) throw new Error(`Epic not found: ${resolvedEpic}`);

    const existing = ((epicObj.tasks ?? []) as unknown as Array<Record<string, unknown>>).find((task) => task.ref === taskRef);
    if (existing) throw new Error(`Task already exists: ${taskRef}`);

    if (((depends_on ?? []) as unknown[]).length > 0) {
      const allRefs = new Set(((backlog.epics ?? []) as unknown as Array<Record<string, unknown>>).flatMap((candidate) => ((candidate.tasks ?? []) as unknown as Array<Record<string, unknown>>).map((task) => task.ref)));
      for (const dep of depends_on as string[]) {
        if (!allRefs.has(dep)) throw new Error(`depends_on task_ref not found in backlog: ${dep}`);
      }
    }

    const newTask: Record<string, unknown> = {
      ref: taskRef,
      title,
      status: 'todo',
      task_type,
      priority,
      planning_state: 'ready_for_dispatch',
      delegated_by: actor_id,
      depends_on: (depends_on as unknown[]) ?? [],
      acceptance_criteria: (acceptance_criteria as unknown[]) ?? [],
      required_capabilities: (required_capabilities as unknown[]) ?? [],
      created_at: now,
      updated_at: now,
    };
    if (description) newTask.description = description;
    if (owner) newTask.owner = owner;

    for (const key of ['depends_on', 'acceptance_criteria', 'required_capabilities']) {
      if (((newTask[key] as unknown[])?.length ?? 0) === 0) delete newTask[key];
    }

    epicObj.tasks = [...((epicObj.tasks ?? []) as unknown[]), newTask];
    backlog.next_task_seq = (currentNextTaskSeq as number) + 1;
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
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor_id: ${actor_id}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  assertStringArray(acceptance_criteria, 'acceptance_criteria');
  assertStringArray(depends_on, 'depends_on');
  if (priority !== undefined && !TASK_PRIORITIES.has(priority as string)) {
    throw new Error(`Invalid priority: ${priority}`);
  }

  const now = new Date().toISOString();
  const changedFields: string[] = [];

  return withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
    const task = findTask(backlog, task_ref as string) as Record<string, unknown> | null;
    if (!task) throw new Error(`Task not found: ${task_ref}`);

    if (title !== undefined) {
      task.title = title;
      changedFields.push('title');
    }
    if (description !== undefined) {
      task.description = description;
      changedFields.push('description');
    }
    if (priority !== undefined) {
      task.priority = priority;
      changedFields.push('priority');
    }
    if (acceptance_criteria !== undefined) {
      task.acceptance_criteria = acceptance_criteria;
      changedFields.push('acceptance_criteria');
    }
    if (depends_on !== undefined) {
      task.depends_on = depends_on;
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
        payload: { status: task.status as string, fields: changedFields },
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
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${actor_id}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  if (!TASK_TYPES.has(task_type as string)) throw new Error(`Invalid task type: ${task_type}`);

  const now = new Date().toISOString();

  return withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
    const claims = (readClaims(stateDir).claims ?? []) as unknown as Array<Record<string, unknown>>;
    const allAgents = listAgents(stateDir);
    const actorExists = allAgents.some((agent) => (agent as unknown as Record<string, unknown>).agent_id === actor_id);
    if (actor_id !== 'human' && !actorExists) {
      throw new Error(`Actor agent not found: ${actor_id}. Registered agents: ${allAgents.map((agent) => (agent as unknown as Record<string, unknown>).agent_id).join(', ') || '(none)'}`);
    }

    let task: Record<string, unknown> | null = null;
    let epicRef: unknown = null;
    for (const epic of (backlog.epics ?? []) as unknown as Array<Record<string, unknown>>) {
      task = ((epic.tasks ?? []) as unknown as Array<Record<string, unknown>>).find((candidate) => candidate.ref === task_ref) ?? null;
      if (task) {
        epicRef = epic.ref;
        break;
      }
    }
    if (!task) throw new Error(`Task not found: ${task_ref}`);
    const taskForDiagnostics = { ...task };

    let assignedTarget: string | null = (target_agent_id as string) ?? null;
    if (assignedTarget) {
      const target = allAgents.find((agent) => (agent as unknown as Record<string, unknown>).agent_id === assignedTarget);
      if (!target) throw new Error(`Target agent not found: ${assignedTarget}`);
      const activeClaim = claims.find((claim) =>
        claim.agent_id === assignedTarget && ['claimed', 'in_progress'].includes(claim.state as string),
      );
      if (activeClaim) {
        throw new Error(`Target agent ${assignedTarget} already has active run ${activeClaim.run_id}`);
      }
      const evaluation = evaluateTaskEligibility({ ...task, task_type: task_type as string | undefined }, target as unknown as Record<string, unknown>) as { eligible: boolean; reasons: string[] };
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
        claims: claims as unknown as import('../types/claims.ts').Claim[],
        stateDir,
      }) as string | null;
    }

    task.task_type = task_type;
    task.planning_state = 'ready_for_dispatch';
    task.delegated_by = actor_id;
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
        message: `No eligible worker for ${task_ref}; inspect candidate_diagnostics for routing blockers.`,
        candidate_diagnostics: describeAutoTargetFailure({
          task: taskForDiagnostics,
          taskType: task_type as string,
          allAgents,
          claims: claims as unknown as import('../types/claims.ts').Claim[],
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
  if (!ACTOR_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${actor_id}. Must match ^[a-z0-9][a-z0-9-]*$.`);

  const now = new Date().toISOString();
  let cancelledRuns: Array<Record<string, unknown>> = [];
  let cancelledResult: unknown = null;

  const result = withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const claimsPath = join(stateDir, 'claims.json');
    const backlog = readJson(stateDir, 'backlog.json') as Record<string, unknown>;
    const claimsData = readClaims(stateDir) as unknown as Record<string, unknown>;
    const claims = (claimsData.claims ?? []) as Array<Record<string, unknown>>;

    if (actor_id !== 'human') {
      const allAgents = listAgents(stateDir);
      const actorExists = allAgents.some((agent) => (agent as unknown as Record<string, unknown>).agent_id === actor_id);
      if (!actorExists) {
        throw new Error(`Actor agent not found: ${actor_id}. Registered agents: ${allAgents.map((agent) => (agent as unknown as Record<string, unknown>).agent_id).join(', ') || '(none)'}`);
      }
    }

    const task = findTask(backlog, task_ref as string) as Record<string, unknown> | null;
    if (!task) throw new Error(`Task not found: ${task_ref}`);

    if (task.status === 'done' || task.status === 'released') {
      return { error: 'already_terminal', task_ref, status: task.status };
    }

    const activeClaims = claims.filter((claim) =>
      claim.task_ref === task_ref && ['claimed', 'in_progress'].includes(claim.state as string),
    );
    if (activeClaims.length > 0) {
      claimsData.claims = claims.filter((claim) =>
        !(claim.task_ref === task_ref && ['claimed', 'in_progress'].includes(claim.state as string)),
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
            run_id: removed.run_id as string,
            task_ref: task_ref as string,
            agent_id: removed.agent_id as string,
            payload: { reason },
          },
          { lockAlreadyHeld: true },
        );
      }
    }

    task.status = 'blocked';
    task.updated_at = now;
    task.blocked_reason = (reason as string) ?? 'cancelled';
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_cancelled',
        actor_type: actor_id === 'human' ? 'human' : 'agent',
        actor_id: actor_id as string,
        task_ref: task_ref as string,
        ...(cancelledRuns[0] ? { run_id: cancelledRuns[0].run_id as string, agent_id: cancelledRuns[0].agent_id as string } : {}),
        payload: {
          reason,
          had_active_run: cancelledRuns.length > 0,
        },
      },
      { lockAlreadyHeld: true },
    );

    cancelledResult = {
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
    return cancelledResult;
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
      console.warn(`[mcp] WARNING: failed to deposit cancellation notification for ${task_ref} (${cancelledRun.run_id})`);
    }
  }

  return result;
}

export function handleRespondInput(stateDir: string, { run_id, agent_id, response, actor_id }: Record<string, unknown> = {}) {
  if (!run_id) throw new Error('run_id is required');
  if (!agent_id) throw new Error('agent_id is required');
  if (typeof response !== 'string' || (response as string).length === 0) {
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
      .map((line) => JSON.parse(line))
      .reverse()
      .find((event: Record<string, unknown>) =>
        event.event === 'input_requested'
        && event.run_id === run_id
        && event.agent_id === agent_id
        && typeof (event.payload as unknown as Record<string, unknown>)?.question === 'string')
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
    task_ref: (latestRequest as Record<string, unknown> | null)?.task_ref as string | undefined,
    agent_id: agent_id as string,
    payload: {
      response,
      question: ((latestRequest as Record<string, unknown> | null)?.payload as Record<string, unknown> | undefined)?.question ?? null,
    },
  } as import('../types/events.ts').OrcEventInput);

  return {
    ok: true,
    run_id,
    agent_id,
    responded_by: effectiveActorId,
  };
}
