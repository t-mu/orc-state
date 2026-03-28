import type { Claim, FinalizationState } from '../types/claims.ts';
import { DEFAULT_LEASE_MS, FINALIZE_LEASE_MS } from './constants.ts';

// ── Input type ─────────────────────────────────────────────────────────────

/**
 * Minimal event slice needed by the reducer. Coordinator passes compatible
 * OrcEvent objects — this avoids a circular dependency on coordinator.ts.
 */
export interface LifecycleEventInput {
  event: string;
  run_id?: string;
  agent_id?: string;
  task_ref?: string;
  ts?: string;
  actor_type?: string;
  payload?: Record<string, unknown>;
}

// ── Action union ───────────────────────────────────────────────────────────

/**
 * Discriminated union describing the coordinator state change to apply.
 * The coordinator is responsible for calling the appropriate claimManager
 * helpers and handling secondary effects (notifications, activity tracking,
 * finalizeRun, etc.).
 */
export type LifecycleAction =
  | { type: 'start_run'; at: string }
  | { type: 'heartbeat'; at: string; leaseDurationMs: number }
  | {
      type: 'advance_finalization';
      state: FinalizationState;
      retryCountDelta: number;
      blockedReason: string | null;
      /** When non-null, also extend the claim lease by this many ms. */
      extendLeaseMs: number | null;
    }
  | { type: 'clear_input_state' }
  | { type: 'set_input_state'; requestedAt: string }
  | {
      type: 'finish_run';
      success: boolean;
      failureReason: string | null;
      failureCode: string | null;
      policy: string;
      at: string;
    }
  | { type: 'noop'; reason: string };

// ── Phase events that act as activity heartbeats ───────────────────────────

const PHASE_EVENTS = new Set([
  'phase_started',
  'phase_finished',
  'blocked',
  'need_input',
  'input_provided',
  'unblocked',
]);

// ── Timestamp helpers ──────────────────────────────────────────────────────

/**
 * Coerce an agent-provided timestamp to a valid ISO string, falling back to
 * nowIso when the value is absent or invalid.
 */
export function coerceEventTs(ts: unknown, nowIso: string): string {
  if (ts && typeof ts === 'string' && Number.isFinite(new Date(ts).getTime())) return ts;
  return nowIso;
}

/**
 * Return an authoritative coordinator timestamp that:
 *  - does not exceed nowIso (prevents future-dated coordinator state), and
 *  - does not fall below floorTs (preserves monotonic ordering).
 */
export function authoritativeTs(
  eventTs: string,
  floorTs: string | null | undefined,
  nowIso: string,
): string {
  const eventMs = new Date(eventTs).getTime();
  const nowMs = new Date(nowIso).getTime();
  const floorMs = typeof floorTs === 'string' ? new Date(floorTs).getTime() : NaN;
  const boundedMs = Math.min(eventMs, nowMs);
  const effectiveMs = Number.isFinite(floorMs) ? Math.max(boundedMs, floorMs) : boundedMs;
  return new Date(effectiveMs).toISOString();
}

// ── Reducer ────────────────────────────────────────────────────────────────

/**
 * Pure lifecycle reducer.
 *
 * Given a lifecycle event, the current claim (or null if absent/expired), and
 * the coordinator wall-clock time, returns the state transition action to
 * apply. Returns `{ type: 'noop' }` for duplicate, ignored, or invalid
 * transitions.
 *
 * This function has no side effects and performs no I/O.
 */
export function reduceLifecycleEvent(
  event: LifecycleEventInput,
  claim: Claim | null,
  nowIso: string,
): LifecycleAction {
  const eventTs = coerceEventTs(event.ts, nowIso);

  // ── input_requested ──────────────────────────────────────────────────────
  if (event.event === 'input_requested') {
    // Skip events the coordinator emitted itself (prevents self-loops).
    if (event.actor_type === 'coordinator') {
      return { type: 'noop', reason: 'coordinator_self_event' };
    }
    return { type: 'set_input_state', requestedAt: authoritativeTs(eventTs, null, nowIso) };
  }

  // ── run_started ──────────────────────────────────────────────────────────
  if (event.event === 'run_started') {
    if (!claim || claim.state !== 'claimed') {
      return { type: 'noop', reason: claim ? `wrong_state:${claim.state}` : 'no_claim' };
    }
    return { type: 'start_run', at: authoritativeTs(eventTs, claim.claimed_at, nowIso) };
  }

  // ── heartbeat ────────────────────────────────────────────────────────────
  if (event.event === 'heartbeat') {
    if (!event.run_id || !event.agent_id) {
      return { type: 'noop', reason: 'missing_run_or_agent' };
    }
    if (!claim || claim.state !== 'in_progress') {
      return { type: 'noop', reason: claim ? `wrong_state:${claim.state}` : 'no_claim' };
    }
    const floorTs = claim.last_heartbeat_at ?? claim.started_at ?? claim.claimed_at;
    return {
      type: 'heartbeat',
      at: authoritativeTs(eventTs, floorTs, nowIso),
      leaseDurationMs: DEFAULT_LEASE_MS,
    };
  }

  // ── phase / activity events ──────────────────────────────────────────────
  if (PHASE_EVENTS.has(event.event)) {
    if (!claim || claim.state !== 'in_progress') {
      return { type: 'noop', reason: claim ? `wrong_state:${claim.state}` : 'no_claim' };
    }
    const floorTs = claim.last_heartbeat_at ?? claim.started_at ?? claim.claimed_at;
    return {
      type: 'heartbeat',
      at: authoritativeTs(eventTs, floorTs, nowIso),
      leaseDurationMs: DEFAULT_LEASE_MS,
    };
  }

  // ── finalize_rebase_started ──────────────────────────────────────────────
  if (event.event === 'finalize_rebase_started') {
    if (
      !claim
      || claim.state !== 'in_progress'
      || claim.finalization_state !== 'finalize_rebase_requested'
    ) {
      const detail = claim
        ? `wrong_state:${claim.state}/${String(claim.finalization_state)}`
        : 'no_claim';
      return { type: 'noop', reason: detail };
    }
    return {
      type: 'advance_finalization',
      state: 'finalize_rebase_in_progress',
      retryCountDelta: 1,
      blockedReason: null,
      extendLeaseMs: FINALIZE_LEASE_MS,
    };
  }

  // ── input_response ───────────────────────────────────────────────────────
  if (event.event === 'input_response') {
    // Clear regardless of current state — races with terminal events are
    // handled by the coordinator's try/catch wrapper.
    return { type: 'clear_input_state' };
  }

  // ── run_finished / run_failed ────────────────────────────────────────────
  if (event.event === 'run_finished' || event.event === 'run_failed') {
    if (!claim || !['claimed', 'in_progress'].includes(claim.state)) {
      return {
        type: 'noop',
        reason: claim ? `already_terminal:${claim.state}` : 'no_claim',
      };
    }
    const floorTs = claim.finished_at ?? claim.started_at ?? claim.claimed_at;
    const at = authoritativeTs(eventTs, floorTs, nowIso);
    if (event.event === 'run_finished') {
      return { type: 'finish_run', success: true, failureReason: null, failureCode: null, policy: 'requeue', at };
    }
    return {
      type: 'finish_run',
      success: false,
      failureReason: typeof event.payload?.reason === 'string' ? event.payload.reason : null,
      failureCode: typeof event.payload?.code === 'string' ? event.payload.code : null,
      policy: typeof event.payload?.policy === 'string' ? event.payload.policy : 'requeue',
      at,
    };
  }

  // ── work_complete ────────────────────────────────────────────────────────
  if (event.event === 'work_complete') {
    if (!claim || claim.state !== 'in_progress') {
      return { type: 'noop', reason: claim ? `wrong_state:${claim.state}` : 'no_claim' };
    }
    // Idempotence: duplicate work_complete is a noop once finalization has started.
    if (claim.finalization_state != null) {
      return {
        type: 'noop',
        reason: `finalization_already_started:${String(claim.finalization_state)}`,
      };
    }
    return {
      type: 'advance_finalization',
      state: 'awaiting_finalize',
      retryCountDelta: 0,
      blockedReason: null,
      extendLeaseMs: FINALIZE_LEASE_MS,
    };
  }

  // ── ready_to_merge ───────────────────────────────────────────────────────
  if (event.event === 'ready_to_merge') {
    if (!claim || claim.state !== 'in_progress') {
      return { type: 'noop', reason: claim ? `wrong_state:${claim.state}` : 'no_claim' };
    }
    if (claim.finalization_state !== 'finalize_rebase_in_progress') {
      return {
        type: 'noop',
        reason: `wrong_finalization_state:${String(claim.finalization_state)}`,
      };
    }
    return {
      type: 'advance_finalization',
      state: 'ready_to_merge',
      retryCountDelta: 0,
      blockedReason: null,
      extendLeaseMs: FINALIZE_LEASE_MS,
    };
  }

  return { type: 'noop', reason: `unhandled_event:${event.event}` };
}
