import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { appendSequencedEvent, closeAllDatabases, initEventsDb, queryEvents } from './eventLog.ts';
import { validateEventObject } from './eventValidation.ts';
import { commitClaims } from './runStore.ts';
import { STOP_BLOCK_CAP, STOP_BLOCK_RUN_CAP, STOP_BLOCK_WINDOW_MS, applyStopCheck, decideStopCheck } from './stopCheck.ts';
import type { Claim } from '../types/claims.ts';
import type { OrcEvent } from '../types/events.ts';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', state: 'in_progress',
    claimed_at: '2026-10-31T11:00:00.000Z', started_at: '2026-10-31T11:00:01.000Z',
    lease_expires_at: '2099-01-01T00:00:00.000Z', ...overrides,
  };
}

let seq = 0;
function event(name: string, extra: Record<string, unknown> = {}, ts = new Date(NOW - 60_000).toISOString()): OrcEvent {
  seq += 1;
  return { seq, ts, event: name, actor_type: 'agent', actor_id: 'worker-a', run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', ...extra } as unknown as OrcEvent;
}

function decide(c: Claim | null, events: OrcEvent[] = []) {
  return decideStopCheck({ runId: 'run-a', agentId: 'worker-a', claim: c, events, nowMs: NOW });
}

describe('decideStopCheck', () => {
  it('blocks an unfinished in-progress run with the reason and its current phase', () => {
    const decision = decide(claim(), [event('phase_started', { phase: 'explore' }), event('phase_started', { phase: 'implement' })]);
    expect(decision).toEqual({
      allow: false,
      reason: 'Run run-a (phase implement) is not finished. Continue the work, or call orc run-work-complete / orc run-input-request / orc run-fail as appropriate.',
      phase: 'implement',
      count: 1,
    });
  });

  it('blocks a claimed run that has not started, naming the phase unknown', () => {
    const decision = decide(claim({ state: 'claimed' }));
    expect(decision.allow).toBe(false);
    expect(decision.phase).toBeNull();
    expect(decision.reason).toContain('(phase unknown)');
  });

  it.each([
    'awaiting_finalize', 'finalize_rebase_requested', 'finalize_rebase_in_progress', 'ready_to_merge', 'blocked_finalize', 'pr_created',
  ] as const)('allows the stop in finalization state %s', (state) => {
    expect(decide(claim({ finalization_state: state }))).toEqual({ allow: true });
  });

  it('allows the stop once run-work-complete is recorded, before the coordinator tick updates the claim', () => {
    expect(decide(claim(), [event('run_started'), event('work_complete', { payload: { status: 'awaiting_finalize' } })])).toEqual({ allow: true });
    expect(decide(claim(), [event('run_started'), event('ready_to_merge', { payload: { status: 'ready_to_merge' } })])).toEqual({ allow: true });
  });

  it('allows the stop while an input request is pending, from the claim or from the events', () => {
    expect(decide(claim({ input_state: 'awaiting_input' }))).toEqual({ allow: true });
    expect(decide(claim(), [event('input_requested', { payload: { question: 'q?' } })])).toEqual({ allow: true });
  });

  it('blocks again once a pending input request has been answered', () => {
    const events = [event('input_requested', { payload: { question: 'q?' } }), event('input_response', { payload: { response: 'yes' } })];
    expect(decide(claim(), events).allow).toBe(false);
  });

  it.each(['done', 'failed'] as const)('allows the stop for a %s run', (state) => {
    expect(decide(claim({ state }))).toEqual({ allow: true });
  });

  it('allows the stop when the run has no claim or another agent holds it', () => {
    expect(decide(null)).toEqual({ allow: true });
    expect(decide(claim({ agent_id: 'worker-b' }))).toEqual({ allow: true });
  });

  it('allows the stop once the cap is reached within the window, and counts only blocks inside it', () => {
    const recent = Array.from({ length: STOP_BLOCK_CAP }, () => event('stop_blocked', { payload: { phase: null, count: 1, stop_hook_active: true } }));
    expect(decide(claim(), recent)).toEqual({ allow: true });

    const old = new Date(NOW - STOP_BLOCK_WINDOW_MS - 1).toISOString();
    const aged = [
      event('stop_blocked', { payload: { phase: null, count: 1, stop_hook_active: false } }, old),
      ...recent.slice(1),
    ];
    const decision = decide(claim(), aged);
    expect(decision.allow).toBe(false);
    expect(decision.count).toBe(STOP_BLOCK_CAP);
  });

  it('allows every stop once the run has been blocked STOP_BLOCK_RUN_CAP times, however old the blocks', () => {
    const old = new Date(NOW - 5 * STOP_BLOCK_WINDOW_MS).toISOString();
    const lifetime = Array.from({ length: STOP_BLOCK_RUN_CAP }, () => event('stop_blocked', { payload: { phase: null, count: 1, stop_hook_active: false } }, old));
    expect(decide(claim(), lifetime)).toEqual({ allow: true });
    expect(decide(claim(), lifetime.slice(1)).allow).toBe(false);
  });
});

describe('applyStopCheck', () => {
  let dir: string;
  beforeEach(() => {
    dir = createTempStateDir('orch-stop-check-');
    seedState(dir);
    initEventsDb(dir);
    commitClaims(dir, { version: '1', claims: [claim()] });
    appendSequencedEvent(dir, {
      ts: new Date(NOW - 60_000).toISOString(), event: 'phase_started', actor_type: 'agent', actor_id: 'worker-a',
      run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', phase: 'implement',
    }, { lockStrategy: 'none' });
  });
  afterEach(() => {
    closeAllDatabases();
    cleanupTempStateDir(dir);
  });

  it('records a valid stop_blocked event per block and stops blocking after the cap (no loop)', () => {
    const results = Array.from({ length: STOP_BLOCK_CAP + 2 }, (_, index) =>
      applyStopCheck(dir, { runId: 'run-a', agentId: 'worker-a', stopHookActive: index > 0, nowMs: NOW + index * 1000 }));
    expect(results.slice(0, STOP_BLOCK_CAP).every((result) => !result.allow && result.reason?.includes('Run run-a (phase implement)'))).toBe(true);
    expect(results.slice(STOP_BLOCK_CAP)).toEqual([{ allow: true }, { allow: true }]);

    const blocked = queryEvents(dir, { run_id: 'run-a', event_type: 'stop_blocked' });
    expect(blocked).toHaveLength(STOP_BLOCK_CAP);
    expect(blocked.map((e) => (e as { payload: unknown }).payload)).toEqual([
      { phase: 'implement', count: 1, stop_hook_active: false },
      { phase: 'implement', count: 2, stop_hook_active: true },
      { phase: 'implement', count: 3, stop_hook_active: true },
    ]);
    for (const e of blocked) {
      expect(e).toMatchObject({ actor_type: 'coordinator', run_id: 'run-a', agent_id: 'worker-a', task_ref: 'orch/task-a' });
      expect(validateEventObject(e)).toEqual([]);
    }
  });

  it('blocks again once the window has passed', () => {
    for (let index = 0; index < STOP_BLOCK_CAP; index += 1) applyStopCheck(dir, { runId: 'run-a', agentId: 'worker-a', stopHookActive: true, nowMs: NOW });
    expect(applyStopCheck(dir, { runId: 'run-a', agentId: 'worker-a', stopHookActive: true, nowMs: NOW }).allow).toBe(true);
    expect(applyStopCheck(dir, { runId: 'run-a', agentId: 'worker-a', stopHookActive: false, nowMs: NOW + STOP_BLOCK_WINDOW_MS + 1 }).allow).toBe(false);
  });

  it('stops blocking for good after STOP_BLOCK_RUN_CAP blocks spread over several windows', () => {
    const results: boolean[] = [];
    for (let window = 0; window < 4; window += 1) {
      for (let index = 0; index < STOP_BLOCK_CAP; index += 1) {
        results.push(applyStopCheck(dir, { runId: 'run-a', agentId: 'worker-a', stopHookActive: index > 0, nowMs: NOW + window * (STOP_BLOCK_WINDOW_MS + 1) + index }).allow);
      }
    }
    expect(results.filter((allowed) => !allowed)).toHaveLength(STOP_BLOCK_RUN_CAP);
    expect(results.slice(STOP_BLOCK_RUN_CAP).every(Boolean)).toBe(true);
  });

  it('allows without recording an event once the run handed off', () => {
    appendSequencedEvent(dir, {
      ts: new Date(NOW - 1000).toISOString(), event: 'work_complete', actor_type: 'agent', actor_id: 'worker-a',
      run_id: 'run-a', task_ref: 'orch/task-a', agent_id: 'worker-a', payload: { status: 'awaiting_finalize' },
    }, { lockStrategy: 'none' });
    expect(applyStopCheck(dir, { runId: 'run-a', agentId: 'worker-a', stopHookActive: false, nowMs: NOW })).toEqual({ allow: true });
    expect(queryEvents(dir, { run_id: 'run-a', event_type: 'stop_blocked' })).toEqual([]);
  });
});
