import { describe, it, expect } from 'vitest';
import {
  reduceLifecycleEvent,
  coerceEventTs,
  authoritativeTs,
  type LifecycleEventInput,
} from './workerLifecycleReducer.ts';
import type { Claim } from '../types/claims.ts';
import { DEFAULT_LEASE_MS, FINALIZE_LEASE_MS } from './constants.ts';

const NOW = '2026-03-11T08:00:00.000Z';

function makeClaim(overrides: Partial<Claim> = {}): Claim {
  return {
    run_id: 'run-test-001',
    task_ref: 'proj/task-1',
    agent_id: 'orc-1',
    state: 'in_progress',
    claimed_at: '2026-03-11T07:00:00.000Z',
    lease_expires_at: '2026-03-11T09:00:00.000Z',
    started_at: '2026-03-11T07:01:00.000Z',
    last_heartbeat_at: null,
    finalization_state: null,
    finalization_retry_count: 0,
    finalization_blocked_reason: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<LifecycleEventInput> = {}): LifecycleEventInput {
  return {
    event: 'heartbeat',
    run_id: 'run-test-001',
    agent_id: 'orc-1',
    task_ref: 'proj/task-1',
    ts: NOW,
    actor_type: 'agent',
    ...overrides,
  };
}

// ── coerceEventTs ──────────────────────────────────────────────────────────

describe('coerceEventTs', () => {
  it('returns valid ISO string as-is', () => {
    expect(coerceEventTs('2026-01-01T00:00:00.000Z', NOW)).toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back to nowIso for undefined', () => {
    expect(coerceEventTs(undefined, NOW)).toBe(NOW);
  });

  it('falls back to nowIso for invalid string', () => {
    expect(coerceEventTs('not-a-date', NOW)).toBe(NOW);
  });

  it('falls back to nowIso for null', () => {
    expect(coerceEventTs(null, NOW)).toBe(NOW);
  });
});

// ── authoritativeTs ────────────────────────────────────────────────────────

describe('authoritativeTs', () => {
  it('returns eventTs when it is before nowIso and no floor', () => {
    const result = authoritativeTs('2026-03-11T07:59:00.000Z', null, NOW);
    expect(result).toBe('2026-03-11T07:59:00.000Z');
  });

  it('caps at nowIso when eventTs is in the future', () => {
    const future = '2026-03-11T09:00:00.000Z';
    const result = authoritativeTs(future, null, NOW);
    expect(result).toBe(NOW);
  });

  it('returns floor when eventTs is before floor', () => {
    const floor = '2026-03-11T07:50:00.000Z';
    const result = authoritativeTs('2026-03-11T07:30:00.000Z', floor, NOW);
    expect(result).toBe(floor);
  });

  it('allows floor to win even when it is ahead of now (preserves monotonicity over future-cap)', () => {
    // When a floor timestamp (e.g. already-recorded claimed_at) is later than
    // nowIso, the floor wins to preserve monotonic ordering of state timestamps.
    const floor = '2026-03-11T09:00:00.000Z';
    const result = authoritativeTs('2026-03-11T09:30:00.000Z', floor, NOW);
    expect(result).toBe(floor);
  });
});

// ── reduceLifecycleEvent ───────────────────────────────────────────────────

describe('applies lifecycle transitions through the reducer boundary', () => {
  it('returns start_run for run_started on a claimed claim', () => {
    const claim = makeClaim({ state: 'claimed', claimed_at: '2026-03-11T07:00:00.000Z', started_at: null });
    const action = reduceLifecycleEvent(makeEvent({ event: 'run_started', ts: '2026-03-11T07:59:00.000Z' }), claim, NOW);
    expect(action.type).toBe('start_run');
    if (action.type === 'start_run') {
      expect(action.at).toBe('2026-03-11T07:59:00.000Z');
    }
  });

  it('returns noop for run_started on an already in_progress claim', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'run_started' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toContain('wrong_state');
    }
  });

  it('returns noop for run_started when no claim exists', () => {
    const action = reduceLifecycleEvent(makeEvent({ event: 'run_started' }), null, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toBe('no_claim');
    }
  });

  it('returns heartbeat for heartbeat event on an in_progress claim', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'heartbeat', ts: '2026-03-11T07:55:00.000Z' }), claim, NOW);
    expect(action.type).toBe('heartbeat');
    if (action.type === 'heartbeat') {
      expect(action.leaseDurationMs).toBe(DEFAULT_LEASE_MS);
      expect(action.at).toBeTruthy();
    }
  });

  it('returns heartbeat for heartbeat event on a claimed claim', () => {
    const claim = makeClaim({ state: 'claimed' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'heartbeat' }), claim, NOW);
    expect(action.type).toBe('heartbeat');
  });

  it('returns noop for heartbeat when run_id or agent_id is absent', () => {
    const claim = makeClaim();
    const noRunIdEvent: LifecycleEventInput = { ...makeEvent({ event: 'heartbeat' }) };
    delete (noRunIdEvent as Partial<LifecycleEventInput>).run_id;
    const action = reduceLifecycleEvent(noRunIdEvent, claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toBe('missing_run_or_agent');
    }
  });

  it('returns heartbeat for phase events on an in_progress claim', () => {
    for (const evt of ['phase_started', 'phase_finished', 'blocked', 'need_input', 'input_provided', 'unblocked']) {
      const claim = makeClaim({ state: 'in_progress' });
      const action = reduceLifecycleEvent(makeEvent({ event: evt }), claim, NOW);
      expect(action.type).toBe('heartbeat');
    }
  });

  it('returns noop for phase events when claim is not in_progress', () => {
    const claim = makeClaim({ state: 'claimed' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'phase_started' }), claim, NOW);
    expect(action.type).toBe('noop');
  });

  it('advances finalization state for finalize_rebase_started', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: 'finalize_rebase_requested' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'finalize_rebase_started' }), claim, NOW);
    expect(action.type).toBe('advance_finalization');
    if (action.type === 'advance_finalization') {
      expect(action.state).toBe('finalize_rebase_in_progress');
      expect(action.retryCountDelta).toBe(1);
      expect(action.extendLeaseMs).toBe(FINALIZE_LEASE_MS);
    }
  });

  it('returns noop for finalize_rebase_started when finalization_state is not rebase_requested', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: 'awaiting_finalize' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'finalize_rebase_started' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toContain('wrong_state');
    }
  });

  it('returns clear_input_state for input_response regardless of claim state', () => {
    // With a claim
    const claim = makeClaim({ state: 'in_progress' });
    expect(reduceLifecycleEvent(makeEvent({ event: 'input_response' }), claim, NOW).type).toBe('clear_input_state');

    // Without a claim
    expect(reduceLifecycleEvent(makeEvent({ event: 'input_response' }), null, NOW).type).toBe('clear_input_state');
  });

  it('returns finish_run with success=true for run_finished on eligible claim', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'run_finished' }), claim, NOW);
    expect(action.type).toBe('finish_run');
    if (action.type === 'finish_run') {
      expect(action.success).toBe(true);
      expect(action.failureReason).toBeNull();
      expect(action.failureCode).toBeNull();
    }
  });

  it('returns finish_run with success=false for run_failed with payload fields', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({
      event: 'run_failed',
      payload: { policy: 'block', reason: 'out of retries', code: 'ERR_BAIL' },
    }), claim, NOW);
    expect(action.type).toBe('finish_run');
    if (action.type === 'finish_run') {
      expect(action.success).toBe(false);
      expect(action.failureReason).toBe('out of retries');
      expect(action.failureCode).toBe('ERR_BAIL');
      expect(action.policy).toBe('block');
    }
  });

  it('returns noop for run_finished on an already-terminal claim', () => {
    const claim = makeClaim({ state: 'done' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'run_finished' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toContain('already_terminal');
    }
  });

  it('advances finalization to awaiting_finalize for work_complete when no finalization is in progress', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: null });
    const action = reduceLifecycleEvent(makeEvent({ event: 'work_complete' }), claim, NOW);
    expect(action.type).toBe('advance_finalization');
    if (action.type === 'advance_finalization') {
      expect(action.state).toBe('awaiting_finalize');
      expect(action.extendLeaseMs).toBe(FINALIZE_LEASE_MS);
    }
  });

  it('returns noop for work_complete when finalization is already started (idempotent)', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: 'awaiting_finalize' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'work_complete' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toContain('finalization_already_started');
    }
  });

  it('advances finalization to ready_to_merge for ready_to_merge when rebase is in_progress', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: 'finalize_rebase_in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'ready_to_merge' }), claim, NOW);
    expect(action.type).toBe('advance_finalization');
    if (action.type === 'advance_finalization') {
      expect(action.state).toBe('ready_to_merge');
      expect(action.extendLeaseMs).toBe(FINALIZE_LEASE_MS);
    }
  });

  it('returns noop for ready_to_merge when finalization_state is not rebase_in_progress', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: 'awaiting_finalize' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'ready_to_merge' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toContain('wrong_finalization_state');
    }
  });

  it('returns noop for unknown event types', () => {
    const claim = makeClaim();
    const action = reduceLifecycleEvent(makeEvent({ event: 'some_future_event' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toContain('unhandled_event');
    }
  });
});

// ── Treats duplicate and replayed events as explicit reducer outcomes ───────

describe('treats duplicate and replayed events as explicit reducer outcomes', () => {
  it('returns noop for run_started replayed on already in_progress claim', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'run_started' }), claim, NOW);
    expect(action.type).toBe('noop');
  });

  it('returns noop for run_finished replayed on already terminal claim', () => {
    const claim = makeClaim({ state: 'done' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'run_finished' }), claim, NOW);
    expect(action.type).toBe('noop');
  });

  it('returns noop for work_complete when finalization already in rebase phase', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: 'finalize_rebase_requested' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'work_complete' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toContain('finalization_already_started');
    }
  });

  it('returns noop for finalize_rebase_started when state is already in_progress', () => {
    const claim = makeClaim({ state: 'in_progress', finalization_state: 'finalize_rebase_in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'finalize_rebase_started' }), claim, NOW);
    expect(action.type).toBe('noop');
  });
});

// ── Timestamp handling ─────────────────────────────────────────────────────

describe('timestamp handling', () => {
  it('uses floor when event timestamp predates existing activity', () => {
    const floor = '2026-03-11T07:55:00.000Z';
    const claim = makeClaim({ state: 'in_progress', last_heartbeat_at: floor });
    const staleEvent = makeEvent({ event: 'heartbeat', ts: '2026-03-11T07:30:00.000Z' });
    const action = reduceLifecycleEvent(staleEvent, claim, NOW);
    expect(action.type).toBe('heartbeat');
    if (action.type === 'heartbeat') {
      expect(action.at).toBe(floor);
    }
  });

  it('caps at nowIso for future-dated event timestamps', () => {
    const claim = makeClaim({ state: 'in_progress', last_heartbeat_at: null });
    const futureEvent = makeEvent({ event: 'heartbeat', ts: '2026-12-31T23:59:59.000Z' });
    const action = reduceLifecycleEvent(futureEvent, claim, NOW);
    expect(action.type).toBe('heartbeat');
    if (action.type === 'heartbeat') {
      expect(action.at).toBe(NOW);
    }
  });

  it('falls back to nowIso for absent or invalid event timestamps', () => {
    const claim = makeClaim({ state: 'claimed', started_at: null });
    const noTsEvent: LifecycleEventInput = { ...makeEvent({ event: 'run_started' }) };
    delete (noTsEvent as Partial<LifecycleEventInput>).ts;
    const action = reduceLifecycleEvent(noTsEvent, claim, NOW);
    expect(action.type).toBe('start_run');
    if (action.type === 'start_run') {
      expect(action.at).toBeTruthy();
    }
  });
});

// ── input_requested handling ───────────────────────────────────────────────

describe('input_requested event handling', () => {
  it('returns set_input_state for agent-emitted input_requested', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'input_requested', actor_type: 'agent' }), claim, NOW);
    expect(action.type).toBe('set_input_state');
  });

  it('returns noop for coordinator-emitted input_requested (self-loop guard)', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({ event: 'input_requested', actor_type: 'coordinator' }), claim, NOW);
    expect(action.type).toBe('noop');
    if (action.type === 'noop') {
      expect(action.reason).toBe('coordinator_self_event');
    }
  });
});

// ── Preserves coordinator-visible behavior after extraction ────────────────

describe('preserves coordinator-visible behavior after reducer extraction', () => {
  it('start_run action includes the authoritative timestamp based on claimed_at', () => {
    const claimedAt = '2026-03-11T07:00:00.000Z';
    const claim = makeClaim({ state: 'claimed', claimed_at: claimedAt, started_at: null });
    const action = reduceLifecycleEvent(
      makeEvent({ event: 'run_started', ts: '2026-03-11T07:59:00.000Z' }),
      claim,
      NOW,
    );
    expect(action.type).toBe('start_run');
    if (action.type === 'start_run') {
      // eventTs (07:59) is before now (08:00) and after floor (07:00) — should be eventTs
      expect(action.at).toBe('2026-03-11T07:59:00.000Z');
    }
  });

  it('heartbeat action uses last_heartbeat_at as the monotonic floor', () => {
    const lastHb = '2026-03-11T07:58:00.000Z';
    const claim = makeClaim({ state: 'in_progress', last_heartbeat_at: lastHb });
    const action = reduceLifecycleEvent(
      makeEvent({ event: 'heartbeat', ts: '2026-03-11T07:59:30.000Z' }),
      claim,
      NOW,
    );
    expect(action.type).toBe('heartbeat');
    if (action.type === 'heartbeat') {
      expect(action.at).toBe('2026-03-11T07:59:30.000Z');
    }
  });

  it('finish_run carries the correct failure details from run_failed payload', () => {
    const claim = makeClaim({ state: 'in_progress' });
    const action = reduceLifecycleEvent(makeEvent({
      event: 'run_failed',
      payload: { policy: 'requeue', reason: 'timed out', code: 'ERR_TIMEOUT' },
    }), claim, NOW);
    expect(action.type).toBe('finish_run');
    if (action.type === 'finish_run') {
      expect(action.success).toBe(false);
      expect(action.failureReason).toBe('timed out');
      expect(action.failureCode).toBe('ERR_TIMEOUT');
      expect(action.policy).toBe('requeue');
    }
  });
});
