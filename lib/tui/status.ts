import type { ProjectConnectionState, ProjectWatchState, ProjectWatchUpdate, SlotSummary, StatusView } from '../../client.ts';
import type { SpriteState } from './sprites.ts';

// lib/tui renders only data obtained through orc-state/client (see boundary.test.ts).

/** A run's current activity line (`StatusView` claims carry it). */
export type CurrentActivity = NonNullable<StatusView['claims']['active'][number]['current_activity']>;
/** What an agent's run needs from a human (`SlotSummary.attention`). */
export type TuiAttention = NonNullable<SlotSummary['attention']>;

export interface TuiSlot {
  agent_id: string;
  role: string;
  provider: string | null;
  model: string | null;
  status: string;
  session_handle: string | null;
  slot_state: string;
  active_run_id: string | null;
  active_task_ref: string | null;
  last_status_change_at: string | null;
  last_heartbeat_at: string | null;
  attention?: TuiAttention | null;
}

export interface TuiScout {
  agent_id: string;
  provider: string | null;
  model: string | null;
  status: string;
  session_handle: string | null;
  launched_at: string | null;
}

export interface PhaseEntry {
  name: string;
  state: 'done' | 'active' | 'stale' | 'error' | 'pending';
  duration_seconds: number | null;
  started_at: string | null;
}

export interface TuiClaim {
  run_id: string;
  task_ref: string | null;
  agent_id: string | null;
  state: string;
  age_seconds: number | null;
  idle_seconds: number | null;
  activity_seconds: number | null;
  heartbeat_seconds: number | null;
  current_phase: string | null;
  phase_history?: { phase: string; started_at: string }[];
  finalization_state?: string | null;
  current_activity?: CurrentActivity | null;
}

export interface TuiFailureEntry {
  ts: string | null;
  run_id: string | null;
  task_ref: string | null;
  agent_id: string | null;
  reason: string;
  event?: string;
}

export interface TuiRecentEvent {
  seq?: number;
  ts?: string;
  event?: string;
  run_id?: string | null;
  task_ref?: string | null;
  agent_id?: string | null;
}

export interface TuiWaitingInput {
  run_id: string;
  agent_id: string;
  task_ref: string;
  question: string | null;
  waiting_seconds: number | null;
}

export interface TuiStatus {
  project?: { id: string; name: string; target_repo_root: string } | null;
  worker_capacity: {
    configured_slots: number;
    used_slots: number;
    available_slots: number;
    warming_slots: number;
    unavailable_slots: number;
    provider: string;
    dispatch_ready_count: number;
    waiting_for_capacity: number;
    slots: TuiSlot[];
  };
  scouts: TuiScout[];
  tasks: {
    counts: Record<string, number>;
    total: number;
  };
  claims: {
    active: TuiClaim[];
    total: number;
    awaiting_run_started: number;
    in_progress: number;
    stalled: number;
  };
  failures: {
    startup: TuiFailureEntry[];
    lifecycle: TuiFailureEntry[];
  };
  waiting_input?: TuiWaitingInput[];
  recentEvents: TuiRecentEvent[];
  eventReadError: string;
}

export interface WorkerSlotViewModel {
  slot_id: string;
  role: string;
  provider: string | null;
  model: string | null;
  slot_state: string;
  task_ref: string | null;
  run_state: string | null;
  current_phase: string | null;
  phases: PhaseEntry[];
  current_activity: CurrentActivity | null;
  /** The activity text alone (`current_activity.text`), null without one. */
  activity_label: string | null;
  /** What the slot's run needs from a human, null when nothing. */
  attention: TuiAttention | null;
  age_seconds: number | null;
  activity_seconds: number | null;
  heartbeat_seconds: number | null;
  sprite_state: SpriteState;
  /** Set while the slot's run waits for an input response; the question is collapsed to one line. */
  waiting_input: { waiting_seconds: number | null; question: string | null } | null;
}

const CANONICAL_PHASES = ['explore', 'implement', 'review', 'complete', 'finalize'] as const;

export function buildPhases(
  phaseHistory: { phase: string; started_at: string }[],
  heartbeat_seconds: number | null,
  run_state: string | null,
): PhaseEntry[] {
  return CANONICAL_PHASES.map((name) => {
    const idx = phaseHistory.findIndex((h) => h.phase === name);
    if (idx === -1) {
      return { name, state: 'pending' as const, duration_seconds: null, started_at: null };
    }
    // A phase is done when it is NOT the last entry in the sorted history
    const isLastInHistory = phaseHistory[phaseHistory.length - 1]?.phase === name;
    if (!isLastInHistory) {
      const nextInHistory = phaseHistory[idx + 1] ?? null;
      const duration_seconds = nextInHistory
        ? Math.round(
            (new Date(nextInHistory.started_at).getTime() - new Date(phaseHistory[idx].started_at).getTime()) / 1000,
          )
        : null;
      return { name, state: 'done' as const, duration_seconds, started_at: null };
    }
    // Last phase in history — determine if active, stale, or error
    let state: PhaseEntry['state'];
    if (run_state === 'blocked' || run_state === 'failed') {
      state = 'error';
    } else if (heartbeat_seconds != null && heartbeat_seconds >= 300) {
      state = 'stale';
    } else {
      state = 'active';
    }
    return { name, state, duration_seconds: null, started_at: phaseHistory[idx].started_at };
  });
}

export function emptyTuiStatus(): TuiStatus {
  return {
    worker_capacity: {
      configured_slots: 0,
      used_slots: 0,
      available_slots: 0,
      warming_slots: 0,
      unavailable_slots: 0,
      provider: 'unknown',
      dispatch_ready_count: 0,
      waiting_for_capacity: 0,
      slots: [],
    },
    scouts: [],
    tasks: {
      counts: {},
      total: 0,
    },
    claims: {
      active: [],
      total: 0,
      awaiting_run_started: 0,
      in_progress: 0,
      stalled: 0,
    },
    failures: {
      startup: [],
      lifecycle: [],
    },
    waiting_input: [],
    recentEvents: [],
    eventReadError: '',
  };
}

/** One watched project as the TUI shows it. */
export interface TuiProjectView {
  project_id: string;
  name: string;
  target_repo_root: string;
  state_dir: string;
  connection: ProjectConnectionState;
  /** Why the project is `unreachable` or `incompatible` (null otherwise). */
  error: string | null;
  /** The latest status; kept, possibly stale, while the project is not `running`. */
  status: TuiStatus | null;
  /** True when `status` is from an earlier connection (the project is not `running`). */
  stale: boolean;
}

/** The view model of every project the watcher reports, in its order. */
export function buildProjectViews(states: ProjectWatchState[]): TuiProjectView[] {
  return states.map((state) => ({
    project_id: state.project.id,
    name: state.project.name,
    target_repo_root: state.project.target_repo_root,
    state_dir: state.project.state_dir,
    connection: state.connection,
    error: state.error,
    status: state.status as unknown as TuiStatus | null,
    stale: state.status != null && state.connection !== 'running',
  }));
}

/** The project whose state directory is `stateDir` (the one `orc watch` was started for), or null. */
export function selectProjectView(views: TuiProjectView[], stateDir: string): TuiProjectView | null {
  return views.find((view) => view.state_dir === stateDir) ?? null;
}

/** What the TUI reads from a project watcher (`ProjectWatcher` from orc-state/client). */
export interface TuiWatchSource {
  projects(): ProjectWatchState[];
  onUpdate(listener: (update: ProjectWatchUpdate) => void): () => void;
}

/** One line describing a project's connection: `running`, `stopped`, `unreachable: <why>`. */
export function describeConnection(view: Pick<TuiProjectView, 'connection' | 'error'>): string {
  const label = view.connection === 'stopped' ? 'stopped (coordinator not running)' : view.connection;
  return view.error ? `${label}: ${view.error}` : label;
}

export function buildWorkerSlotViewModels(status: TuiStatus): WorkerSlotViewModel[] {
  const claimByAgentId = new Map(
    status.claims.active
      .filter((claim): claim is TuiClaim & { agent_id: string } => typeof claim.agent_id === 'string' && claim.agent_id.length > 0)
      .map(claim => [claim.agent_id, claim]),
  );

  const waitingByRunId = new Map((status.waiting_input ?? []).map(row => [row.run_id, row]));

  const viewModels: WorkerSlotViewModel[] = [];

  // Iterate over live registered workers only — no synthetic orc-N placeholder slots.
  // Workers are task-scoped and disappear from this list when their session ends.
  for (const slot of status.worker_capacity.slots) {
    const claim = claimByAgentId.get(slot.agent_id) ?? null;
    const runState = claim?.state ?? null;
    const heartbeat_seconds = claim?.heartbeat_seconds ?? null;
    const phaseHistory = claim?.phase_history ?? [];
    const waiting = claim ? waitingByRunId.get(claim.run_id) ?? null : null;
    viewModels.push({
      slot_id: slot.agent_id,
      role: slot.role,
      provider: slot.provider ?? null,
      model: slot.model ?? null,
      slot_state: slot.slot_state,
      task_ref: claim?.task_ref ?? slot.active_task_ref ?? null,
      run_state: runState,
      current_phase: claim?.current_phase ?? null,
      phases: phaseHistory.length > 0 ? buildPhases(phaseHistory, heartbeat_seconds, runState) : [],
      current_activity: claim?.current_activity ?? null,
      activity_label: claim?.current_activity?.text ?? null,
      attention: slot.attention ?? null,
      age_seconds: claim?.age_seconds ?? null,
      activity_seconds: claim?.activity_seconds ?? null,
      heartbeat_seconds,
      sprite_state: runStateToSpriteState(runState),
      waiting_input: waiting
        ? { waiting_seconds: waiting.waiting_seconds, question: waiting.question?.replace(/\s+/g, ' ').trim() || null }
        : null,
    });
  }

  return viewModels;
}

export function runStateToSpriteState(runState: string | null | undefined): SpriteState {
  if (runState === 'in_progress' || runState === 'claimed') return 'work';
  if (runState === 'done' || runState === 'released') return 'done';
  if (runState === 'blocked' || runState === 'failed') return 'fail';
  return 'idle';
}
