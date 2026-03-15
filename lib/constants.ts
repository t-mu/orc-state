/**
 * Shared constant definitions used across the orchestrator codebase.
 */

export const TASK_TYPES: readonly string[] = ['implementation', 'refactor'];

export const AGENT_ROLES: readonly string[] = ['worker', 'reviewer', 'master'];

export const TASK_STATUSES: readonly string[] = ['todo', 'claimed', 'in_progress', 'done', 'blocked', 'released'];

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export const TASK_REF_RE = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/** Lock files older than this are considered candidates for stale-breaking (ms). */
export const LOCK_STALE_MS = 30_000;

/** Default claim lease duration (ms). */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000;

/** Idle seconds before a run is considered stalled in status views. */
export const STALLED_RUN_IDLE_SECONDS = 10 * 60;

/** Poll interval for the master PTY forwarder (ms). */
export const PTY_POLL_INTERVAL_MS = 5_000;
