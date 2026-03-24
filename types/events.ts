export type ActorType = 'agent' | 'coordinator' | 'human';
export type FailurePolicy = 'requeue' | 'block';
export type EventFinalizationStatus = 'awaiting_finalize' | 'finalize_rebase_in_progress' | 'ready_to_merge';

interface BaseEvent {
  seq: number;
  event_id?: string;
  ts: string;
  actor_type: ActorType;
  actor_id: string;
}

// ── Task events ─────────────────────────────────────────────────────────────

export interface TaskAddedEvent extends BaseEvent {
  event: 'task_added';
  task_ref: string;
  payload?: Record<string, unknown>;
}

export interface TaskUpdatedEvent extends BaseEvent {
  event: 'task_updated';
  task_ref: string;
  payload: { status: string; [key: string]: unknown };
}

export interface TaskCancelledEvent extends BaseEvent {
  event: 'task_cancelled';
  task_ref: string;
  payload?: Record<string, unknown>;
}

export interface TaskReleasedEvent extends BaseEvent {
  event: 'task_released';
  task_ref: string;
  payload?: Record<string, unknown>;
}

export interface TaskDelegatedEvent extends BaseEvent {
  event: 'task_delegated';
  task_ref: string;
  payload?: Record<string, unknown>;
}

export interface TaskDispatchBlockedEvent extends BaseEvent {
  event: 'task_dispatch_blocked';
  task_ref: string;
  payload: { reason: string; findings: string[]; [key: string]: unknown };
}

// ── Claim events ─────────────────────────────────────────────────────────────

export interface ClaimCreatedEvent extends BaseEvent {
  event: 'claim_created';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { lease_expires_at: string; [key: string]: unknown };
}

export interface ClaimRenewedEvent extends BaseEvent {
  event: 'claim_renewed';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { lease_expires_at: string; [key: string]: unknown };
}

export interface ClaimExpiredEvent extends BaseEvent {
  event: 'claim_expired';
  run_id: string;
  task_ref: string;
  agent_id?: string;
  payload: { policy: FailurePolicy; [key: string]: unknown };
}

export interface ClaimReleasedEvent extends BaseEvent {
  event: 'claim_released';
  run_id: string;
  task_ref?: string;
  agent_id?: string;
  payload?: Record<string, unknown>;
}

// ── Run lifecycle events ─────────────────────────────────────────────────────

export interface RunStartedEvent extends BaseEvent {
  event: 'run_started';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: Record<string, unknown>;
}

export interface WorkCompleteEvent extends BaseEvent {
  event: 'work_complete';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { status: 'awaiting_finalize'; retry_count?: number; [key: string]: unknown };
}

export interface FinalizeRebaseStartedEvent extends BaseEvent {
  event: 'finalize_rebase_started';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { status: 'finalize_rebase_in_progress'; retry_count?: number; [key: string]: unknown };
}

export interface ReadyToMergeEvent extends BaseEvent {
  event: 'ready_to_merge';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { status: 'ready_to_merge'; retry_count?: number; [key: string]: unknown };
}

export interface RunFinishedEvent extends BaseEvent {
  event: 'run_finished';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: Record<string, unknown>;
}

export interface RunFailedEvent extends BaseEvent {
  event: 'run_failed';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { policy: FailurePolicy; reason?: string | null | undefined; code?: string | undefined; [key: string]: unknown };
}

export interface RunCancelledEvent extends BaseEvent {
  event: 'run_cancelled';
  run_id: string;
  task_ref: string;
  agent_id?: string;
  payload?: Record<string, unknown>;
}

// ── Phase events ─────────────────────────────────────────────────────────────

export interface PhaseStartedEvent extends BaseEvent {
  event: 'phase_started';
  run_id: string;
  task_ref: string;
  agent_id: string;
  phase?: string;
  payload?: Record<string, unknown>;
}

export interface PhaseFinishedEvent extends BaseEvent {
  event: 'phase_finished';
  run_id: string;
  task_ref: string;
  agent_id: string;
  phase?: string;
  payload?: Record<string, unknown>;
}

// ── Blocking events ──────────────────────────────────────────────────────────

export interface BlockedEvent extends BaseEvent {
  event: 'blocked';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: { reason?: string; [key: string]: unknown };
}

export interface UnblockedEvent extends BaseEvent {
  event: 'unblocked';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: Record<string, unknown>;
}

// ── Input events ─────────────────────────────────────────────────────────────

export interface NeedInputEvent extends BaseEvent {
  event: 'need_input';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: { reason?: string; [key: string]: unknown };
}

export interface InputProvidedEvent extends BaseEvent {
  event: 'input_provided';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: Record<string, unknown>;
}

export interface InputRequestedEvent extends BaseEvent {
  event: 'input_requested';
  run_id: string;
  task_ref?: string | undefined;
  agent_id: string;
  payload: { question: string; [key: string]: unknown };
}

export interface InputResponseEvent extends BaseEvent {
  event: 'input_response';
  run_id: string;
  task_ref?: string | undefined;
  agent_id: string;
  payload: { response: string; [key: string]: unknown };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

export interface HeartbeatEvent extends BaseEvent {
  event: 'heartbeat';
  run_id?: string;
  task_ref?: string;
  agent_id?: string;
  payload?: Record<string, unknown>;
}

// ── Agent events ─────────────────────────────────────────────────────────────

export interface AgentRegisteredEvent extends BaseEvent {
  event: 'agent_registered';
  agent_id: string;
  payload?: Record<string, unknown>;
}

export interface AgentOnlineEvent extends BaseEvent {
  event: 'agent_online';
  agent_id: string;
  run_id?: string;
  task_ref?: string;
  payload?: Record<string, unknown>;
}

export interface AgentOfflineEvent extends BaseEvent {
  event: 'agent_offline';
  agent_id: string;
  payload?: { reason?: string; code?: string; [key: string]: unknown };
}

export interface AgentMarkedDeadEvent extends BaseEvent {
  event: 'agent_marked_dead';
  agent_id: string;
  payload: { elapsed_ms: number; [key: string]: unknown };
}

export interface SessionStartFailedEvent extends BaseEvent {
  event: 'session_start_failed';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { reason: string; code?: string | undefined; working_directory?: string | undefined; [key: string]: unknown };
}

// ── Coordinator events ────────────────────────────────────────────────────────

export interface CoordinatorStartedEvent extends BaseEvent {
  event: 'coordinator_started';
  payload?: Record<string, unknown>;
}

export interface CoordinatorStoppedEvent extends BaseEvent {
  event: 'coordinator_stopped';
  payload?: Record<string, unknown>;
}

// ── Union type ────────────────────────────────────────────────────────────────

export type OrcEvent =
  | TaskAddedEvent
  | TaskUpdatedEvent
  | TaskCancelledEvent
  | TaskReleasedEvent
  | TaskDelegatedEvent
  | TaskDispatchBlockedEvent
  | ClaimCreatedEvent
  | ClaimRenewedEvent
  | ClaimExpiredEvent
  | ClaimReleasedEvent
  | RunStartedEvent
  | WorkCompleteEvent
  | FinalizeRebaseStartedEvent
  | ReadyToMergeEvent
  | RunFinishedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | PhaseStartedEvent
  | PhaseFinishedEvent
  | BlockedEvent
  | UnblockedEvent
  | NeedInputEvent
  | InputProvidedEvent
  | InputRequestedEvent
  | InputResponseEvent
  | HeartbeatEvent
  | AgentRegisteredEvent
  | AgentOnlineEvent
  | AgentOfflineEvent
  | AgentMarkedDeadEvent
  | SessionStartFailedEvent
  | CoordinatorStartedEvent
  | CoordinatorStoppedEvent;

// ── Type guards ───────────────────────────────────────────────────────────────

export function isRunEvent(e: OrcEvent): e is Extract<OrcEvent, { run_id: string }> {
  return 'run_id' in e && typeof (e as { run_id?: unknown }).run_id === 'string';
}

export function isTaskEvent(e: OrcEvent): e is Extract<OrcEvent, { task_ref: string }> {
  return 'task_ref' in e && typeof (e as { task_ref?: unknown }).task_ref === 'string';
}

export function isAgentEvent(e: OrcEvent): e is Extract<OrcEvent, { agent_id: string }> {
  return 'agent_id' in e && typeof (e as { agent_id?: unknown }).agent_id === 'string';
}

/**
 * Distributive Omit — unlike the built-in Omit<A | B, K>, this preserves each
 * union member individually so discriminated-union narrowing keeps working.
 *
 * Built-in Omit<A | B, K> = Pick<A | B, Exclude<keyof (A | B), K>>
 * which uses keyof (A | B) = intersection of keys, dropping variant-specific
 * fields like `run_id`. DistributiveOmit<A | B, K> = Omit<A, K> | Omit<B, K>.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** OrcEvent without the auto-assigned `seq` field — use as input to appendSequencedEvent. */
export type OrcEventInput = DistributiveOmit<OrcEvent, 'seq'>;
