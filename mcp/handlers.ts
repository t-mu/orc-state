import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { closeMemoryDb, getMemoryStats, listDrawers, memoryWakeUp, searchMemory, storeDrawer } from '../lib/memoryStore.ts';

import { taskSnapshotStatus } from '../lib/documentIndex.ts';
import { getLastNotificationSeq, queryEvents, queryNotificationEvents } from '../lib/eventLog.ts';
import { getAgent, listAgents } from '../lib/agentRegistry.ts';
import { findTask, readBacklog, readClaims } from '../lib/stateReader.ts';
import { evaluateTaskEligibility } from '../lib/taskRouting.ts';
import { RUN_WORKTREES_FILE } from '../lib/paths.ts';
import { readProjectDescriptor } from '../lib/projectContext.ts';
import { readRunActivity } from '../lib/runActivityStore.ts';
import { isStalled, runIdleAnchor } from '../lib/runSignals.ts';
import { selectCurrentActivity, type CurrentActivity } from '../lib/currentActivity.ts';
import { AGENT_ID_RE, AGENT_ROLES, TASK_STATUSES } from '../lib/constants.ts';
import { createProjectTask, describeProjectTask, projectTaskStoreFor, requireProjectTaskStore, reviseProjectTask } from '../lib/projectTasks.ts';
import { TERMINAL_STATUSES, masterActorId } from '../lib/operatorMutations.ts';
import { extractScoutReport, launchScout, prepareScout, readScoutReport, removeScout } from '../lib/scouts.ts';
import { listWaitingInput } from '../lib/waitingInput.ts';
import { describeCoordinator, restartCoordinator } from '../lib/coordinatorProcess.ts';
import type { Task } from '../types/backlog.ts';
import type { RunWorktreesState } from '../types/run-worktrees.ts';

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
  const backlog = readBacklog(stateDir);
  let tasks = backlog.features.flatMap((featureObj) =>
    featureObj.tasks.map((task): Task & { feature_ref: string } => ({ ...task, feature_ref: featureObj.ref })),
  );

  if (status) {
    tasks = tasks.filter((task) => task.status === status);
  } else {
    // Exclude terminal statuses by default to keep payload small.
    // Use status="done" or "cancelled" to retrieve terminal tasks explicitly.
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
  return agents.map((agent) => (agent.role === 'scout'
    // A scout holds no claim; list it by id and state, as get_scout_report reports it.
    ? {
      agent_id: agent.agent_id,
      role: agent.role,
      provider: agent.provider,
      model: agent.model ?? null,
      status: agent.status,
      session_handle: agent.session_handle ?? null,
      launched_at: agent.registered_at ?? null,
    }
    : {
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
  const hookActivity = readRunActivity(stateDir);
  // Same liveness as the coordinator: a hook-observed tool call or label counts, and the
  // shared isStalled (lib/runSignals.ts) excludes a run waiting for input or running a tool call.
  return readClaims(stateDir).claims
    .filter((claim) => ['claimed', 'in_progress'].includes(claim.state))
    .map((claim) => {
      // Durable activity events are not read here; the heartbeat they renew stands in for them.
      const anchor = runIdleAnchor(claim, null, hookActivity[claim.run_id]) ?? claim.claimed_at;
      return { claim, stale_for_ms: now - new Date(anchor).getTime() };
    })
    .filter(({ claim, stale_for_ms }) => isStalled(claim, stale_for_ms, hookActivity[claim.run_id], stale_after_ms as number, now))
    .map(({ claim, stale_for_ms }) => ({ ...claim, stale_for_ms }));
}

export function handleGetTask(stateDir: string, { task_ref }: { task_ref?: unknown } = {}) {
  if (!task_ref) throw new Error('task_ref is required');
  const store = projectTaskStoreFor(stateDir);
  if (store) {
    const projectTask = store.getTask(task_ref as string);
    return projectTask ? describeProjectTask(projectTask) : { error: 'not_found', task_ref };
  }
  const backlog = readBacklog(stateDir);
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

  const backlog = readBacklog(stateDir);
  const claims = readClaims(stateDir).claims;
  const agents = listAgents(stateDir).filter((agent) => agent.status !== 'dead');

  const activeClaimsByAgent = new Map<string, string | null>();
  const activeRunIdByTask = new Map<string, string>();
  for (const claim of claims) {
    if (!['claimed', 'in_progress'].includes(claim.state)) continue;
    if (!activeClaimsByAgent.has(claim.agent_id)) {
      activeClaimsByAgent.set(claim.agent_id, claim.task_ref ?? null);
    }
    if (claim.task_ref && !activeRunIdByTask.has(claim.task_ref)) activeRunIdByTask.set(claim.task_ref, claim.run_id);
  }

  const activitySnapshots = activeRunIdByTask.size > 0 ? readRunActivity(stateDir) : {};
  const nowMs = Date.now();

  const taskCounts: Record<string, number> = {
    todo: 0,
    claimed: 0,
    in_progress: 0,
    blocked: 0,
  };

  if (include_done_count) {
    taskCounts.done = 0;
    taskCounts.cancelled = 0;
  }

  // current_activity is present only on tasks with an active run (keeps the response compact).
  const activeTasks: Array<{ ref: string; title: string; status: string; feature_ref: string; owner: string | null; current_activity?: CurrentActivity | null }> = [];
  for (const feature of backlog.features) {
    for (const task of feature.tasks) {
      if (Object.hasOwn(taskCounts, task.status)) {
        taskCounts[task.status] += 1;
      }
      if (TERMINAL_STATUSES.has(task.status)) continue;
      const runId = activeRunIdByTask.get(task.ref);
      activeTasks.push({
        ref: task.ref,
        title: task.title,
        status: task.status,
        feature_ref: feature.ref,
        owner: task.owner ?? null,
        ...(runId ? { current_activity: selectCurrentActivity(activitySnapshots[runId], nowMs) } : {}),
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
    // The registered project this state belongs to.
    project: (() => {
      const descriptor = readProjectDescriptor(stateDir);
      return descriptor ? { id: descriptor.id, name: descriptor.name, target_repo_root: descriptor.target_repo_root } : null;
    })(),
  };
}

export function handleGetAgentWorkview(stateDir: string, { agent_id }: { agent_id?: unknown } = {}) {
  if (!agent_id) throw new Error('agent_id is required');

  const agents = listAgents(stateDir);
  const agent = agents.find((entry) => entry.agent_id === agent_id);
  if (!agent) return { error: 'not_found', agent_id };
  // A scout has no run or tasks; get_scout_report is its view.
  if (agent.role === 'scout') return { error: 'scout', agent_id, hint: 'read a scout with get_scout_report' };

  const backlog = readBacklog(stateDir);
  const claims = readClaims(stateDir).claims;

  const activeRun = claims.find((claim) =>
    claim.agent_id === agent_id && ['claimed', 'in_progress'].includes(claim.state),
  ) ?? null;

  const doneSet = new Set(
    backlog.features.flatMap((feature) =>
      feature.tasks
        .filter((task) => task.status === 'done')
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
          current_activity: selectCurrentActivity(readRunActivity(stateDir)[activeRun.run_id]),
        }
      : null,
    queued_tasks: queuedTasks,
    blockers,
    recommended_action: recommendedAction,
  };
}

export function handleReadBacklog(stateDir: string) {
  return JSON.stringify(readBacklog(stateDir), null, 2);
}

export function handleReadAgents(stateDir: string) {
  return readFileSync(join(stateDir, 'agents.json'), 'utf8');
}

export function handleCreateTask(stateDir: string, args: Record<string, unknown> = {}) {
  // Project tasks are database-only: no Markdown spec is required or written. A missing database fails.
  requireProjectTaskStore(stateDir);
  const { actor_id = defaultActorId(stateDir), ...input } = args;
  assertActorId(stateDir, actor_id);
  return describeProjectTask(createProjectTask(stateDir, input, actor_id as string));
}

export function handleUpdateTask(stateDir: string, args: Record<string, unknown> = {}) {
  requireProjectTaskStore(stateDir);
  const { task_ref, expected_revision, actor_id = defaultActorId(stateDir), ...changes } = args;
  if (typeof task_ref !== 'string' || !task_ref) throw new Error('task_ref is required');
  assertActorId(stateDir, actor_id);
  const { task, changed } = reviseProjectTask(stateDir, task_ref, expected_revision, changes, actor_id as string);
  return { ...describeProjectTask(task), changed };
}

function readRunWorktreesState(stateDir?: string): RunWorktreesState {
  const path = stateDir ? join(stateDir, 'run-worktrees.json') : RUN_WORKTREES_FILE;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunWorktreesState;
  } catch {
    return { version: '1', runs: [] };
  }
}

export function handleGetRun(stateDir: string, { run_id }: { run_id?: unknown } = {}) {
  if (!run_id) throw new Error('run_id is required');
  const claims = readClaims(stateDir).claims;
  const claim = claims.find((c) => c.run_id === run_id);
  if (!claim) return { error: 'not_found', run_id };

  const backlog = readBacklog(stateDir);
  const task = findTask(backlog, claim.task_ref);
  const taskTitle = task?.title ?? null;

  const worktrees = readRunWorktreesState(stateDir);
  const wtEntry = worktrees.runs.find((e) => e.run_id === run_id);
  const worktreePath = wtEntry?.worktree_path ?? null;

  return { ...claim, task_title: taskTitle, worktree_path: worktreePath,
    task_spec_revision_status: claim.task_spec_snapshot ? taskSnapshotStatus(claim.task_spec_snapshot, stateDir) : 'unknown' };
}

/** Launch a scout and brief it, waiting until it is ready; the coordinator's own path is `request-scout` (lib/scouts.ts). */
export async function handleRequestScout(stateDir: string, { actor_id = defaultActorId(stateDir), ...request }: Record<string, unknown> = {}) {
  assertActorId(stateDir, actor_id);
  const actor = typeof actor_id === 'string' ? getAgent(stateDir, actor_id) : null;
  if (actor_id !== 'human' && actor?.role !== 'master') {
    throw new Error(`request_scout may only be invoked by master or human actors; got role '${actor?.role ?? 'unknown'}'`);
  }
  return launchScout(stateDir, prepareScout(stateDir, request, actor?.provider ?? null));
}

export { extractScoutReport };

export function handleGetScoutReport(stateDir: string, { agent_id }: Record<string, unknown> = {}) {
  return readScoutReport(stateDir, agent_id);
}

export function handleRemoveScout(stateDir: string, { agent_id }: Record<string, unknown> = {}) {
  return removeScout(stateDir, agent_id);
}


/** Same as `orc coordinator restart --json`: the new coordinator is detached, so it outlives this MCP server. */
export async function handleRestartCoordinator(stateDir: string, projectId: string) {
  const { previous_pid } = await restartCoordinator(stateDir, projectId);
  return { action: 'restart', changed: true, ...await describeCoordinator(stateDir), previous_pid };
}

export function handleListWaitingInput(stateDir: string) {
  return listWaitingInput(stateDir, readClaims(stateDir).claims);
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

export function handleListWorktrees(stateDir: string) {
  const worktrees = readRunWorktreesState(stateDir);
  const claims = readClaims(stateDir).claims;
  const backlog = readBacklog(stateDir);

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

export { closeMemoryDb };
