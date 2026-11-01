/**
 * Run progress, tracked apart from liveness. Hook activity proves a worker is
 * alive; progress is a phase change, a commit, or a lifecycle event. A run that
 * stays alive without progress is escalated by the coordinator.
 */
import type { ToolHookEvent } from './hookEventBus.ts';

/** Worker lifecycle events that move a run forward (phase changes are tracked separately). */
const RUN_PROGRESS_EVENTS = new Set([
  'run_started',
  'review_submitted',
  'work_complete',
  'finalize_rebase_started',
  'ready_to_merge',
  'input_requested',
  'input_provided',
]);

const GIT_COMMIT_PATTERN = /\bgit\b(?:\s+-C\s+\S+)?\s+commit\b/;

/** True when an event is a lifecycle event that counts as progress. */
export function isProgressLifecycleEvent(event: { event?: string; run_id?: string }): boolean {
  return Boolean(event.run_id) && RUN_PROGRESS_EVENTS.has(event.event ?? '');
}

/** True when a tool hook event is a `git commit`. */
export function isCommitToolEvent(event: ToolHookEvent): boolean {
  return event.tool === 'Bash' && GIT_COMMIT_PATTERN.test(event.brief);
}

/** True when a `phase_started` event was reported by the worker rather than inferred by the coordinator. */
export function isExplicitPhaseEvent(event: { event?: string; actor_type?: string; payload?: unknown }): boolean {
  if (event.event !== 'phase_started' || event.actor_type === 'coordinator') return false;
  return (event.payload as { inferred?: unknown } | undefined)?.inferred !== true;
}

export interface NoProgressInput {
  /** Newest progress timestamp, or the run's start when there is none yet. */
  progressAt: string | null;
  /** Milliseconds since the run's last liveness activity. */
  idleMs: number;
  /** Idle time at which the run counts as stale (the stale alert covers it then). */
  staleSoftMs: number;
  /** Time without progress before the alert. */
  thresholdMs: number;
  /** The progress timestamp an alert was already sent for, if any. */
  notifiedFor: string | null;
  nowMs: number;
}

/**
 * Milliseconds the run has been alive without progress when it should be
 * escalated now, or null. One alert per progress timestamp: new progress re-arms it.
 */
export function noProgressEscalationMs(input: NoProgressInput): number | null {
  if (!input.progressAt) return null;
  const progressMs = Date.parse(input.progressAt);
  if (!Number.isFinite(progressMs)) return null;
  if (input.notifiedFor === input.progressAt) return null;
  // A stale run is not alive: the stale alert handles it.
  if (input.idleMs >= input.staleSoftMs) return null;
  const noProgressMs = input.nowMs - progressMs;
  return noProgressMs >= input.thresholdMs ? noProgressMs : null;
}
