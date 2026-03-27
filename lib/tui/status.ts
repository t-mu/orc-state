import { buildStatus } from '../statusView.ts';
import type { SpriteState } from './sprites.ts';

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
}

export interface TuiClaim {
  run_id: string;
  task_ref: string | null;
  agent_id: string | null;
  state: string;
  age_seconds: number | null;
  idle_seconds: number | null;
  current_phase: string | null;
  finalization_state?: string | null;
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

export interface TuiStatus {
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
  scout_capacity: {
    total_slots: number;
    investigating_slots: number;
    idle_slots: number;
    warming_slots: number;
    unavailable_slots: number;
    slots: TuiSlot[];
  };
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
  recentEvents: TuiRecentEvent[];
  eventReadError: string;
}

export interface WorkerSlotViewModel {
  slot_id: string;
  role: string;
  provider: string | null;
  slot_state: string;
  task_ref: string | null;
  run_state: string | null;
  current_phase: string | null;
  age_seconds: number | null;
  idle_seconds: number | null;
  sprite_state: SpriteState;
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
    scout_capacity: {
      total_slots: 0,
      investigating_slots: 0,
      idle_slots: 0,
      warming_slots: 0,
      unavailable_slots: 0,
      slots: [],
    },
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
    recentEvents: [],
    eventReadError: '',
  };
}

export function loadTuiStatus(stateDir: string): TuiStatus {
  try {
    return buildStatus(stateDir) as unknown as TuiStatus;
  } catch {
    return emptyTuiStatus();
  }
}

export function buildWorkerSlotViewModels(status: TuiStatus): WorkerSlotViewModel[] {
  const slotById = new Map(status.worker_capacity.slots.map(slot => [slot.agent_id, slot]));
  const claimByAgentId = new Map(
    status.claims.active
      .filter((claim): claim is TuiClaim & { agent_id: string } => typeof claim.agent_id === 'string' && claim.agent_id.length > 0)
      .map(claim => [claim.agent_id, claim]),
  );

  const viewModels: WorkerSlotViewModel[] = [];

  for (let slotNumber = 1; slotNumber <= status.worker_capacity.configured_slots; slotNumber += 1) {
    const slotId = `orc-${slotNumber}`;
    const slot = slotById.get(slotId) ?? null;
    const claim = claimByAgentId.get(slotId) ?? null;
    const runState = claim?.state ?? null;

    viewModels.push({
      slot_id: slotId,
      role: slot?.role ?? 'worker',
      provider: slot?.provider ?? null,
      slot_state: slot?.slot_state ?? 'available',
      task_ref: claim?.task_ref ?? slot?.active_task_ref ?? null,
      run_state: runState,
      current_phase: claim?.current_phase ?? null,
      age_seconds: claim?.age_seconds ?? null,
      idle_seconds: claim?.idle_seconds ?? null,
      sprite_state: runStateToSpriteState(runState),
    });
  }

  for (const scout of status.scout_capacity.slots) {
    const agentId = scout.agent_id;
    viewModels.push({
      slot_id: agentId,
      role: scout.role,
      provider: scout.provider ?? null,
      slot_state: scout.slot_state,
      task_ref: null,
      run_state: scout.slot_state,
      current_phase: null,
      age_seconds: null,
      idle_seconds: null,
      sprite_state: scoutStateToSpriteState(scout.slot_state),
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

function scoutStateToSpriteState(slotState: string | null | undefined): SpriteState {
  if (slotState === 'investigating' || slotState === 'warming') return 'work';
  if (slotState === 'unavailable') return 'fail';
  return 'idle';
}
