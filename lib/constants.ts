/**
 * Shared constant definitions used across the orchestrator codebase.
 */

export const TASK_TYPES: readonly string[] = ['implementation', 'refactor'];

export const AGENT_ROLES: readonly string[] = ['worker', 'reviewer', 'master', 'scout'];

export const TASK_STATUSES: readonly string[] = ['todo', 'claimed', 'in_progress', 'done', 'blocked', 'released', 'cancelled'];

export const TASK_PRIORITIES: readonly string[] = ['low', 'normal', 'high', 'critical'];

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const TASK_REF_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/** Lock files older than this are considered candidates for stale-breaking (ms). */
export const LOCK_STALE_MS = 30_000;

/** Default claim lease duration (ms). */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;

/** Secondary timeout for claims stuck awaiting input (ms). */
export const INPUT_WAIT_TIMEOUT_MS = 3_600_000; // 1 hour

/**
 * Extended lease duration for the finalize phase (awaiting_finalize,
 * finalize_rebase_requested, finalize_rebase_in_progress). Gives the worker
 * ample time to complete a rebase and for the coordinator to merge without
 * the claim expiring mid-finalization.
 */
export const FINALIZE_LEASE_MS = 60 * 60 * 1000;

/** Idle seconds before a run is considered stalled in status views. */
export const STALLED_RUN_IDLE_SECONDS = 10 * 60;

/** Poll interval for the master PTY forwarder (ms). */
export const PTY_POLL_INTERVAL_MS = 5_000;

/** TTL after which an agent with no recent activity is considered dead (ms). */
export const AGENT_DEAD_TTL_MS = 2 * 60 * 60 * 1000;

/** Timeout for coordinator git operations to prevent tick blockage (ms). */
export const GIT_OP_TIMEOUT_MS = 30_000;

/** Timeout for waiting for a scout worker to become ready (ms). */
export const DEFAULT_SCOUT_READY_TIMEOUT_MS = 60_000;

/** Heartbeat interval used by the run-input-request poller (ms). */
export const INPUT_REQUEST_HEARTBEAT_INTERVAL_MS = 60_000;
