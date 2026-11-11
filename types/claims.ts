export type RunId = string;
export type ClaimState = 'claimed' | 'in_progress' | 'done' | 'failed';
export type FinalizationState =
  | 'awaiting_finalize'
  | 'finalize_rebase_requested'
  | 'finalize_rebase_in_progress'
  | 'ready_to_merge'
  | 'blocked_finalize'
  | 'pr_created'
  | 'pr_review_in_progress'
  | 'pr_merged'
  | 'pr_failed'
  | null;
export type InputState = 'awaiting_input' | null;
/**
 * What a run waits on while `awaiting_input`: the worker's own `orc run-input-request`
 * (cleared only by an answer), or a provider prompt the coordinator saw on the worker's screen
 * (also cleared once the worker shows life again or the prompt is gone).
 */
export type InputSource = 'worker_request' | 'provider_prompt';

export interface TaskSpecSnapshot {
  source_path: string;
  snapshot_path: string;
  sha256: string;
  /** Pinned project SQLite revision; source_path is then `project-task:<ref>@<revision>`. */
  task_revision?: number;
}

export interface Claim {
  run_id: RunId;
  task_ref: string;
  agent_id: string;
  state: ClaimState;
  claimed_at: string;
  lease_expires_at: string;
  task_envelope_sent_at?: string | null;
  last_heartbeat_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  failure_reason?: string;
  finalization_state?: FinalizationState;
  finalization_retry_count?: number;
  finalization_blocked_reason?: string | null;
  input_state?: InputState;
  input_requested_at?: string | null;
  /** Set with `input_state`; absent on claims written before it existed (read as `worker_request`). */
  input_source?: InputSource | null;
  session_start_retry_count?: number;
  session_start_retry_next_at?: string | null;
  session_start_last_error?: string | null;
  escalation_notified_at?: string | null;
  pr_ref?: string | null;
  pr_created_at?: string | null;
  pr_initial_work_complete_seq?: number | null;
  task_spec_snapshot?: TaskSpecSnapshot;
}

export interface ClaimsState {
  version: '1';
  claims: Claim[];
}
