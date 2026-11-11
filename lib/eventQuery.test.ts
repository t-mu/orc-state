import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSequencedEvent, closeAllDatabases, initEventsDb } from './eventLog.ts';
import { compactEvent, queryEventsPage } from './eventQuery.ts';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import type { OrcEventInput } from '../types/events.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-event-query-test-');
  initEventsDb(dir);
});

afterEach(() => {
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

function seed(event: string, extra: Record<string, unknown> = {}) {
  appendSequencedEvent(dir, {
    ts: '2026-01-01T00:00:00Z', event, actor_type: 'agent', actor_id: 'w1', agent_id: 'w1', run_id: 'run-1', task_ref: 'f/t', payload: {}, ...extra,
  } as unknown as OrcEventInput);
}

function seedHeartbeats(count: number) {
  for (let i = 0; i < count; i++) seed('heartbeat');
}

const seqs = (result: { events: Array<Record<string, unknown>> }) => result.events.map((event) => event.seq);

describe('queryEventsPage', () => {
  it('pages forward with a cursor across more than 25 events without gaps', () => {
    seedHeartbeats(60);
    const seen: unknown[] = [];
    let cursor = 0;
    let pages = 0;
    for (;;) {
      const page = queryEventsPage(dir, { after_seq: cursor });
      expect(page.events.length).toBeLessThanOrEqual(25);
      seen.push(...seqs(page));
      cursor = page.last_seq;
      pages += 1;
      if (!page.has_more) break;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(queryEventsPage(dir, { after_seq: cursor })).toEqual({ events: [], last_seq: 60, has_more: false });
  });

  it('without a cursor returns the newest page in ascending order and last_seq = newest', () => {
    seedHeartbeats(30);
    const page = queryEventsPage(dir);
    expect(seqs(page)).toEqual(Array.from({ length: 25 }, (_, i) => i + 6));
    expect(page.last_seq).toBe(30);
    expect(page.has_more).toBe(true);
    const small = queryEventsPage(dir, { limit: 50 });
    expect(small.events).toHaveLength(30);
    expect(small.has_more).toBe(false);
  });

  it('returns last_seq 0 on an empty log and after_seq when nothing follows the cursor', () => {
    expect(queryEventsPage(dir)).toEqual({ events: [], last_seq: 0, has_more: false });
    expect(queryEventsPage(dir, { after_seq: 7 })).toEqual({ events: [], last_seq: 7, has_more: false });
  });

  it('notifications_only keeps the notification class', () => {
    seed('heartbeat');
    seed('run_finished');
    seed('task_added');
    seed('input_requested', { payload: { question: 'q?' } });
    seed('worker_needs_attention', { payload: { reason: 'stale', idle_ms: 0 } });
    seed('run_failed', { payload: { policy: 'requeue' } });
    seed('run_cancelled');
    seed('claim_expired', { payload: { policy: 'requeue', code: 'ERR_INPUT_TIMEOUT', reason: 'ERR_INPUT_TIMEOUT' } });
    seed('input_response', { payload: { response: 'yes', request_id: 'r1' } });
    seed('task_dispatch_blocked', { actor_type: 'coordinator', actor_id: 'coordinator', payload: { reason: 'injection_scan', findings: ['x'] } });
    seed('dispatch_stalled', {
      actor_type: 'coordinator', actor_id: 'coordinator', run_id: undefined, agent_id: undefined, task_ref: undefined,
      payload: { free_slots: 1, ready_task_refs: ['f/t'], task_reasons: {}, consecutive_ticks: 3 },
    });
    const page = queryEventsPage(dir, { notifications_only: true, after_seq: 0 });
    expect(page.events.map((event) => event.event)).toEqual([
      'run_finished', 'input_requested', 'worker_needs_attention', 'run_failed', 'run_cancelled', 'claim_expired',
      'input_response', 'task_dispatch_blocked', 'dispatch_stalled',
    ]);
    expect(page.last_seq).toBe(11);
    expect(page.events.find((event) => event.event === 'claim_expired')).toMatchObject({
      run_id: expect.any(String), agent_id: expect.any(String), task_ref: expect.any(String),
      payload: expect.objectContaining({ code: 'ERR_INPUT_TIMEOUT' }),
    });
    expect(queryEventsPage(dir, { notifications_only: true, after_seq: 5 }).events.map((event) => event.event))
      .toEqual(['run_failed', 'run_cancelled', 'claim_expired', 'input_response', 'task_dispatch_blocked', 'dispatch_stalled']);
  });

  it('filters by run_id, agent_id, task_ref, event_type and fts_query', () => {
    seed('run_started', { run_id: 'run-a', agent_id: 'w1', task_ref: 'f/a' });
    seed('run_started', { run_id: 'run-b', agent_id: 'w2', task_ref: 'f/b' });
    seed('heartbeat', { run_id: 'run-a', agent_id: 'w1', task_ref: 'f/a' });
    expect(seqs(queryEventsPage(dir, { run_id: 'run-a' }))).toEqual([1, 3]);
    expect(seqs(queryEventsPage(dir, { agent_id: 'w2' }))).toEqual([2]);
    expect(seqs(queryEventsPage(dir, { task_ref: 'f/a', event_type: 'heartbeat' }))).toEqual([3]);
    expect(seqs(queryEventsPage(dir, { fts_query: 'run_started', task_ref: 'f/b' }))).toEqual([2]);
    expect(() => queryEventsPage(dir, { fts_query: '"unclosed' })).toThrow(/invalid fts_query/);
  });

  it('defaults limit to 25 and rejects values outside 1..100', () => {
    seedHeartbeats(120);
    expect(queryEventsPage(dir).events).toHaveLength(25);
    expect(queryEventsPage(dir, { limit: 100 }).events).toHaveLength(100);
    expect(() => queryEventsPage(dir, { limit: 101 })).toThrow('limit must be an integer from 1 to 100');
    expect(() => queryEventsPage(dir, { limit: 0 })).toThrow(/limit/);
    expect(() => queryEventsPage(dir, { limit: 2.5 })).toThrow(/limit/);
    expect(() => queryEventsPage(dir, { after_seq: -1 })).toThrow(/after_seq/);
    expect(() => queryEventsPage(dir, { run_id: 5 })).toThrow(/run_id must be a string/);
  });

  it('returns compact events by default and the full shape with verbose', () => {
    seed('phase_started', { phase: 'explore' });
    seed('input_response', { payload: { response: 'yes', request_id: 'r1', question: 'a long repeated question' } });
    const [phase, response] = queryEventsPage(dir).events;
    expect(Object.keys(phase).sort()).toEqual(['agent_id', 'event', 'payload', 'phase', 'run_id', 'seq', 'task_ref', 'ts']);
    expect(response.payload).toEqual({ response: 'yes', request_id: 'r1' });
    const [fullPhase, fullResponse] = queryEventsPage(dir, { verbose: true }).events;
    expect(fullPhase).toMatchObject({ actor_type: 'agent', actor_id: 'w1' });
    expect(fullPhase).toHaveProperty('event_id');
    expect(fullResponse.payload).toMatchObject({ question: 'a long repeated question' });
  });

  it('compactEvent leaves other events\' payloads alone', () => {
    expect(compactEvent({ seq: 1, event: 'input_requested', actor_id: 'w', payload: { question: 'q' } }))
      .toEqual({ seq: 1, event: 'input_requested', payload: { question: 'q' } });
  });
});
