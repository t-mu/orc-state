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
  session_start_retry_count?: number;
  session_start_retry_next_at?: string | null;
  session_start_last_error?: string | null;
  escalation_notified_at?: string | null;
  pr_ref?: string | null;
  pr_created_at?: string | null;
  pr_reviewer_agent_id?: string | null;
}

export interface ClaimsState {
  version: '1';
  claims: Claim[];
}
