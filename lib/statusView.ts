import { listCoordinatorAgents } from './agentRegistry.ts';
import { readEventCursor, readStatusEvents } from './eventLog.ts';
import { listWaitingInput, WAITING_INPUT_ANSWER_HINT, type WaitingInputRow } from './waitingInput.ts';
import type { OrcEvent } from '../types/events.ts';
import { claimedRunStartupAnchor, latestRunActivityDetailMap, latestRunPhaseMap, runPhaseHistory } from './runActivity.ts';
import type { RunPhaseEntry } from './runActivity.ts';
import { loadWorkerPoolConfig, type OrcSettings } from './providers.ts';
import { readJson } from './stateReader.ts';
import type { Agent } from '../types/agents.ts';
import type { Claim } from '../types/claims.ts';
import type { Backlog } from '../types/backlog.ts';
import { STALLED_RUN_IDLE_SECONDS } from './constants.ts';
import { computeWorkerCapacity } from './workerCapacity.ts';
import { tmuxSessionTarget } from './tmuxNames.ts';
import { readProjectDescriptor, type ActiveProject, type ProjectSelectedBy } from './projectContext.ts';
import { formatProjectIdentity } from './projectHealth.ts';
import { latestHookActivityTs, readRunActivity, type RunActivityMap, type RunActivitySnapshot } from './runActivityStore.ts';
import { isCommitToolEvent, isProgressLifecycleEvent, noProgressAlertProgressAt } from './runProgress.ts';
import { isStalled, phaseEvidenceTs, runIdleAnchor } from './runSignals.ts';
import { formatActivityLine, selectCurrentActivity, type CurrentActivity } from './currentActivity.ts';
const STARTUP_FAILURE_LIMIT = 5;
const LIFECYCLE_FAILURE_LIMIT = 5;

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
      if (task.status === 'done') {
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

export function buildActiveClaimMetrics(
  activeClaims: Claim[],
  runActivity: ReturnType<typeof latestRunActivityDetailMap>,
  runPhase: ReturnType<typeof latestRunPhaseMap>,
  runWorktreeByRunId: Map<string, RunWorktreeEntry>,
  nowMs: number,
  nonHeartbeatRunActivity?: ReturnType<typeof latestRunActivityDetailMap>,
  phaseHistory?: Map<string, RunPhaseEntry[]>,
  hookActivity: RunActivityMap = {},
) {
  return activeClaims.map((claim) => {
    const startupAnchor = claimedRunStartupAnchor(claim);
    const ageAnchor = claim.state === 'claimed'
      ? startupAnchor
      : (claim.started_at ?? claim.task_envelope_sent_at ?? claim.claimed_at ?? null);
    const ageMs = ageAnchor ? new Date(ageAnchor).getTime() : NaN;
    const activity = runActivity.get(claim.run_id) ?? null;
    // Same liveness as the coordinator: durable activity events or hook activity, whichever is newer.
    const hookSnapshot = hookActivity[claim.run_id];
    const idleAnchor = runIdleAnchor(claim, activity?.ts, hookSnapshot);
    const idleMs = idleAnchor ? nowMs - new Date(idleAnchor).getTime() : NaN;

    const nonHeartbeatActivity = nonHeartbeatRunActivity?.get(claim.run_id) ?? null;
    const activityAnchor = nonHeartbeatActivity?.ts ?? null;
    const activityMs = activityAnchor ? nowMs - new Date(activityAnchor).getTime() : NaN;

    const heartbeatAnchor = claim.last_heartbeat_at ?? null;
    const heartbeatMs = heartbeatAnchor ? nowMs - new Date(heartbeatAnchor).getTime() : NaN;

    return {
      ...claim,
      age_seconds: Number.isNaN(ageMs) ? null : Math.max(0, Math.round((nowMs - ageMs) / 1000)),
      idle_seconds: Number.isNaN(idleMs) ? null : Math.max(0, Math.round(idleMs / 1000)),
      activity_seconds: Number.isNaN(activityMs) ? null : Math.max(0, Math.round(activityMs / 1000)),
      heartbeat_seconds: Number.isNaN(heartbeatMs) ? null : Math.max(0, Math.round(heartbeatMs / 1000)),
      last_activity_at: activity?.ts ?? null,
      last_activity_event: activity?.event ?? null,
      last_activity_source: activity?.source ?? null,
      stalled: isStalled(claim, idleMs, hookSnapshot, STALLED_RUN_IDLE_SECONDS * 1000, nowMs),
      current_phase: runPhase.get(claim.run_id) ?? null,
      phase_history: phaseHistory?.get(claim.run_id) ?? [],
      run_worktree_path: runWorktreeByRunId.get(claim.run_id)?.worktree_path ?? null,
      run_branch: runWorktreeByRunId.get(claim.run_id)?.branch ?? null,
    };
  });
}

/** Why an agent needs a human, highest precedence first (`ATTENTION_PRECEDENCE`). */
export type AttentionKind = 'permission_prompt' | 'question' | 'stalled' | 'no_progress';

/** When several conditions hold, the earliest kind here wins. */
export const ATTENTION_PRECEDENCE: readonly AttentionKind[] = ['permission_prompt', 'question', 'stalled', 'no_progress'];

/**
 * What an agent's run needs from a human, derived from current state (null: nothing).
 * `since`: when the condition began. `detail`: the question or prompt text, or the phase for `no_progress`.
 * `request_id`: the worker's input request id (`question` only), to answer it.
 */
export interface AgentAttention {
  kind: AttentionKind;
  run_id: string;
  since: string | null;
  detail: string | null;
  request_id: string | null;
}

/** Per-run facts from the run's events that attention needs beyond the claim. */
export interface RunAttentionEvents {
  /** `actor_type` of the run's latest `input_requested`: `coordinator` means a provider prompt it detected. */
  inputRequestedBy: string | null;
  /** The latest `worker_needs_attention {reason: no_progress}`: the progress point it was raised for. */
  noProgressAlert: { progress_at: string; phase: string | null } | null;
  /** Newest progress event of the run: a progress lifecycle event, or a change of phase at its evidence time. */
  progressAt: string | null;
}

export function collectRunAttentionEvents(events: OrcEvent[]): Map<string, RunAttentionEvents> {
  const byRun = new Map<string, RunAttentionEvents>();
  const phases = new Map<string, string>();
  for (const event of events) {
    const runId = (event as { run_id?: string }).run_id;
    if (!runId) continue;
    const entry = byRun.get(runId) ?? { inputRequestedBy: null, noProgressAlert: null, progressAt: null };
    byRun.set(runId, entry);
    if (event.event === 'input_requested') entry.inputRequestedBy = event.actor_type ?? null;
    const alertedFor = noProgressAlertProgressAt(event);
    if (alertedFor) {
      const phase = (event.payload as { phase?: unknown } | undefined)?.phase;
      entry.noProgressAlert = { progress_at: alertedFor, phase: typeof phase === 'string' ? phase : null };
    }
    if (isProgressLifecycleEvent(event) && later(entry.progressAt, event.ts)) entry.progressAt = event.ts;
    // As RunSignals.recordPhase: only a change of phase is progress, at its evidence time.
    if (event.event === 'phase_started') {
      const phase = (event as { phase?: unknown }).phase ?? (event.payload as { phase?: unknown } | undefined)?.phase;
      if (typeof phase === 'string' && phase.length > 0) {
        const previous = phases.get(runId);
        phases.set(runId, phase);
        const evidenceTs = phaseEvidenceTs(event);
        if (previous !== phase && later(entry.progressAt, evidenceTs)) entry.progressAt = evidenceTs;
      }
    }
  }
  return byRun;
}

function later(current: string | null, candidate: string | undefined): boolean {
  if (!candidate || !Number.isFinite(Date.parse(candidate))) return false;
  return current == null || Date.parse(candidate) > Date.parse(current);
}

/**
 * One run's attention, by `ATTENTION_PRECEDENCE`:
 * - `permission_prompt`: waiting for input the coordinator recorded for a provider permission or
 *   interactive prompt; gone once the worker shows hook activity after the request (the prompt was answered).
 * - `question`: waiting for an answer to the worker's `run-input-request`.
 * - `stalled`: the run's `stalled` flag (`isStalled`, as every status reader computes it).
 * - `no_progress`: the coordinator raised `worker_needs_attention {reason: no_progress}` and the run
 *   has shown no progress (phase change, lifecycle event, hook-seen `git commit`) since its progress point,
 *   counted as the coordinator counts it (RunSignals).
 * Each clears with the state it reads: answering the input, the run moving on, or the run ending.
 */
export function deriveAttention(input: {
  claim: Pick<Claim, 'run_id' | 'finalization_state'> & { stalled: boolean };
  waiting: WaitingInputRow | null;
  runEvents: RunAttentionEvents | null;
  hookSnapshot: RunActivitySnapshot | null | undefined;
  idleAnchor: string | null;
}): AgentAttention | null {
  const { claim, waiting, runEvents, hookSnapshot } = input;
  const runId = claim.run_id;
  if (waiting) {
    if (runEvents?.inputRequestedBy === 'coordinator') {
      if (!later(waiting.input_requested_at, latestHookActivityTs(hookSnapshot) ?? undefined)) {
        return { kind: 'permission_prompt', run_id: runId, since: waiting.input_requested_at, detail: waiting.question, request_id: null };
      }
    } else {
      return { kind: 'question', run_id: runId, since: waiting.input_requested_at, detail: waiting.question, request_id: waiting.request_id };
    }
  }
  if (claim.stalled) {
    return { kind: 'stalled', run_id: runId, since: input.idleAnchor, detail: null, request_id: null };
  }
  const alert = runEvents?.noProgressAlert;
  if (alert && !waiting && claim.finalization_state == null && !progressedSince(alert.progress_at, runEvents, hookSnapshot)) {
    return { kind: 'no_progress', run_id: runId, since: alert.progress_at, detail: alert.phase, request_id: null };
  }
  return null;
}

function progressedSince(progressAt: string, runEvents: RunAttentionEvents, hookSnapshot: RunActivitySnapshot | null | undefined): boolean {
  if (later(progressAt, runEvents.progressAt ?? undefined)) return true;
  if (later(progressAt, hookSnapshot?.last_commit_ts)) return true;
  // A snapshot written before last_commit_ts existed: the commit counts while it is the last tool.
  const tool = hookSnapshot?.last_tool;
  const ts = hookSnapshot?.last_tool_ts;
  if (!tool || !ts) return false;
  return isCommitToolEvent({ type: 'tool', tool, brief: hookSnapshot.last_tool_brief ?? '', ts }) && later(progressAt, ts);
}

/**
 * Where an agent's tmux session runs: orc's private server (`tmux -L <tmux_socket>`)
 * and the session in it. Both null when the agent has no session or a non-tmux one (`app:`).
 */
export interface TmuxTarget {
  tmux_socket: string | null;
  tmux_session: string | null;
}

/** The agent's tmux target from its session handle and provider_ref; recorded names win over computed ones. */
export function agentTmuxTarget(stateDir: string, agent: Pick<Agent, 'session_handle' | 'provider_ref'>): TmuxTarget {
  const handle = agent.session_handle;
  if (!handle?.startsWith('tmux:') || handle.length <= 5) return { tmux_socket: null, tmux_session: null };
  const { socket, session } = tmuxSessionTarget(stateDir, handle.slice(5), agent.provider_ref);
  return { tmux_socket: socket, tmux_session: session };
}

/** One worker slot in `StatusView.worker_capacity.slots`. */
export interface SlotSummary extends TmuxTarget {
  agent_id: string;
  role: Agent['role'];
  provider: string;
  model: string | null;
  status: Agent['status'];
  session_handle: string | null;
  slot_state: string;
  active_run_id: string | null;
  active_task_ref: string | null;
  last_status_change_at: string | null;
  last_heartbeat_at: string | null;
  /** The slot's active run's attention (`deriveAttention`), null when it has none or no active run. */
  attention: AgentAttention | null;
}

/** One scout in `StatusView.scouts`. */
export interface ScoutSummary extends TmuxTarget {
  agent_id: string;
  provider: string;
  model: string | null;
  status: Agent['status'];
  session_handle: string | null;
  launched_at: string | null;
}

export function buildSlotSummary(
  stateDir: string,
  workerSlots: Agent[],
  activeClaimByAgentId: Map<string, ReturnType<typeof buildActiveClaimMetrics>[number] & { attention?: AgentAttention | null }>,
): SlotSummary[] {
  const slotDetails = workerSlots.map((slot) => {
    const activeClaim = activeClaimByAgentId.get(slot.agent_id) ?? null;
    return {
      agent_id: slot.agent_id,
      role: slot.role,
      provider: slot.provider,
      model: slot.model ?? null,
      status: slot.status,
      session_handle: slot.session_handle ?? null,
      ...agentTmuxTarget(stateDir, slot),
      slot_state: classifyWorkerSlot(slot, activeClaim),
      active_run_id: activeClaim?.run_id ?? null,
      active_task_ref: activeClaim?.task_ref ?? null,
      last_status_change_at: slot.last_status_change_at ?? null,
      last_heartbeat_at: slot.last_heartbeat_at ?? null,
      attention: activeClaim?.attention ?? null,
    };
  });
  return slotDetails;
}

/** Scouts are ad-hoc sessions, not capacity: list each one by id and state. */
export function buildScoutList(stateDir: string, scoutAgents: Agent[]): ScoutSummary[] {
  return scoutAgents.map((agent) => ({
    agent_id: agent.agent_id,
    provider: agent.provider,
    model: agent.model ?? null,
    status: agent.status,
    session_handle: agent.session_handle ?? null,
    ...agentTmuxTarget(stateDir, agent),
    launched_at: agent.registered_at ?? null,
  }));
}

export const DEFAULT_STATUS_EVENTS = 20;
export const MIN_STATUS_EVENTS = 0;
export const MAX_STATUS_EVENTS = 200;

type ActiveClaimView = ReturnType<typeof buildActiveClaimMetrics>[number] & { current_activity: CurrentActivity | null; attention: AgentAttention | null };
type FinalizationRun = {
  run_id: string;
  task_ref: string | null;
  agent_id: string | null;
  finalization_state: Claim['finalization_state'];
  finalization_retry_count: number;
  finalization_blocked_reason: string | null;
  run_worktree_path: string | null;
  run_branch: string | null;
  idle_seconds: number | null;
};

/** What `buildStatus` returns: `orc status --json` and `GET /v1/status`. */
export type StatusView = {
  /** Highest event seq the view read; continue with `/v1/events/stream?after=cursor`. */
  cursor: number;
  /** `selected_by` is set only by the CLI (`orc status`), for the project it resolved; see withProjectSelection. */
  project: { id: string; name: string; target_repo_root: string; selected_by?: ProjectSelectedBy } | null;
  agents: {
    total: number; masters: number; workers: number; running: number; idle: number; offline: number;
    list: Agent[];
  };
  master: ({
    agent_id: string; provider: string; model: string | null; status: string;
    session_handle: string | null; last_heartbeat_at: string | null;
  } & TmuxTarget) | null;
  worker_capacity: {
    configured_slots: number; provider: string; model: string | null | undefined;
    used_slots: number; available_slots: number; warming_slots: number; unavailable_slots: number;
    slots: SlotSummary[];
    dispatch_ready_tasks: DispatchReadyTask[];
    dispatch_ready_count: number;
    waiting_for_capacity: number;
  };
  scouts: ScoutSummary[];
  tasks: TaskCounts;
  claims: {
    active: ActiveClaimView[]; total: number; awaiting_run_started: number; in_progress: number; stalled: number;
    /** Live runs waiting for an input response (the rows are `waiting_input`). */
    waiting_input: number;
  };
  finalization: {
    total: number; awaiting_finalize: number; finalize_rebase_requested: number;
    finalize_rebase_in_progress: number; ready_to_merge: number; blocked_finalize: number;
    active: FinalizationRun[]; blocked_preserved: FinalizationRun[];
  };
  failures: { startup: FailureEntry[]; lifecycle: FailureEntry[] };
  waiting_input: WaitingInputRow[];
  recentEvents: OrcEvent[];
  eventReadError: string;
};

/**
 * Stamp `project.selected_by` when the status describes the project this
 * process resolved (`active`); otherwise the status is returned unchanged.
 */
export function withProjectSelection<T extends { project: StatusView['project'] }>(status: T, active: Pick<ActiveProject, 'id' | 'selectedBy'> | null): T {
  if (!status.project || !active || status.project.id !== active.id) return status;
  return { ...status, project: { ...status.project, selected_by: active.selectedBy } };
}

/**
 * Build a structured status object from base state files + recent events.
 * All fields are plain data — formatting is the CLI's responsibility.
 * Worker pool settings come from the registry (`settings` injects them in tests).
 */
export function buildStatus(
  stateDir: string,
  { settings, events = DEFAULT_STATUS_EVENTS }: { settings?: OrcSettings; events?: number } = {},
): StatusView {
  if (!Number.isInteger(events) || events < MIN_STATUS_EVENTS || events > MAX_STATUS_EVENTS) {
    throw new RangeError(`events must be an integer from ${MIN_STATUS_EVENTS} to ${MAX_STATUS_EVENTS}`);
  }
  // Cursor first: an event committed while the state below is read has seq > cursor, so a subscriber
  // resuming from it gets a harmless duplicate instead of missing the change.
  let cursor = 0;
  let eventReadError = '';
  try {
    cursor = readEventCursor(stateDir);
  } catch (error) {
    eventReadError = (error as Error).message;
  }
  const claimsFile = readJson(stateDir, 'claims.json') as { claims?: Claim[] };
  const backlogFile = readJson(stateDir, 'backlog.json') as Backlog;
  const workerPoolConfig = loadWorkerPoolConfig({ env: process.env, settings });
  const agents = listCoordinatorAgents(stateDir, workerPoolConfig);
  const master = agents.find((agent) => agent.role === 'master') ?? null;

  const claims = claimsFile.claims ?? [];
  const runWorktrees = readRunWorktrees(stateDir);
  const runWorktreeByRunId = new Map(runWorktrees.map((entry) => [entry.run_id, entry]));

  const activeClaims = claims.filter((c) => ['claimed', 'in_progress'].includes(c.state));
  const awaitingRunStarted = activeClaims.filter((c) => c.state === 'claimed').length;
  const inProgressRuns = activeClaims.filter((c) => c.state === 'in_progress').length;

  let recentEvents: OrcEvent[] = [];
  let sessionEvents: OrcEvent[] = [];
  let allEvents: OrcEvent[] = [];
  try {
    if (eventReadError) throw new Error(eventReadError);
    const window = readStatusEvents(stateDir, activeClaims.map((c) => c.run_id), events, cursor);
    recentEvents = window.recentEvents;
    sessionEvents = window.sessionEvents;
    // Run history from before the session boundary still feeds each active run's activity and phases.
    allEvents = [...window.runEvents, ...window.sessionEvents];
  } catch (error) {
    eventReadError = (error as Error).message;
  }

  const runActivity = latestRunActivityDetailMap(allEvents as Parameters<typeof latestRunActivityDetailMap>[0]);
  const nonHeartbeatRunActivity = latestRunActivityDetailMap(
    allEvents.filter(
      (ev) => (ev as { event?: string }).event !== 'heartbeat',
    ) as Parameters<typeof latestRunActivityDetailMap>[0],
  );
  const runPhase = latestRunPhaseMap(allEvents as Parameters<typeof latestRunPhaseMap>[0]);
  const runPhaseHistoryMap = runPhaseHistory(allEvents as Parameters<typeof runPhaseHistory>[0]);
  const nowMs = Date.now();

  const activitySnapshots = readRunActivity(stateDir);
  const waitingInput = listWaitingInput(stateDir, claims, nowMs);
  const waitingByRunId = new Map(waitingInput.map((row) => [row.run_id, row]));
  const attentionEvents = collectRunAttentionEvents(allEvents);
  const activeClaimsWithMetrics: ActiveClaimView[] = buildActiveClaimMetrics(
    activeClaims, runActivity, runPhase, runWorktreeByRunId, nowMs, nonHeartbeatRunActivity, runPhaseHistoryMap, activitySnapshots,
  ).map((claim) => ({
    ...claim,
    current_activity: selectCurrentActivity(activitySnapshots[claim.run_id], nowMs),
    attention: deriveAttention({
      claim,
      waiting: waitingByRunId.get(claim.run_id) ?? null,
      runEvents: attentionEvents.get(claim.run_id) ?? null,
      hookSnapshot: activitySnapshots[claim.run_id],
      idleAnchor: runIdleAnchor(claim, runActivity.get(claim.run_id)?.ts, activitySnapshots[claim.run_id]),
    }),
  }));

  const activeClaimByAgentId = new Map(
    activeClaimsWithMetrics
      .filter((claim) => claim.agent_id)
      .map((claim) => [claim.agent_id, claim]),
  );
  const liveWorkers = agents.filter((agent) => agent.role === 'worker');
  const scoutAgents = agents.filter((agent) => agent.role === 'scout');
  const slotDetails = buildSlotSummary(stateDir, liveWorkers, activeClaimByAgentId);
  const scouts = buildScoutList(stateDir, scoutAgents);
  const dispatchReadyTasks = listDispatchReadyTasks(backlogFile);
  const capacity = computeWorkerCapacity(agents, workerPoolConfig.max_workers);
  const availableSlots = capacity.available;
  const startupFailures = collectRecentFailures(sessionEvents);
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

  const descriptor = readProjectDescriptor(stateDir);
  return {
    cursor,
    // The project this state directory belongs to (null when it has no project descriptor).
    project: descriptor ? { id: descriptor.id, name: descriptor.name, target_repo_root: descriptor.target_repo_root } : null,
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
      ...agentTmuxTarget(stateDir, master),
      last_heartbeat_at: master.last_heartbeat_at ?? null,
    } : null,
    worker_capacity: {
      configured_slots: capacity.max,
      provider: workerPoolConfig.provider,
      model: workerPoolConfig.model,
      used_slots: liveWorkers.filter((w) => activeClaimByAgentId.has(w.agent_id)).length,
      available_slots: availableSlots,
      warming_slots: slotDetails.filter((slot) => slot.slot_state === 'warming').length,
      unavailable_slots: slotDetails.filter((slot) => slot.slot_state === 'unavailable').length,
      slots: slotDetails,
      dispatch_ready_tasks: dispatchReadyTasks,
      dispatch_ready_count: dispatchReadyTasks.length,
      waiting_for_capacity: Math.max(0, dispatchReadyTasks.length - availableSlots),
    },
    scouts,
    tasks,
    claims: {
      active: activeClaimsWithMetrics,
      total: activeClaimsWithMetrics.length,
      awaiting_run_started: awaitingRunStarted,
      in_progress: inProgressRuns,
      stalled: activeClaimsWithMetrics.filter((claim) => claim.stalled).length,
      waiting_input: waitingInput.length,
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
    waiting_input: waitingInput,
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
      if (task.status === 'done' || task.status === 'cancelled') continue;
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
    slots: Array<{ session_handle: string | null; agent_id: string; role: string; slot_state: string; status: string; active_run_id: string | null; active_task_ref: string | null }>;
  };
  const scouts = (status['scouts'] ?? []) as Array<{ agent_id: string; status: string; session_handle: string | null }>;
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
      current_phase?: string | null;
      current_activity?: CurrentActivity | null;
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
  lines.push(formatProjectIdentity(status['project'] as StatusView['project'] ?? null));
  lines.push('─'.repeat(40));
  const waitingInput = (status['waiting_input'] ?? []) as WaitingInputRow[];
  if (waitingInput.length > 0) {
    lines.push('');
    lines.push(`Waiting for input (${waitingInput.length}):`);
    for (const row of waitingInput) {
      const waited = row.waiting_seconds == null ? '?' : `${row.waiting_seconds}s`;
      lines.push(`  ${row.agent_id.padEnd(12)} ${row.task_ref} waiting=${waited}`);
      lines.push(`    question: ${row.question ? truncate(row.question.replace(/\s+/g, ' ')) : '(unknown)'}`);
    }
    lines.push(`  answer: ${WAITING_INPUT_ANSWER_HINT}`);
  }
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
  lines.push(`  provider:            ${workerCapacity.provider}`);
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
  const visibleSlots = workerCapacity.slots.filter((slot) => slot.session_handle !== null);
  if (visibleSlots.length === 0) {
    lines.push('  slots: (none spawned)');
  } else {
    for (const slot of visibleSlots) {
      const suffix = slot.active_run_id ? ` run=${slot.active_run_id} task=${slot.active_task_ref ?? 'n/a'}` : '';
      lines.push(`  ${slot.agent_id.padEnd(12)} ${slot.role.padEnd(8)} ${slot.slot_state.padEnd(14)} ${slot.status.padEnd(10)} attached${suffix}`);
    }
  }

  lines.push('');
  lines.push(`Scouts (${scouts.length}):`);
  if (scouts.length === 0) {
    lines.push('  (none)');
  } else {
    for (const scout of scouts) {
      lines.push(`  ${scout.agent_id.padEnd(12)} ${scout.status.padEnd(10)} ${scout.session_handle ? 'attached' : 'detached'}`);
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
      const phaseLabel = c.current_phase ? ` phase=${c.current_phase}` : '';
      const finalizationLabel = c.finalization_state
        ? ` finalize=${c.finalization_state} retry=${c.finalization_retry_count ?? 0}`
        : '';
      lines.push(
        `  ${c.run_id.padEnd(24)} ${(c.task_ref ?? '').padEnd(24)} ${(c.agent_id ?? '').padEnd(12)} ${c.state.padEnd(12)} ${exp} age=${c.age_seconds ?? '?'}s idle=${c.idle_seconds ?? '?'}s${phaseLabel}${finalizationLabel}${stalledLabel}`,
      );
      if (c.current_activity) lines.push(`    ${formatActivityLine(c.current_activity, TEXT_ACTIVITY_WIDTH)}`);
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
    current_activity?: CurrentActivity | null;
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
      if (claim.current_activity) lines.push(`    ${formatActivityLine(claim.current_activity, TEXT_ACTIVITY_WIDTH)}`);
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

/** Column budget for the `└ <activity> (age)` line in text-mode status. */
const TEXT_ACTIVITY_WIDTH = 96;

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
