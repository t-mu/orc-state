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

/**
 * The task a failed run left behind (`run_failed`, `claim_expired`): `task_status` is the
 * resulting status (`todo` when requeued, `blocked` after a block or the fifth attempt);
 * `blocked_reason` is set only for a blocked task. Null fields mean the task was not found.
 */
export interface FailureTaskOutcome {
  task_status: string | null;
  attempt_count: number | null;
  requeue_eligible_after: string | null;
  blocked_reason: string | null;
}

export interface ClaimExpiredEvent extends BaseEvent {
  event: 'claim_expired';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: RunSessionIdentity & { policy: FailurePolicy; code: string; reason: string; [key: string]: unknown } & Partial<FailureTaskOutcome>;
}

// ── Run lifecycle events ─────────────────────────────────────────────────────

/**
 * Stamped by the event store on run events (`RUN_SESSION_EVENTS`) when the run has a session.
 * `run_id` is the stable key for a worker's work; `session_id` + `generation` name one live process.
 */
export interface RunSessionIdentity {
  session_id?: string;
  generation?: number;
}

export interface RunStartedEvent extends BaseEvent {
  event: 'run_started';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

export interface TaskEnvelopeSentEvent extends BaseEvent {
  event: 'task_envelope_sent';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

export interface WorkCompleteEvent extends BaseEvent {
  event: 'work_complete';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: RunSessionIdentity & { status: 'awaiting_finalize'; retry_count?: number; [key: string]: unknown };
}

export interface FinalizeRebaseStartedEvent extends BaseEvent {
  event: 'finalize_rebase_started';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: RunSessionIdentity & { status: 'finalize_rebase_in_progress'; retry_count?: number; [key: string]: unknown };
}

export interface ReadyToMergeEvent extends BaseEvent {
  event: 'ready_to_merge';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: RunSessionIdentity & { status: 'ready_to_merge'; retry_count?: number; [key: string]: unknown };
}

export interface RunFinishedEvent extends BaseEvent {
  event: 'run_finished';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

export interface RunFailedEvent extends BaseEvent {
  event: 'run_failed';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: RunSessionIdentity & { policy: FailurePolicy; reason?: string | null | undefined; code?: string | undefined; [key: string]: unknown } & Partial<FailureTaskOutcome>;
}

/** One change of a run's finalization fields (`setRunFinalizationState`), committed with the claim. */
export interface FinalizationChangedEvent extends BaseEvent {
  event: 'finalization_changed';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: RunSessionIdentity & {
    from: string | null;
    to: string | null;
    retry_count: number;
    blocked_reason: string | null;
    pr_ref: string | null;
    pr_created_at: string | null;
    [key: string]: unknown;
  };
}

export interface RunCancelledEvent extends BaseEvent {
  event: 'run_cancelled';
  run_id: string;
  task_ref: string;
  agent_id?: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

export type CommandEventName =
  | 'command_queued'
  | 'command_dispatching'
  | 'command_send_started'
  | 'command_sent'
  | 'command_accepted'
  | 'command_running'
  | 'command_completed'
  | 'command_failed'
  | 'command_cancelled'
  | 'command_outcome_unknown';

export interface CommandLifecycleEvent extends BaseEvent {
  event: CommandEventName;
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { command_id: string; state: string; [key: string]: unknown };
}

// ── Phase events ─────────────────────────────────────────────────────────────

export interface PhaseStartedEvent extends BaseEvent {
  event: 'phase_started';
  run_id: string;
  task_ref: string;
  agent_id: string;
  phase?: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

export interface PhaseFinishedEvent extends BaseEvent {
  event: 'phase_finished';
  run_id: string;
  task_ref: string;
  agent_id: string;
  phase?: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

// ── Blocking events ──────────────────────────────────────────────────────────

export interface BlockedEvent extends BaseEvent {
  event: 'blocked';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: RunSessionIdentity & { reason?: string; [key: string]: unknown };
}

export interface UnblockedEvent extends BaseEvent {
  event: 'unblocked';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

// ── Input events ─────────────────────────────────────────────────────────────

export interface NeedInputEvent extends BaseEvent {
  event: 'need_input';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: RunSessionIdentity & { reason?: string; [key: string]: unknown };
}

export interface InputProvidedEvent extends BaseEvent {
  event: 'input_provided';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
}

export interface InputRequestedEvent extends BaseEvent {
  event: 'input_requested';
  run_id: string;
  task_ref?: string | undefined;
  agent_id: string;
  payload: RunSessionIdentity & { question: string; request_id?: string; [key: string]: unknown };
}

export interface InputResponseEvent extends BaseEvent {
  event: 'input_response';
  run_id: string;
  task_ref?: string | undefined;
  agent_id: string;
  payload: RunSessionIdentity & { response: string; request_id?: string | null; [key: string]: unknown };
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

export interface HeartbeatEvent extends BaseEvent {
  event: 'heartbeat';
  run_id?: string;
  task_ref?: string;
  agent_id?: string;
  payload?: RunSessionIdentity & Record<string, unknown>;
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

export interface ReportedForDutyEvent extends BaseEvent {
  event: 'reported_for_duty';
  agent_id: string;
  payload: { session_token: string; [key: string]: unknown };
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

export interface SessionReconciledEvent extends BaseEvent {
  event: 'session_reconciled';
  agent_id: string;
  run_id?: string;
  task_ref?: string;
  payload: { session_id: string; state: string; previous_state?: string; reason?: string; [key: string]: unknown };
}

/** A session row was inserted (`recordProviderSession`); every row starts `running`. */
export interface SessionOpenedEvent extends BaseEvent {
  event: 'session_opened';
  agent_id: string;
  run_id?: string;
  task_ref?: string;
  payload: { session_id: string; agent_id: string; run_id?: string; state: string; transport: string | null; generation: number; [key: string]: unknown };
}

/** Any other session-row write; `from` equals `to` when only the row's metadata changed (a resume starting). */
export interface SessionStateChangedEvent extends BaseEvent {
  event: 'session_state_changed';
  agent_id: string;
  run_id?: string;
  task_ref?: string;
  payload: { session_id: string; agent_id: string; run_id?: string; from: string; to: string; reason?: string; generation: number; [key: string]: unknown };
}

/** A session id survives a resume; the payload carries the new generation. */
interface SessionResumePayload {
  session_id: string;
  agent_id: string;
  run_id?: string;
  generation: number;
  provider_conversation_id?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface SessionResumedEvent extends BaseEvent {
  event: 'session_resumed';
  agent_id: string;
  run_id?: string;
  task_ref?: string;
  payload: SessionResumePayload;
}

export interface SessionResumeFailedEvent extends BaseEvent {
  event: 'session_resume_failed';
  agent_id: string;
  run_id?: string;
  task_ref?: string;
  payload: SessionResumePayload & { reason: string };
}

/** The master went offline and its session closed; `probe` is the failed probe that decided it. */
export interface MasterRetiredEvent extends BaseEvent {
  event: 'master_retired';
  agent_id: string;
  payload: {
    session_handle: string | null;
    session_id: string | null;
    probe: { alive: boolean; reason: string | null; pid: number | null };
    consecutive_failures: number;
    [key: string]: unknown;
  };
}

/** A requested scout's session is up and briefed. */
export interface ScoutLaunchedEvent extends BaseEvent {
  event: 'scout_launched';
  agent_id: string;
  payload: { requested_by: string; provider: string; working_directory: string; session_handle: string; [key: string]: unknown };
}

/** A requested scout could not be launched or briefed; it has been removed. `hint` says how to fix it when known. */
export interface ScoutLaunchFailedEvent extends BaseEvent {
  event: 'scout_launch_failed';
  agent_id: string;
  payload: { requested_by: string; provider: string; reason: string; hint?: string | undefined; [key: string]: unknown };
}

export interface SessionStartFailedEvent extends BaseEvent {
  event: 'session_start_failed';
  run_id: string;
  task_ref: string;
  agent_id: string;
  payload: { reason: string; code?: string | undefined; working_directory?: string | undefined; [key: string]: unknown };
}

export interface SessionStartedEvent extends BaseEvent {
  event: 'session_started';
  payload: { session_id: string; reset_tasks: number; reset_claims: number; reset_agents: number; [key: string]: unknown };
}

// ── Review events ─────────────────────────────────────────────────────────────

export interface ReviewSubmittedEvent extends BaseEvent {
  event: 'review_submitted';
  run_id: string;
  agent_id: string;
  payload: { outcome: 'approved' | 'findings'; findings: string; reviewer?: string; [key: string]: unknown };
}

// ── Worker attention events ───────────────────────────────────────────────────

export interface WorkerNeedsAttentionEvent extends BaseEvent {
  event: 'worker_needs_attention';
  run_id: string;
  agent_id: string;
  task_ref: string;
  /**
   * `stale`: no activity for the soft threshold. `no_progress`: alive (recent
   * activity) but no phase change, commit, or lifecycle event for
   * `run_no_progress_escalate_ms`. `session_not_running`: the run's session
   * has been `recoverable` or `unknown` for the session-owner TTL; its lease is
   * no longer renewed.
   */
  payload:
    | { reason: 'stale'; idle_ms: number }
    | { reason: 'no_progress'; idle_ms: number; no_progress_ms: number; phase: string | null; progress_at: string }
    | { reason: 'session_not_running'; session_id: string; session_state: string; not_running_ms: number; state_reason?: string };
}

// ── Remediation events ───────────────────────────────────────────────────────

export interface RemediationAppliedEvent extends BaseEvent {
  event: 'remediation_applied';
  run_id: string;
  agent_id: string;
  task_ref: string;
  payload: { policy_id: string; action: string; message: string };
}

// ── Activity events ──────────────────────────────────────────────────────────

/** A run's hook-derived activity label changed (throttled per run). */
export interface ActivityNoteEvent extends BaseEvent {
  event: 'activity_note';
  run_id: string;
  agent_id: string;
  task_ref: string;
  /** Emitted for `todo`/`note` labels only; `tool` survives in events recorded before tool labels left events.db. */
  payload: { label: string; source: 'todo' | 'note' | 'tool' };
}

// ── Stop-hook events ─────────────────────────────────────────────────────────

/** The coordinator blocked a worker's attempt to end its turn on an unfinished run (stop-hook run guard). */
export interface StopBlockedEvent extends BaseEvent {
  event: 'stop_blocked';
  run_id: string;
  agent_id: string;
  task_ref: string;
  payload: { phase: string | null; count: number; stop_hook_active: boolean };
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
  | TaskDelegatedEvent
  | TaskDispatchBlockedEvent
  | ClaimCreatedEvent
  | ClaimExpiredEvent
  | TaskEnvelopeSentEvent
  | RunStartedEvent
  | WorkCompleteEvent
  | FinalizeRebaseStartedEvent
  | ReadyToMergeEvent
  | RunFinishedEvent
  | RunFailedEvent
  | FinalizationChangedEvent
  | RunCancelledEvent
  | CommandLifecycleEvent
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
  | ReportedForDutyEvent
  | AgentOfflineEvent
  | AgentMarkedDeadEvent
  | SessionStartFailedEvent
  | ScoutLaunchedEvent
  | ScoutLaunchFailedEvent
  | SessionOpenedEvent
  | SessionStateChangedEvent
  | SessionReconciledEvent
  | SessionResumedEvent
  | SessionResumeFailedEvent
  | MasterRetiredEvent
  | SessionStartedEvent
  | CoordinatorStartedEvent
  | CoordinatorStoppedEvent
  | ReviewSubmittedEvent
  | WorkerNeedsAttentionEvent
  | RemediationAppliedEvent
  | ActivityNoteEvent
  | StopBlockedEvent;

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
