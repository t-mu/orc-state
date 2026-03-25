import { join } from 'node:path';
import { listCoordinatorAgents } from './agentRegistry.ts';
import { readEvents, readRecentEvents } from './eventLog.ts';
import { latestRunActivityDetailMap } from './runActivity.ts';
import { loadWorkerPoolConfig } from './providers.ts';
import { readJson } from './stateReader.ts';
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';
import type { Backlog } from '../types/backlog.ts';
import { STALLED_RUN_IDLE_SECONDS } from './constants.ts';
const STARTUP_FAILURE_LIMIT = 5;
const LIFECYCLE_FAILURE_LIMIT = 5;

function isManagedSlot(agentId: string | undefined, maxWorkers: number): boolean {
  const match = /^orc-(\d+)$/.exec(agentId ?? '');
  if (!match) return false;
  const slotNumber = Number(match[1]);
  return Number.isInteger(slotNumber) && slotNumber >= 1 && slotNumber <= maxWorkers;
}

interface TaskCounts {
  counts: Record<string, number>;
  total: number;
}

function buildTaskCounts(backlogFile: Backlog): TaskCounts {
  const taskStatuses: Record<string, string> = {};
  for (const feature of (backlogFile.features ?? [])) {
    for (const task of (feature.tasks ?? [])) {
      if (task?.ref) taskStatuses[task.ref] = task.status;
    }
  }

  const taskCounts: Record<string, number> = {};
  for (const status of Object.values(taskStatuses)) {
    taskCounts[status] = (taskCounts[status] ?? 0) + 1;
  }

  return {
    counts: taskCounts,
    total: Object.keys(taskStatuses).length,
  };
}

export interface DispatchReadyTask {
  ref: string;
  title: string;
  feature_ref: string;
  priority: string;
}

export function listDispatchReadyTasks(backlogFile: Backlog): DispatchReadyTask[] {
  const doneSet = new Set<string>();
  const ready: DispatchReadyTask[] = [];

  for (const feature of (backlogFile.features ?? [])) {
    for (const task of (feature.tasks ?? [])) {
      if (task.status === 'done' || task.status === 'released') {
        doneSet.add(task.ref);
      }
    }
  }

  for (const feature of (backlogFile.features ?? [])) {
    for (const task of (feature.tasks ?? [])) {
      if (task.status !== 'todo') continue;
      if (task.planning_state && task.planning_state !== 'ready_for_dispatch') continue;
      const deps = task.depends_on ?? [];
      if (!deps.every((dep) => doneSet.has(dep))) continue;
      ready.push({
        ref: task.ref,
        title: task.title,
        feature_ref: feature.ref,
        priority: task.priority ?? 'normal',
      });
    }
  }

  return ready;
}

function classifyWorkerSlot(slot: Agent, activeClaim: Claim | null): string {
  if (activeClaim) return 'busy';
  if (slot.status === 'offline') return 'unavailable';
  if (slot.status === 'running' && !slot.session_handle) return 'warming';
  return 'available';
}

interface FailureEntry {
  ts: string | null;
  run_id: string | null;
  task_ref: string | null;
  agent_id: string | null;
  reason: string;
  event?: string;
}

function collectRecentFailures(events: unknown[]): { startup: FailureEntry[]; lifecycle: FailureEntry[] } {
  const startup: FailureEntry[] = [];
  const lifecycle: FailureEntry[] = [];

  for (const ev of events) {
    const event = ev as { event?: string; ts?: string; run_id?: string; task_ref?: string; agent_id?: string; payload?: { reason?: string; message?: string } };
    if (event?.event === 'session_start_failed') {
      startup.push({
        ts: event.ts ?? null,
        run_id: event.run_id ?? null,
        task_ref: event.task_ref ?? null,
        agent_id: event.agent_id ?? null,
        reason: event.payload?.reason ?? '',
      });
    }

    if (event?.event === 'run_failed' || event?.event === 'blocked') {
      lifecycle.push({
        ts: event.ts ?? null,
        event: event.event,
        run_id: event.run_id ?? null,
        task_ref: event.task_ref ?? null,
        agent_id: event.agent_id ?? null,
        reason: event.payload?.reason ?? event.payload?.message ?? '',
      });
    }
  }

  return {
    startup: startup.slice(-STARTUP_FAILURE_LIMIT),
    lifecycle: lifecycle.slice(-LIFECYCLE_FAILURE_LIMIT),
  };
}

interface RunWorktreeEntry {
  run_id: string;
  worktree_path?: string;
  branch?: string;
}

function readRunWorktrees(stateDir: string): RunWorktreeEntry[] {
  try {
    return (readJson(stateDir, 'run-worktrees.json') as { runs?: RunWorktreeEntry[] }).runs ?? [];
  } catch {
    return [];
  }
}

/**
 * Build a structured status object from base state files + recent events.
 * All fields are plain data — formatting is the CLI's responsibility.
 */
export function buildStatus(stateDir: string): Record<string, unknown> {
  const claimsFile = readJson(stateDir, 'claims.json') as { claims?: Claim[] };
  const backlogFile = readJson(stateDir, 'backlog.json') as Backlog;
  const workerPoolConfig = loadWorkerPoolConfig({
    env: process.env,
    configFile: join(stateDir, '..', 'orchestrator.config.json'),
  });
  const agents = listCoordinatorAgents(stateDir, workerPoolConfig);
  const master = agents.find((agent) => agent.role === 'master') ?? null;

  const claims = claimsFile.claims ?? [];
  const runWorktrees = readRunWorktrees(stateDir);
  const runWorktreeByRunId = new Map(runWorktrees.map((entry) => [entry.run_id, entry]));

  const activeClaims = claims.filter((c) => ['claimed', 'in_progress'].includes(c.state));
  const awaitingRunStarted = activeClaims.filter((c) => c.state === 'claimed').length;
  const inProgressRuns = activeClaims.filter((c) => c.state === 'in_progress').length;

  const eventsPath = join(stateDir, 'events.db');
  let allEvents: unknown[] = [];
  let recentEvents: unknown[] = [];
  let eventReadError = '';
  try {
    allEvents = readEvents(eventsPath);
    recentEvents = readRecentEvents(eventsPath, 20);
  } catch (error) {
    eventReadError = (error as Error).message;
  }

  const runActivity = latestRunActivityDetailMap(allEvents as Parameters<typeof latestRunActivityDetailMap>[0]);
  const nowMs = Date.now();

  const activeClaimsWithMetrics = activeClaims.map((claim) => {
    const claimedAtMs = claim.claimed_at ? new Date(claim.claimed_at).getTime() : NaN;
    const activity = runActivity.get(claim.run_id) ?? null;
    const idleAnchor = activity?.ts
      ?? claim.last_heartbeat_at
      ?? claim.started_at
      ?? claim.claimed_at
      ?? null;
    const idleMs = idleAnchor ? nowMs - new Date(idleAnchor).getTime() : NaN;
    return {
      ...claim,
      age_seconds: Number.isNaN(claimedAtMs) ? null : Math.max(0, Math.round((nowMs - claimedAtMs) / 1000)),
      idle_seconds: Number.isNaN(idleMs) ? null : Math.max(0, Math.round(idleMs / 1000)),
      last_activity_at: activity?.ts ?? null,
      last_activity_event: activity?.event ?? null,
      last_activity_source: activity?.source ?? null,
      stalled: !Number.isNaN(idleMs) && idleMs >= (STALLED_RUN_IDLE_SECONDS * 1000),
      run_worktree_path: runWorktreeByRunId.get(claim.run_id)?.worktree_path ?? null,
      run_branch: runWorktreeByRunId.get(claim.run_id)?.branch ?? null,
    };
  });

  const activeClaimByAgentId = new Map(
    activeClaimsWithMetrics
      .filter((claim) => claim.agent_id)
      .map((claim) => [claim.agent_id, claim]),
  );
  const workerSlots = agents.filter((agent) => isManagedSlot(agent.agent_id, workerPoolConfig.max_workers));
  const slotDetails = workerSlots.map((slot) => {
    const activeClaim = activeClaimByAgentId.get(slot.agent_id) ?? null;
    return {
      agent_id: slot.agent_id,
      provider: slot.provider,
      model: slot.model ?? null,
      status: slot.status,
      session_handle: slot.session_handle ?? null,
      slot_state: classifyWorkerSlot(slot, activeClaim),
      active_run_id: activeClaim?.run_id ?? null,
      active_task_ref: activeClaim?.task_ref ?? null,
      last_status_change_at: slot.last_status_change_at ?? null,
      last_heartbeat_at: slot.last_heartbeat_at ?? null,
    };
  });
  const dispatchReadyTasks = listDispatchReadyTasks(backlogFile);
  const availableSlots = slotDetails.filter((slot) => slot.slot_state === 'available').length;
  const startupFailures = collectRecentFailures(allEvents);
  const tasks = buildTaskCounts(backlogFile);
  const finalizationRuns = activeClaimsWithMetrics
    .filter((claim) => claim.finalization_state != null)
    .map((claim) => ({
      run_id: claim.run_id,
      task_ref: claim.task_ref ?? null,
      agent_id: claim.agent_id ?? null,
      finalization_state: claim.finalization_state,
      finalization_retry_count: claim.finalization_retry_count ?? 0,
      finalization_blocked_reason: claim.finalization_blocked_reason ?? null,
      run_worktree_path: claim.run_worktree_path,
      run_branch: claim.run_branch,
      idle_seconds: claim.idle_seconds,
    }));
  const blockedFinalizationRuns = finalizationRuns.filter((claim) => claim.finalization_state === 'blocked_finalize');

  return {
    agents: {
      total: agents.length,
      masters: agents.filter((a) => a.role === 'master').length,
      workers: agents.filter((a) => a.role !== 'master').length,
      running: agents.filter((a) => a.status === 'running').length,
      idle: agents.filter((a) => a.status === 'idle').length,
      offline: agents.filter((a) => a.status === 'offline').length,
      list: agents,
    },
    master: master ? {
      agent_id: master.agent_id,
      provider: master.provider,
      model: master.model ?? null,
      status: master.status ?? 'unknown',
      session_handle: master.session_handle ?? null,
      last_heartbeat_at: master.last_heartbeat_at ?? null,
    } : null,
    worker_capacity: {
      configured_slots: workerPoolConfig.max_workers,
      provider: workerPoolConfig.provider,
      model: workerPoolConfig.model,
      used_slots: slotDetails.filter((slot) => slot.slot_state === 'busy').length,
      available_slots: availableSlots,
      warming_slots: slotDetails.filter((slot) => slot.slot_state === 'warming').length,
      unavailable_slots: slotDetails.filter((slot) => slot.slot_state === 'unavailable').length,
      slots: slotDetails,
      dispatch_ready_tasks: dispatchReadyTasks,
      dispatch_ready_count: dispatchReadyTasks.length,
      waiting_for_capacity: Math.max(0, dispatchReadyTasks.length - availableSlots),
    },
    tasks,
    claims: {
      active: activeClaimsWithMetrics,
      total: activeClaimsWithMetrics.length,
      awaiting_run_started: awaitingRunStarted,
      in_progress: inProgressRuns,
      stalled: activeClaimsWithMetrics.filter((claim) => claim.stalled).length,
    },
    finalization: {
      total: finalizationRuns.length,
      awaiting_finalize: finalizationRuns.filter((claim) => claim.finalization_state === 'awaiting_finalize').length,
      finalize_rebase_requested: finalizationRuns.filter((claim) => claim.finalization_state === 'finalize_rebase_requested').length,
      finalize_rebase_in_progress: finalizationRuns.filter((claim) => claim.finalization_state === 'finalize_rebase_in_progress').length,
      ready_to_merge: finalizationRuns.filter((claim) => claim.finalization_state === 'ready_to_merge').length,
      blocked_finalize: blockedFinalizationRuns.length,
      active: finalizationRuns,
      blocked_preserved: blockedFinalizationRuns,
    },
    failures: startupFailures,
    recentEvents,
    eventReadError,
  };
}

export function buildAgentStatus(stateDir: string, agentId: string): Record<string, unknown> {
  const status = buildStatus(stateDir);
  const backlogFile = readJson(stateDir, 'backlog.json') as Backlog;
  const agentList = (status['agents'] as { list: Agent[] }).list;
  const agent = agentList.find((entry) => entry.agent_id === agentId) ?? null;
  const activeClaims = ((status['claims'] as { active: (Claim & Record<string, unknown>)[] }).active).filter((claim) => claim.agent_id === agentId);
  const claimedTaskRefs = new Set(activeClaims.map((claim) => claim.task_ref));
  const queuedTasks: unknown[] = [];

  for (const feature of backlogFile.features ?? []) {
    for (const task of feature.tasks ?? []) {
      if (task.owner !== agentId) continue;
      if (task.status === 'done' || task.status === 'released') continue;
      if (claimedTaskRefs.has(task.ref)) continue;
      queuedTasks.push({
        ref: task.ref,
        title: task.title,
        status: task.status,
        feature_ref: feature.ref,
        task_type: task.task_type ?? 'implementation',
        planning_state: task.planning_state ?? 'ready_for_dispatch',
      });
    }
  }

  return {
    agent,
    assigned_tasks: activeClaims,
    queued_tasks: queuedTasks,
  };
}

/**
 * Format a status object as a human-readable string for terminal output.
 */
export function formatStatus(status: Record<string, unknown>): string {
  const lines: string[] = [];
  const master = status['master'] as { agent_id: string; provider: string; status: string; session_handle: string | null } | null;
  const workerCapacity = status['worker_capacity'] as {
    configured_slots: number;
    used_slots: number;
    available_slots: number;
    warming_slots: number;
    unavailable_slots: number;
    provider: string;
    dispatch_ready_count: number;
    waiting_for_capacity: number;
    dispatch_ready_tasks: Array<{ ref: string }>;
    slots: Array<{ session_handle: string | null; agent_id: string; slot_state: string; status: string; active_run_id: string | null; active_task_ref: string | null }>;
  };
  const claims = status['claims'] as {
    total: number;
    awaiting_run_started: number;
    in_progress: number;
    stalled: number;
    active: Array<{
      run_id: string;
      task_ref?: string;
      agent_id?: string;
      state: string;
      lease_expires_at?: string;
      stalled: boolean;
      finalization_state?: string | null;
      finalization_retry_count?: number;
      age_seconds?: number | null;
      idle_seconds?: number | null;
    }>;
  };
  const finalization = status['finalization'] as {
    total: number;
    awaiting_finalize: number;
    finalize_rebase_requested: number;
    finalize_rebase_in_progress: number;
    ready_to_merge: number;
    blocked_finalize: number;
    active: Array<{
      run_id: string;
      finalization_state: string;
      finalization_retry_count: number;
      finalization_blocked_reason?: string | null;
      run_worktree_path?: string | null;
      run_branch?: string | null;
    }>;
  };
  const failures = status['failures'] as { startup: FailureEntry[]; lifecycle: FailureEntry[] };
  const tasksStatus = status['tasks'] as { total: number; counts: Record<string, number> };
  const eventReadError = status['eventReadError'] as string;

  lines.push('Orchestrator Status');
  lines.push('─'.repeat(40));
  lines.push('');
  lines.push('Master:');
  if (!master) {
    lines.push('  (not registered)');
  } else {
    lines.push(
      `  ${master.agent_id} ${master.provider} ${master.status} ${master.session_handle ? 'attached' : 'detached'}`,
    );
  }

  lines.push('');
  lines.push('Worker Capacity:');
  lines.push(`  configured_slots:    ${workerCapacity.configured_slots}`);
  lines.push(`  used_slots:          ${workerCapacity.used_slots}`);
  lines.push(`  available_slots:     ${workerCapacity.available_slots}`);
  lines.push(`  warming_slots:       ${workerCapacity.warming_slots}`);
  lines.push(`  unavailable_slots:   ${workerCapacity.unavailable_slots}`);
  lines.push(`  slot_provider:       ${workerCapacity.provider}`);
  lines.push(`  dispatch_ready:      ${workerCapacity.dispatch_ready_count}`);
  lines.push(`  waiting_for_capacity:${` ${workerCapacity.waiting_for_capacity}`}`);
  if (workerCapacity.dispatch_ready_tasks.length === 0) {
    lines.push('  queue:               (none)');
  } else {
    for (const task of workerCapacity.dispatch_ready_tasks.slice(0, 3)) {
      lines.push(`  queue:               ${task.ref}`);
    }
    if (workerCapacity.dispatch_ready_tasks.length > 3) {
      lines.push(`  queue:               +${workerCapacity.dispatch_ready_tasks.length - 3} more`);
    }
  }
  const spawnedSlots = workerCapacity.slots.filter((slot) => slot.session_handle !== null);
  if (spawnedSlots.length === 0) {
    lines.push('  slots: (none spawned)');
  } else {
    for (const slot of spawnedSlots) {
      const suffix = slot.active_run_id
        ? ` run=${slot.active_run_id} task=${slot.active_task_ref ?? 'n/a'}`
        : '';
      lines.push(`  ${slot.agent_id.padEnd(12)} ${slot.slot_state.padEnd(12)} ${slot.status.padEnd(10)}${suffix}`);
    }
  }

  lines.push('');
  lines.push(`Active Runs (${claims.total}):`);
  lines.push(`  awaiting_run_started: ${claims.awaiting_run_started ?? 0}`);
  lines.push(`  in_progress:          ${claims.in_progress ?? 0}`);
  lines.push(`  stalled:              ${claims.stalled ?? 0}`);
  if (claims.active.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of claims.active) {
      const exp = c.lease_expires_at ? `expires ${msUntil(c.lease_expires_at)}` : '';
      const stalledLabel = c.stalled ? ' stalled' : '';
      const finalizationLabel = c.finalization_state
        ? ` finalize=${c.finalization_state} retry=${c.finalization_retry_count ?? 0}`
        : '';
      lines.push(
        `  ${c.run_id.padEnd(24)} ${(c.task_ref ?? '').padEnd(24)} ${(c.agent_id ?? '').padEnd(12)} ${c.state.padEnd(12)} ${exp} age=${c.age_seconds ?? '?'}s idle=${c.idle_seconds ?? '?'}s${finalizationLabel}${stalledLabel}`,
      );
    }
  }

  lines.push('');
  lines.push(`Finalization (${finalization.total}):`);
  lines.push(`  awaiting_finalize:        ${finalization.awaiting_finalize}`);
  lines.push(`  finalize_rebase_requested:${` ${finalization.finalize_rebase_requested}`}`);
  lines.push(`  finalize_rebase_in_progress:${` ${finalization.finalize_rebase_in_progress}`}`);
  lines.push(`  ready_to_merge:           ${finalization.ready_to_merge}`);
  lines.push(`  blocked_preserved:        ${finalization.blocked_finalize}`);
  if (finalization.active.length === 0) {
    lines.push('  (none)');
  } else {
    for (const claim of finalization.active) {
      const blockedLabel = claim.finalization_state === 'blocked_finalize' ? ' preserved_work' : '';
      const blockedReason = claim.finalization_blocked_reason
        ? ` reason=${truncate(claim.finalization_blocked_reason, 56)}`
        : '';
      const worktree = claim.run_worktree_path ? ` worktree=${claim.run_worktree_path}` : '';
      const branch = claim.run_branch ? ` branch=${claim.run_branch}` : '';
      lines.push(`  ${claim.run_id.padEnd(24)} ${claim.finalization_state.padEnd(28)} retry=${claim.finalization_retry_count}${blockedLabel}${branch}${worktree}${blockedReason}`);
    }
  }

  lines.push('');
  lines.push(`Recent Failures (${failures.startup.length + failures.lifecycle.length}):`);
  if (failures.startup.length === 0 && failures.lifecycle.length === 0) {
    lines.push('  (none)');
  } else {
    for (const failure of failures.startup) {
      lines.push(`  startup ${failure.agent_id ?? 'n/a'} ${failure.run_id ?? 'n/a'} ${truncate(failure.reason)}`);
    }
    for (const failure of failures.lifecycle) {
      lines.push(`  ${failure.event ?? 'unknown'} ${failure.agent_id ?? 'n/a'} ${failure.run_id ?? 'n/a'} ${truncate(failure.reason)}`);
    }
  }

  lines.push('');
  lines.push(`Tasks (${tasksStatus.total} total):`);
  for (const [s, count] of Object.entries(tasksStatus.counts).sort()) {
    lines.push(`  ${s.padEnd(14)} ${count}`);
  }

  if (eventReadError) {
    lines.push('');
    lines.push(`Event log warning: ${eventReadError}`);
  }

  return lines.join('\n');
}

export function formatAgentStatus(agentStatus: Record<string, unknown>, agentId: string): string {
  const lines: string[] = [];
  const agent = agentStatus['agent'] as (Agent & { role?: string }) | null;
  const assignedTasks = agentStatus['assigned_tasks'] as Array<{
    task_ref: string;
    state: string;
    run_id: string;
    finalization_state?: string | null;
    finalization_retry_count?: number;
  }>;
  const queuedTasks = agentStatus['queued_tasks'] as Array<{
    ref: string;
    status: string;
    planning_state: string;
  }>;

  lines.push(`Agent Status: ${agentId}`);
  lines.push('─'.repeat(40));

  if (!agent) {
    lines.push('');
    lines.push('  (agent not found)');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`Role: ${agent.role ?? 'worker'}`);
  lines.push(`Status: ${agent.status ?? 'unknown'}`);
  lines.push(`Provider: ${agent.provider ?? 'unknown'}`);

  lines.push('');
  lines.push(`Assigned Tasks (${assignedTasks.length}):`);
  if (assignedTasks.length === 0) {
    lines.push('  (none)');
  } else {
    for (const claim of assignedTasks) {
      const finalization = claim.finalization_state
        ? ` finalize=${claim.finalization_state} retry=${claim.finalization_retry_count ?? 0}`
        : '';
      lines.push(`  ${claim.task_ref} ${claim.state} run=${claim.run_id}${finalization}`);
    }
  }

  lines.push('');
  lines.push(`Queued Owned Tasks (${queuedTasks.length}):`);
  if (queuedTasks.length === 0) {
    lines.push('  (none)');
  } else {
    for (const task of queuedTasks) {
      lines.push(`  ${task.ref} ${task.status} planning=${task.planning_state}`);
    }
  }

  return lines.join('\n');
}

function msUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms < 0) return 'EXPIRED';
  if (ms < 60_000) return `in ${Math.round(ms / 1000)}s`;
  return `in ${Math.round(ms / 60_000)}m`;
}

function truncate(text: string | null | undefined, max = 72): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
