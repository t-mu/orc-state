import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeMemoryDb, getMemoryStats, listDrawers, memoryWakeUp, searchMemory, storeDrawer } from '../lib/memoryStore.ts';

import { createAdapter } from '../adapters/index.ts';
import { atomicWriteJson } from '../lib/atomicWrite.ts';
import { PlanAuthoringError, writePlan, type WritePlanInput } from '../lib/planAuthoring.ts';
import { ACTIVE_PROJECT, PLANS_DIR, TARGET_REPO_ROOT } from '../lib/paths.ts';
import { syncBacklogFromSpecs } from '../lib/backlogSync.ts';
import { taskSnapshotStatus } from '../lib/documentIndex.ts';
import { appendSequencedEvent, getLastNotificationSeq, queryEvents, queryNotificationEvents } from '../lib/eventLog.ts';
import { getAgent, listAgents, nextAvailableScoutId, registerAgent, removeAgent } from '../lib/agentRegistry.ts';
import { withLock } from '../lib/lock.ts';
import { findTask, getNextTaskSeq, readBacklog, readClaims } from '../lib/stateReader.ts';
import { evaluateTaskEligibility } from '../lib/taskRouting.ts';
import { isSupportedProvider, loadWorkerPoolConfig } from '../lib/providers.ts';
import { RUN_WORKTREES_FILE } from '../lib/paths.ts';
import { readProjectDescriptor } from '../lib/projectContext.ts';
import { DEFAULT_SCOUT_READY_TIMEOUT_MS } from '../lib/constants.ts';
import { assertTaskRegistrationFieldsAllowed, assertTaskSpecMatchesRegistration, assertTaskUpdateAllowed } from '../lib/taskAuthority.ts';
import { launchWorkerSession } from '../lib/workerRuntime.ts';
import { renderTemplate } from '../lib/templateRender.ts';
import { AGENT_ID_RE, AGENT_ROLES, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from '../lib/constants.ts';
import { previewSpec, publishSpec } from '../lib/planSpecTask.ts';
import { createProjectTask, describeProjectTask, PROJECT_ONLY_TASK_FIELDS, projectTaskStoreFor, reviseProjectTask } from '../lib/projectTasks.ts';
import { isProjectStateDir } from '../lib/projectContext.ts';
import { TERMINAL_STATUSES, backlogDocsDirForState, cancelTask, delegateTask, masterActorId, readBacklogFresh, resetTask, respondInput, unblockTask } from '../lib/operatorMutations.ts';
import type { Task } from '../types/backlog.ts';
import type { RunWorktreesState } from '../types/run-worktrees.ts';

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
  return masterActorId(stateDir);
}

function assertActorId(stateDir: string, actorId: unknown) {
  if (typeof actorId !== 'string' || !AGENT_ID_RE.test(actorId)) {
    throw new Error(`Invalid actor-id: ${typeof actorId === 'string' ? actorId : '(unknown)'}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  }
  if (actorId === 'human') return;
  const allAgents = listAgents(stateDir);
  const actorExists = allAgents.some((agent) => agent.agent_id === actorId);
  if (!actorExists) {
    throw new Error(`Actor agent not found: ${String(actorId)}. Registered agents: ${allAgents.map((agent) => agent.agent_id).join(', ') || '(none)'}`);
  }
}

function assertNoProjectOnlyFields(args: Record<string, unknown>) {
  const fields = PROJECT_ONLY_TASK_FIELDS.filter((field) => args[field] !== undefined);
  if (fields.length > 0) {
    throw new Error(`${fields.join(', ')} require(s) a project state directory; edit the backlog markdown spec instead.`);
  }
}

function plansDirForState(stateDir: string) {
  const colocatedPlansDir = join(stateDir, 'plans');
  if (existsSync(colocatedPlansDir)) return colocatedPlansDir;
  const parentPlansDir = join(stateDir, '..', 'plans');
  if (existsSync(parentPlansDir)) return parentPlansDir;
  return PLANS_DIR;
}


// `next_task_seq` always means "the next available numeric sequence from this state snapshot".
// Before create_task mutates backlog.json, it is the number to consume next.
// After create_task commits, it becomes the next number after the task just created.

// Fields returned by list_tasks (summary view). Use get_task() for full detail.

function toTaskSummary(task: Task & { feature_ref: string }) {
  return {
    ref: task.ref,
    title: task.title,
    status: task.status,
    feature_ref: task.feature_ref,
    task_type: task.task_type,
    priority: task.priority ?? 'normal',
    owner: task.owner,
    depends_on: task.depends_on,
  };
}

export function handleListTasks(stateDir: string, { status, feature }: { status?: unknown; feature?: unknown } = {}) {
  if (status != null && !TASK_STATUSES.includes(status as string)) {
    throw new Error(`Invalid status: ${typeof status === 'string' ? status : '(unknown)'}`);
  }
  if (feature != null && typeof feature !== 'string') {
    throw new Error('feature must be a string');
  }
  const backlog = readBacklogFresh(stateDir);
  let tasks = backlog.features.flatMap((featureObj) =>
    featureObj.tasks.map((task): Task & { feature_ref: string } => ({ ...task, feature_ref: featureObj.ref })),
  );

  if (status) {
    tasks = tasks.filter((task) => task.status === status);
  } else {
    // Exclude terminal statuses by default to keep payload small.
    // Use status="done", "released", or "cancelled" to retrieve terminal tasks explicitly.
    tasks = tasks.filter((task) => !TERMINAL_STATUSES.has(task.status));
  }
  if (feature) tasks = tasks.filter((task) => task.feature_ref === feature);

  // Return summary fields only. Full task detail (description, acceptance_criteria, etc.)
  // is available via get_task(task_ref).
  return tasks.map(toTaskSummary);
}

export function handleListAgents(stateDir: string, { role, include_dead = false }: { role?: unknown; include_dead?: unknown } = {}) {
  if (role != null && !AGENT_ROLES.includes(role as string)) {
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
  const store = projectTaskStoreFor(stateDir);
  if (store) {
    const projectTask = store.getTask(task_ref as string);
    return projectTask ? describeProjectTask(projectTask) : { error: 'not_found', task_ref };
  }
  const backlog = readBacklogFresh(stateDir);
  const task = findTask(backlog, task_ref as string);
  if (!task) return { error: 'not_found', task_ref };
  return task;
}

export function handleGetRecentEvents(
  stateDir: string,
  { limit = 20, agent_id, run_id }: { limit?: unknown; agent_id?: unknown; run_id?: unknown } = {},
) {
  if (!Number.isInteger(limit) || (limit as number) < 0) {
    throw new Error('limit must be a non-negative integer');
  }
  if (agent_id !== undefined && typeof agent_id !== 'string') {
    throw new Error('agent_id must be a string');
  }
  if (run_id !== undefined && typeof run_id !== 'string') {
    throw new Error('run_id must be a string');
  }
  const cap = Math.min(limit as number, 200);
  if (cap === 0) return [];
  let events = queryEvents(stateDir, { ...(run_id !== undefined ? { run_id } : {}), limit: cap, order: 'desc' }).reverse();
  if (agent_id) {
    events = events.filter(
      (e) => (e as unknown as Record<string, unknown>).agent_id === agent_id || e.actor_id === agent_id,
    );
  }
  return events;
}

export function handleGetStatus(stateDir: string, { include_done_count = false }: { include_done_count?: unknown } = {}) {
  if (typeof include_done_count !== 'boolean') {
    throw new Error('include_done_count must be a boolean');
  }

  const backlog = readBacklogFresh(stateDir);
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
    taskCounts.cancelled = 0;
  }

  const activeTasks: Array<{ ref: string; title: string; status: string; feature_ref: string; owner: string | null }> = [];
  for (const feature of backlog.features) {
    for (const task of feature.tasks) {
      if (Object.hasOwn(taskCounts, task.status)) {
        taskCounts[task.status] += 1;
      }
      if (TERMINAL_STATUSES.has(task.status)) continue;
      activeTasks.push({
        ref: task.ref,
        title: task.title,
        status: task.status,
        feature_ref: feature.ref,
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
    last_notification_seq: getLastNotificationSeq(stateDir),
    stalled_runs: handleListStalledRuns(stateDir).length,
    next_task_seq: getNextTaskSeq(backlog),
    // The registered project this state belongs to; null for a legacy installation (author tasks as backlog/ specs there).
    project: (() => {
      const descriptor = readProjectDescriptor(stateDir);
      return descriptor ? { id: descriptor.id, name: descriptor.name, target_repo_root: descriptor.target_repo_root } : null;
    })(),
  };
}

export function handleGetAgentWorkview(stateDir: string, { agent_id }: { agent_id?: unknown } = {}) {
  if (!agent_id) throw new Error('agent_id is required');

  const backlog = readBacklogFresh(stateDir);
  const claims = readClaims(stateDir).claims;
  const agents = listAgents(stateDir);
  const agent = agents.find((entry) => entry.agent_id === agent_id);
  if (!agent) return { error: 'not_found', agent_id };

  if (agent.role === 'scout') {
    return {
      agent_id,
      agent: {
        agent_id: agent.agent_id,
        role: 'scout',
        status: agent.status,
        provider: agent.provider,
        launched_at: agent.last_heartbeat_at ?? agent.registered_at ?? null,
      },
      active_run: null,
      queued_tasks: [],
      blockers: [],
      recommended_action: 'poll_for_report',
      note: `Poll get_scout_report until its status is reported or ended, then call remove_scout for ${agent.agent_id}`,
    };
  }

  const activeRun = claims.find((claim) =>
    claim.agent_id === agent_id && ['claimed', 'in_progress'].includes(claim.state),
  ) ?? null;

  const doneSet = new Set(
    backlog.features.flatMap((feature) =>
      feature.tasks
        .filter((task) => task.status === 'done' || task.status === 'released')
        .map((task) => task.ref),
    ),
  );

  const queuedTasks: Array<{ ref: string; title: string; status: string; task_type: string; blockers: string[] }> = [];
  for (const feature of backlog.features) {
    for (const task of feature.tasks) {
      if (task.owner !== agent_id) continue;
      if (TERMINAL_STATUSES.has(task.status)) continue;
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
  syncBacklogFromSpecs(stateDir, backlogDocsDirForState(stateDir));
  return readFileSync(join(stateDir, 'backlog.json'), 'utf8');
}

export function handleReadAgents(stateDir: string) {
  return readFileSync(join(stateDir, 'agents.json'), 'utf8');
}

/** A project directory whose task database is missing must fail, never fall through to legacy backlog.json writes. */
function assertLegacyTaskStore(stateDir: string): void {
  if (isProjectStateDir(stateDir)) {
    throw new Error(`Project task store is missing (${join(stateDir, 'runtime.db')}); restore it or re-run orc project migrate. Legacy task writes are refused in a project.`);
  }
}

export function handleCreateTask(stateDir: string, args: Record<string, unknown> = {}) {
  if (projectTaskStoreFor(stateDir)) {
    // Project tasks are database-only: no Markdown spec is required or written.
    const { actor_id = defaultActorId(stateDir), ...input } = args;
    assertActorId(stateDir, actor_id);
    // Project refs carry no numeric sequence.
    return { ...describeProjectTask(createProjectTask(stateDir, input, actor_id as string)), next_task_seq: undefined };
  }
  assertLegacyTaskStore(stateDir);
  assertNoProjectOnlyFields(args);
  const {
    feature,
    title,
    ref,
    task_type = 'implementation',
    priority = 'normal',
    description,
    acceptance_criteria,
    depends_on,
    required_capabilities,
    required_provider,
    model,
    owner,
    actor_id = defaultActorId(stateDir),
  } = args;

  const resolvedFeature = typeof feature === 'string' && (feature).trim().length > 0 ? feature : 'general';
  if (!title) throw new Error('title is required');
  if (!TASK_TYPES.includes(task_type as string)) throw new Error(`Invalid task_type: ${String(task_type)}`);
  if (!TASK_PRIORITIES.includes(priority as string)) throw new Error(`Invalid priority: ${String(priority)}`);
  if (!AGENT_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor-id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  if (owner && !AGENT_ID_RE.test(owner as string)) throw new Error(`Invalid owner: ${typeof owner === 'string' ? owner : '(unknown)'}. Must match ^[a-z0-9][a-z0-9-]*$.`);

  assertStringArray(acceptance_criteria, 'acceptance_criteria');
  assertStringArray(depends_on, 'depends_on');
  assertStringArray(required_capabilities, 'required_capabilities');
  if (required_provider != null && !isSupportedProvider(required_provider)) {
    throw new Error(`Invalid required_provider: ${typeof required_provider === 'string' ? required_provider : '(unknown)'}. Must be codex, claude, or gemini.`);
  }
  if (model != null && typeof model !== 'string') {
    throw new Error(`Invalid model: must be a string or null.`);
  }

  const now = new Date().toISOString();
  const taskSlug = (ref as string) ?? slugify(title as string);
  const taskRef = `${resolvedFeature}/${taskSlug}`;
  if (!taskSlug || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(taskRef)) {
    throw new Error(`Invalid task ref: ${taskRef}`);
  }
  assertTaskRegistrationFieldsAllowed({ description, acceptance_criteria, depends_on });

  return withLock(join(stateDir, '.lock'), () => {
    if (actor_id !== 'human') {
      const allAgents = listAgents(stateDir);
      const actorExists = allAgents.some((agent) => agent.agent_id === actor_id);
      if (!actorExists) {
        throw new Error(`Actor agent not found: ${String(actor_id)}. Registered agents: ${allAgents.map((agent) => agent.agent_id).join(', ') || '(none)'}`);
      }
    }

    const backlog = readBacklog(stateDir);

    const existing = findTask(backlog, taskRef);
    if (existing) throw new Error(`Task already exists: ${taskRef}`);

    assertTaskSpecMatchesRegistration({
      taskRef,
      featureRef: resolvedFeature,
      title: title as string,
    });

    const syncedBacklog = readBacklogFresh(stateDir, { lockAlreadyHeld: true });
    const currentNextTaskSeq = getNextTaskSeq(syncedBacklog);
    const newTask = findTask(syncedBacklog, taskRef);
    if (!newTask) throw new Error(`Task spec did not sync into orchestrator state: ${taskRef}`);
    newTask.task_type = task_type as Task['task_type'];
    newTask.priority = priority as Task['priority'];
    newTask.planning_state = 'ready_for_dispatch';
    newTask.delegated_by = actor_id as string;
    newTask.created_at ??= now;
    newTask.updated_at = now;
    if ((required_capabilities as string[] | undefined)?.length) {
      newTask.required_capabilities = required_capabilities as string[];
    }
    if (owner) newTask.owner = owner as string;
    if (required_provider != null) newTask.required_provider = required_provider as Task['required_provider'];
    if (model != null) newTask.model = model;

    syncedBacklog.next_task_seq = currentNextTaskSeq + 1;
    atomicWriteJson(join(stateDir, 'backlog.json'), syncedBacklog);

    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_added',
        actor_type: actor_id === 'human' ? 'human' : 'agent',
        actor_id: actor_id as string,
        task_ref: taskRef,
        payload: { title, task_type, feature_ref: resolvedFeature },
      },
      { lockAlreadyHeld: true },
    );
    // Return the post-write value so callers can immediately see the next available sequence.
    return { ...newTask, next_task_seq: syncedBacklog.next_task_seq };
  });
}

export function handleUpdateTask(stateDir: string, args: Record<string, unknown> = {}) {
  if (projectTaskStoreFor(stateDir)) {
    const { task_ref, expected_revision, actor_id = defaultActorId(stateDir), ...changes } = args;
    if (typeof task_ref !== 'string' || !task_ref) throw new Error('task_ref is required');
    assertActorId(stateDir, actor_id);
    const { task, changed } = reviseProjectTask(stateDir, task_ref, expected_revision, changes, actor_id as string);
    return { ...describeProjectTask(task), changed };
  }
  assertLegacyTaskStore(stateDir);
  assertNoProjectOnlyFields(args);
  const {
    task_ref,
    title,
    description,
    priority,
    acceptance_criteria,
    depends_on,
    required_provider,
    model,
    actor_id = defaultActorId(stateDir),
  } = args;

  if (!task_ref) throw new Error('task_ref is required');
  if (!AGENT_ID_RE.test(actor_id as string)) throw new Error(`Invalid actor_id: ${String(actor_id)}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  assertStringArray(acceptance_criteria, 'acceptance_criteria');
  assertStringArray(depends_on, 'depends_on');
  if (priority !== undefined && !TASK_PRIORITIES.includes(priority as string)) {
    throw new Error(`Invalid priority: ${typeof priority === 'string' ? priority : '(unknown)'}`);
  }
  if (required_provider !== undefined && required_provider !== null && !isSupportedProvider(required_provider)) {
    throw new Error(`Invalid required_provider: ${typeof required_provider === 'string' ? required_provider : '(unknown)'}. Must be codex, claude, or gemini.`);
  }
  if (model !== undefined && model !== null && typeof model !== 'string') {
    throw new Error(`Invalid model: must be a string or null.`);
  }

  const now = new Date().toISOString();
  const changedFields: string[] = [];

  return withLock(join(stateDir, '.lock'), () => {
    const backlog = readBacklogFresh(stateDir, { lockAlreadyHeld: true });
    const task = findTask(backlog, task_ref as string);
    if (!task) throw new Error(`Task not found: ${typeof task_ref === 'string' ? task_ref : '(unknown)'}`);
    const authoritativeUpdates: Partial<Pick<Task, 'title' | 'description' | 'acceptance_criteria' | 'depends_on'>> = {};
    if (title !== undefined) authoritativeUpdates.title = title as Task['title'];
    if (description !== undefined) authoritativeUpdates.description = description as Task['description'];
    if (acceptance_criteria !== undefined) authoritativeUpdates.acceptance_criteria = acceptance_criteria as Task['acceptance_criteria'];
    if (depends_on !== undefined) authoritativeUpdates.depends_on = depends_on as Task['depends_on'];
    assertTaskUpdateAllowed(task, authoritativeUpdates);

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
    if (required_provider !== undefined) {
      if (required_provider === null) {
        delete task.required_provider;
      } else {
        task.required_provider = required_provider as Task['required_provider'];
      }
      changedFields.push('required_provider');
    }
    if (model !== undefined) {
      if (model === null) {
        delete task.model;
      } else {
        task.model = model;
      }
      changedFields.push('model');
    }

    task.updated_at = now;
    atomicWriteJson(join(stateDir, 'backlog.json'), backlog);

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
  return delegateTask(stateDir, args);
}

export function handleCancelTask(stateDir: string, args: Record<string, unknown> = {}) {
  return cancelTask(stateDir, args);
}

function readRunWorktreesState(stateDir?: string): RunWorktreesState {
  const path = stateDir ? join(stateDir, 'run-worktrees.json') : RUN_WORKTREES_FILE;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunWorktreesState;
  } catch {
    return { version: '1', runs: [] };
  }
}

function scopeLines(scopePaths: string[] | undefined) {
  if (!scopePaths || scopePaths.length === 0) {
    return '- (none specified — search broadly from working_directory)';
  }
  return scopePaths.map((path) => `- ${path}`).join('\n')
    + '\n\nDo not expand beyond scope_paths unless all listed paths are exhausted with no findings.';
}

async function waitForScoutReportedForDuty(
  stateDir: string,
  agentId: string,
  sessionToken: string,
  initialAgent: ReturnType<typeof getAgent> | null = null,
  timeoutMs = Number(process.env.ORC_SCOUT_READY_TIMEOUT_MS ?? DEFAULT_SCOUT_READY_TIMEOUT_MS),
) {
  const initialReady = initialAgent?.session_handle
    && initialAgent.session_token === sessionToken
    && initialAgent.session_ready_at
    && initialAgent.session_started_at
    && new Date(initialAgent.session_ready_at).getTime() >= new Date(initialAgent.session_started_at).getTime();
  if (initialReady) {
    return true;
  }
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const agent = getAgent(stateDir, agentId);
    if (
      agent?.session_handle
      && agent.session_token === sessionToken
      && agent.session_ready_at
      && agent.session_started_at
      && new Date(agent.session_ready_at).getTime() >= new Date(agent.session_started_at).getTime()
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export function handleGetRun(stateDir: string, { run_id }: { run_id?: unknown } = {}) {
  if (!run_id) throw new Error('run_id is required');
  const claims = readClaims(stateDir).claims;
  const claim = claims.find((c) => c.run_id === run_id);
  if (!claim) return { error: 'not_found', run_id };

  const backlog = readBacklogFresh(stateDir);
  const task = findTask(backlog, claim.task_ref);
  const taskTitle = task?.title ?? null;

  const worktrees = readRunWorktreesState(stateDir);
  const wtEntry = worktrees.runs.find((e) => e.run_id === run_id);
  const worktreePath = wtEntry?.worktree_path ?? null;

  return { ...claim, task_title: taskTitle, worktree_path: worktreePath,
    task_spec_revision_status: claim.task_spec_snapshot ? taskSnapshotStatus(claim.task_spec_snapshot, stateDir) : 'unknown' };
}

export async function handleRequestScout(stateDir: string, {
  objective,
  provider,
  run_id = null,
  task_ref = null,
  scope_paths = [],
  use_web = false,
  actor_id = defaultActorId(stateDir),
}: Record<string, unknown> = {}) {
  if (typeof objective !== 'string' || objective.trim().length === 0) {
    throw new Error('objective is required');
  }
  if (provider != null && !isSupportedProvider(provider)) {
    throw new Error(`Invalid provider: ${typeof provider === 'string' ? provider : '(unknown)'}`);
  }
  if (run_id != null && typeof run_id !== 'string') throw new Error('run_id must be a string');
  if (task_ref != null && typeof task_ref !== 'string') throw new Error('task_ref must be a string');
  assertStringArray(scope_paths, 'scope_paths');
  if (typeof use_web !== 'boolean') throw new Error('use_web must be a boolean');
  assertActorId(stateDir, actor_id);

  const actor = typeof actor_id === 'string' ? getAgent(stateDir, actor_id) : null;
  if (actor_id !== 'human' && actor?.role !== 'master') {
    throw new Error(`request_scout may only be invoked by master or human actors; got role '${actor?.role ?? 'unknown'}'`);
  }
  const resolvedProvider = (typeof provider === 'string' ? provider : actor?.provider ?? 'codex');
  const scoutId = nextAvailableScoutId(stateDir);
  // Blank means unset (project workers blank it); a project's scouts start in the target repository.
  const repoRoot = process.env.ORC_REPO_ROOT || (ACTIVE_PROJECT ? TARGET_REPO_ROOT : join(stateDir, '..'));
  const worktrees = readRunWorktreesState(stateDir);
  const recordedWorktree = typeof run_id === 'string'
    ? (worktrees.runs.find((entry) => entry.run_id === run_id)?.worktree_path ?? null)
    : null;
  // Scouts launch in their cwd (task 204); a stalled run's worktree may be
  // gone, which is exactly when a scout is wanted — investigate from the root.
  const linkedWorktree = recordedWorktree != null && existsSync(recordedWorktree) ? recordedWorktree : null;
  const workingDirectory = linkedWorktree ?? repoRoot;

  // A project scout reports for duty over the control socket, under the same opt-in as workers.
  // Resolved before registering, so an invalid setting leaves no scout behind.
  const sandboxNetwork = ACTIVE_PROJECT ? loadWorkerPoolConfig().sandbox_network : undefined;

  const scout = registerAgent(stateDir, {
    agent_id: scoutId,
    provider: resolvedProvider,
    role: 'scout',
  });

  const adapter = createAdapter(resolvedProvider);
  const launchResult = await launchWorkerSession(stateDir, scout, {
    adapter,
    workingDirectory,
    repoRoot,
    ...(sandboxNetwork ? { sandboxNetwork } : {}),
    emit: (event) => appendSequencedEvent(stateDir, event),
  });
  if (!launchResult.ok || !launchResult.session_handle) {
    removeAgent(stateDir, scout.agent_id);
    throw new Error(`Failed to launch scout ${scoutId}: ${launchResult.reason ?? 'unknown error'}`);
  }

  const launchedAt = new Date().toISOString();
  const launchedScout = getAgent(stateDir, scout.agent_id);
  const sessionToken = launchedScout?.session_token ?? scout.session_token ?? null;
  if (!sessionToken) {
    await adapter.stop(launchResult.session_handle);
    removeAgent(stateDir, scout.agent_id);
    throw new Error(`Failed to launch scout ${scoutId}: missing session id after launch`);
  }
  const ready = await waitForScoutReportedForDuty(stateDir, scout.agent_id, sessionToken, scout);
  if (!ready) {
    await adapter.stop(launchResult.session_handle);
    removeAgent(stateDir, scout.agent_id);
    // A sandboxed project scout that cannot reach the control socket never reports (task 230).
    const unreachable = sandboxNetwork === 'restricted'
      && (resolvedProvider === 'codex' || (resolvedProvider === 'claude' && process.platform === 'linux'));
    const hint = unreachable || (sandboxNetwork === 'open' && resolvedProvider === 'codex')
      ? `; in a project a sandboxed ${resolvedProvider} scout reports through the control socket, which it cannot reach here`
        + (resolvedProvider === 'codex' ? ' (request a claude scout)' : ' (set worker_pool.sandbox_network=open)') + ' — see docs/configuration.md → Execution Modes'
      : '';
    throw new Error(`Failed to brief scout ${scoutId}: scout did not report for duty in time${hint}`);
  }
  const contextLines = [
    typeof run_id === 'string' ? `linked_run_id: ${run_id}` : null,
    typeof task_ref === 'string' ? `linked_task_ref: ${task_ref}` : null,
  ].filter(Boolean).join('\n');
  const brief = renderTemplate('scout-brief-v1.txt', {
    agent_id: scout.agent_id,
    provider: scout.provider,
    objective: objective.trim(),
    context_lines: contextLines,
    working_directory: workingDirectory,
    use_web: use_web ? 'yes' : 'no',
    scope_paths: scopeLines(scope_paths as string[]),
  });
  try {
    await adapter.send(launchResult.session_handle, brief);
  } catch (error) {
    await adapter.stop(launchResult.session_handle);
    removeAgent(stateDir, scout.agent_id);
    throw new Error(`Failed to brief scout ${scoutId}: ${(error as Error)?.message ?? 'unknown error'}`);
  }

  return {
    agent_id: scout.agent_id,
    role: 'scout',
    provider: scout.provider,
    status: scout.status,
    objective: objective.trim(),
    run_id: typeof run_id === 'string' ? run_id : null,
    task_ref: typeof task_ref === 'string' ? task_ref : null,
    use_web,
    scope_paths,
    working_directory: workingDirectory,
    launched_at: launchedAt,
    session_handle: launchResult.session_handle,
  };
}

/** A scout's report spans a few kilobytes of TUI output; read well past the default 8 KiB tail. */
const SCOUT_OUTPUT_BYTES = 64 * 1024;
const MARKER_PREFIX = String.raw`^[^\w\n]*`;
const REPORT_START = new RegExp(`${MARKER_PREFIX}SCOUT_REPORT[ \t]*$`);
const REPORT_END = new RegExp(`${MARKER_PREFIX}SCOUT_REPORT_END[ \t]*$`);
const REPORT_HEADERS = ['findings', 'likely_cause', 'recommended_action'].map((header) => new RegExp(`${MARKER_PREFIX}${header}:`, 'm'));

/**
 * Find a scout's final SCOUT_REPORT block in its session output. Markers count
 * only on their own line (a prompt glyph or indentation may precede them), and
 * a block counts only with all three report headers and no `<placeholder>`
 * from the echoed template, so quoted examples and the template are ignored.
 * `truncated` means the last end marker is a real report's whose start fell
 * outside the output read; the echoed template's own end marker (its
 * `<placeholder>` lines just before it) never counts, so a scout whose tail
 * begins inside the template is still `running`.
 */
export function extractScoutReport(output: string): { report: string | null; truncated: boolean } {
  let start: number | null = null;
  let report: string | null = null;
  let truncated = false;
  const lines = output.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (REPORT_START.test(line)) { start = index; return; }
    if (!REPORT_END.test(line)) return;
    if (start === null) {
      truncated = !lines.slice(Math.max(0, index - 3), index).join('\n').includes('<concrete next step');
      return;
    }
    truncated = false;
    const block = lines.slice(start + 1, index).join('\n').trim();
    start = null;
    if (!block.includes('<what you found') && REPORT_HEADERS.every((header) => header.test(block))) {
      report = block;
      truncated = false;
    }
  });
  return { report, truncated: report === null && truncated };
}

function requireScout(stateDir: string, agentId: unknown) {
  if (typeof agentId !== 'string' || !agentId) throw new Error('agent_id is required');
  const agent = getAgent(stateDir, agentId);
  if (!agent) throw new Error(`Scout not found: ${agentId}`);
  if (agent.role !== 'scout') throw new Error(`${agentId} is not a scout (role: ${agent.role ?? 'unknown'})`);
  return agent;
}

/**
 * Read a scout's report from its session output: `reported` with the block,
 * `truncated` (an end marker without its start, so the report is unreadable),
 * `running`, or `ended` without one.
 */
export async function handleGetScoutReport(stateDir: string, { agent_id }: Record<string, unknown> = {}) {
  const scout = requireScout(stateDir, agent_id);
  const launchedAt = scout.registered_at ?? null;
  if (!scout.session_handle) return { agent_id: scout.agent_id, status: 'ended', report: null, launched_at: launchedAt };
  const adapter = createAdapter(scout.provider);
  const { report, truncated } = extractScoutReport(adapter.getOutputTail(scout.session_handle, SCOUT_OUTPUT_BYTES) ?? '');
  const status = report ? 'reported' : truncated ? 'truncated'
    : (await adapter.heartbeatProbe(scout.session_handle)) ? 'running' : 'ended';
  return { agent_id: scout.agent_id, status, report, launched_at: launchedAt };
}

/** Stop a scout's session and remove its registration; only scouts, never workers or the master. */
export async function handleRemoveScout(stateDir: string, { agent_id }: Record<string, unknown> = {}) {
  // Removing a scout that is already gone is a no-op, so cleanup can always be called.
  if (typeof agent_id === 'string' && agent_id && !getAgent(stateDir, agent_id)) return { agent_id, removed: false, reason: 'not_found' };
  const scout = requireScout(stateDir, agent_id);
  let stopError: string | null = null;
  if (scout.session_handle) {
    try {
      await createAdapter(scout.provider).stop(scout.session_handle);
    } catch (error) {
      stopError = (error as Error)?.message ?? String(error);
    }
  }
  removeAgent(stateDir, scout.agent_id);
  return { agent_id: scout.agent_id, removed: true, ...(stopError ? { stop_warning: stopError } : {}) };
}

export function handleListWaitingInput(stateDir: string) {
  const claims = readClaims(stateDir).claims;
  const waiting = claims.filter((c) => c.input_state === 'awaiting_input');

  const inputRequestedEvents = queryEvents(stateDir, { event_type: 'input_requested' });
  const questionMap = new Map<string, { question: string | null; ts: string | null }>();
  for (const ev of inputRequestedEvents) {
    const record = ev as unknown as Record<string, unknown>;
    if (typeof record.run_id === 'string') {
      const payload = record.payload as Record<string, unknown> | undefined;
      questionMap.set(record.run_id, {
        question: typeof payload?.question === 'string' ? payload.question : null,
        ts: typeof ev.ts === 'string' ? ev.ts : null,
      });
    }
  }

  const now = Date.now();
  return waiting.map((c) => {
    const info = questionMap.get(c.run_id) ?? { question: null, ts: null };
    const waitingSec = info.ts ? Math.round((now - new Date(info.ts).getTime()) / 1000) : null;
    return {
      run_id: c.run_id,
      agent_id: c.agent_id,
      task_ref: c.task_ref,
      question: info.question,
      waiting_seconds: waitingSec,
      input_requested_at: info.ts,
    };
  });
}

export function handleQueryEvents(
  stateDir: string,
  { run_id, agent_id, event_type, after_seq, limit = 50, fts_query }: Record<string, unknown> = {},
) {
  const opts: Parameters<typeof queryEvents>[1] = {
    limit: Number.isInteger(limit) ? (limit as number) : 50,
  };
  if (typeof run_id === 'string') opts.run_id = run_id;
  if (typeof agent_id === 'string') opts.agent_id = agent_id;
  if (typeof event_type === 'string') opts.event_type = event_type;
  if (typeof after_seq === 'number') opts.after_seq = after_seq;
  if (typeof fts_query === 'string') opts.fts_query = fts_query;
  try {
    return queryEvents(stateDir, opts);
  } catch (err) {
    return { error: `query_events failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function handleResetTask(stateDir: string, args: Record<string, unknown> = {}) {
  return resetTask(stateDir, args);
}

export function handleUnblockTask(stateDir: string, args: Record<string, unknown> = {}) {
  return unblockTask(stateDir, args);
}

export function handleListWorktrees(stateDir: string) {
  const worktrees = readRunWorktreesState(stateDir);
  const claims = readClaims(stateDir).claims;
  const backlog = readBacklogFresh(stateDir);

  const claimByRunId = new Map(claims.map((c) => [c.run_id, c]));

  return worktrees.runs.map((entry) => {
    const claim = claimByRunId.get(entry.run_id) ?? null;
    const agentId = claim?.agent_id ?? entry.agent_id;
    const taskRef = claim?.task_ref ?? entry.task_ref;
    const task = findTask(backlog, taskRef);
    return {
      run_id: entry.run_id,
      task_ref: taskRef,
      agent_id: agentId,
      path: entry.worktree_path,
      branch: entry.branch,
      created_at: entry.created_at,
      task_title: task?.title ?? null,
    };
  });
}

export function handleRespondInput(stateDir: string, args: Record<string, unknown> = {}) {
  return respondInput(stateDir, args);
}

export function handleGetNotifications(stateDir: string, { after_seq }: { after_seq?: unknown } = {}) {
  const afterSeq = after_seq == null ? 0 : (after_seq as number);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    throw new Error('after_seq must be a non-negative integer');
  }
  const notifications = queryNotificationEvents(stateDir, afterSeq);
  const lastSeq = notifications.length > 0
    ? (notifications[notifications.length - 1].seq ?? afterSeq)
    : afterSeq;
  return { notifications, last_seq: lastSeq };
}

/**
 * The /plan and /spec verbs write Markdown that only a legacy installation registers; a project's
 * coordinator never reads it, so their output would silently never become tasks.
 */
function assertLegacyVerb(stateDir: string, tool: string) {
  if (!isProjectStateDir(stateDir)) return;
  throw new Error(`${tool} is legacy-only: a registered project does not register Markdown plans or specs. `
    + 'Create tasks with create_task (body_markdown) or orc project task import, and plans with orc project plan import');
}

export async function handlePlanWrite(stateDir: string, args: Record<string, unknown> = {}) {
  assertLegacyVerb(stateDir, 'plan_write');
  const {
    name,
    title,
    objective,
    scope,
    out_of_scope,
    constraints,
    affected_areas,
    steps,
    acknowledge_feature_collision,
  } = args;

  if (typeof name !== 'string') throw new Error('name is required');
  if (typeof title !== 'string') throw new Error('title is required');
  if (typeof objective !== 'string') throw new Error('objective is required');
  if (typeof scope !== 'string') throw new Error('scope is required');
  if (typeof out_of_scope !== 'string') throw new Error('out_of_scope is required');
  if (typeof constraints !== 'string') throw new Error('constraints is required');
  if (typeof affected_areas !== 'string') throw new Error('affected_areas is required');
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps must be a non-empty array');
  }
  if (
    acknowledge_feature_collision !== undefined
    && typeof acknowledge_feature_collision !== 'boolean'
  ) {
    throw new Error('acknowledge_feature_collision must be a boolean');
  }

  const normalizedSteps: WritePlanInput['steps'] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] as Record<string, unknown>;
    if (!step || typeof step !== 'object') {
      throw new Error(`steps[${i + 1}] must be an object`);
    }
    if (typeof step.title !== 'string') throw new Error(`steps[${i + 1}].title is required`);
    if (typeof step.body !== 'string') throw new Error(`steps[${i + 1}].body is required`);
    const depends = step.depends_on;
    const normalized: WritePlanInput['steps'][number] = {
      title: step.title,
      body: step.body,
    };
    if (depends !== undefined) {
      if (!Array.isArray(depends) || depends.some((d) => !Number.isInteger(d))) {
        throw new Error(`steps[${i + 1}].depends_on must be an array of integers`);
      }
      normalized.dependsOn = depends as number[];
    }
    normalizedSteps.push(normalized);
  }

  try {
    return await writePlan(
      {
        name,
        title,
        objective,
        scope,
        outOfScope: out_of_scope,
        constraints,
        affectedAreas: affected_areas,
        steps: normalizedSteps,
      },
      {
        stateDir,
        plansDir: plansDirForState(stateDir),
        acknowledgeFeatureCollision: acknowledge_feature_collision === true,
      },
    );
  } catch (err) {
    if (err instanceof PlanAuthoringError) {
      throw new Error(err.message);
    }
    throw err;
  }
}

/** "Not initialized" only when the state directory is missing; any other failure keeps its own text. */
function memoryFailure(stateDir: string, err: unknown): string {
  if (!existsSync(stateDir)) return 'memory system not initialized';
  return `memory failed: ${err instanceof Error ? err.message : String(err)}`;
}

export function handleMemoryWakeUp(stateDir: string, args: Record<string, unknown> = {}) {
  const { wing, tokenBudget } = args;
  try {
    const text = memoryWakeUp(stateDir, {
      ...(typeof wing === 'string' ? { wing } : {}),
      ...(typeof tokenBudget === 'number' ? { tokenBudget } : {}),
    });
    return { text };
  } catch (err) {
    return { error: memoryFailure(stateDir, err) };
  }
}

export function handleMemoryRecall(stateDir: string, args: Record<string, unknown> = {}) {
  const { wing, room, limit } = args;
  if (typeof wing !== 'string') throw new Error('wing is required');
  try {
    const drawers = listDrawers(stateDir, {
      wing,
      ...(typeof room === 'string' ? { room } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
    return { drawers };
  } catch (err) {
    return { error: memoryFailure(stateDir, err) };
  }
}

export function handleMemorySearch(stateDir: string, args: Record<string, unknown> = {}) {
  const { query, wing, room, limit } = args;
  if (typeof query !== 'string') throw new Error('query is required');
  try {
    const results = searchMemory(stateDir, {
      query,
      ...(typeof wing === 'string' ? { wing } : {}),
      ...(typeof room === 'string' ? { room } : {}),
      ...(typeof limit === 'number' ? { limit } : {}),
    });
    return { results };
  } catch (err) {
    return { error: memoryFailure(stateDir, err) };
  }
}

export function handleMemoryStore(stateDir: string, args: Record<string, unknown> = {}) {
  const { content, wing, hall, room, importance, sourceType, sourceRef } = args;
  if (typeof content !== 'string') throw new Error('content is required');
  try {
    const id = storeDrawer(stateDir, {
      content,
      wing: typeof wing === 'string' ? wing : 'general',
      hall: typeof hall === 'string' ? hall : 'default',
      room: typeof room === 'string' ? room : 'default',
      ...(typeof importance === 'number' ? { importance } : {}),
      ...(typeof sourceType === 'string' ? { sourceType } : {}),
      ...(typeof sourceRef === 'string' ? { sourceRef } : {}),
    });
    return { id };
  } catch (err) {
    return { error: memoryFailure(stateDir, err) };
  }
}

export function handleMemoryStatus(stateDir: string, _args: Record<string, unknown> = {}) {
  try {
    const stats = getMemoryStats(stateDir);
    return { stats };
  } catch (err) {
    return { error: memoryFailure(stateDir, err) };
  }
}

function specOptsFromArgs(stateDir: string, args: Record<string, unknown>) {
  const { worktree_path } = args;
  if (worktree_path !== undefined && typeof worktree_path !== 'string') {
    throw new Error('worktree_path must be a string');
  }
  return {
    stateDir,
    ...(typeof worktree_path === 'string' ? { worktreePath: worktree_path } : {}),
  };
}

export function handleSpecPreview(stateDir: string, args: Record<string, unknown> = {}) {
  assertLegacyVerb(stateDir, 'spec_preview');
  const { plan_id } = args;
  if (typeof plan_id !== 'number' || !Number.isInteger(plan_id)) {
    throw new Error('plan_id must be a non-negative integer');
  }
  return previewSpec(plan_id, specOptsFromArgs(stateDir, args));
}

export function handleSpecPublish(stateDir: string, args: Record<string, unknown> = {}) {
  assertLegacyVerb(stateDir, 'spec_publish');
  const { plan_id, confirm } = args;
  if (typeof plan_id !== 'number' || !Number.isInteger(plan_id)) {
    throw new Error('plan_id must be a non-negative integer');
  }
  if (confirm !== true) {
    throw new Error('confirm must be true to publish');
  }
  return publishSpec(plan_id, { confirm: true, ...specOptsFromArgs(stateDir, args) });
}

export { closeMemoryDb };
