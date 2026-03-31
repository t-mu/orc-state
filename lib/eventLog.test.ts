import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  appendEvent,
  appendSequencedEvent,
  closeAllDatabases,
  queryEvents,
  readEvents,
  readEventsSince,
  readRecentEvents,
  nextSeq,
  rotateEventsLogIfNeeded,
} from './eventLog.ts';
import type { OrcEvent } from '../types/index.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = createTempStateDir('orch-events-test-');
  logPath = join(dir, 'events.jsonl');
});

afterEach(() => {
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

function validEvent(seq: number | undefined, event = 'heartbeat', extra: Record<string, unknown> = {}): OrcEvent {
  return {
    seq: seq as number,
    event_id: `evt-${seq ?? 'new'}-${event}`,
    ts: '2026-01-01T00:00:00Z',
    event,
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    agent_id: 'agent-01',
    ...extra,
  } as OrcEvent;
}

describe('appendEvent', () => {
  it('creates the log file and writes a parseable line', () => {
    const event = {
      seq: 1,
      event_id: 'evt-1-claim-created',
      ts: '2024-01-01T00:00:00Z',
      event: 'claim_created',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-abc123',
      task_ref: 'orch/init',
      agent_id: 'agent-01',
      payload: { lease_expires_at: '2024-01-01T01:00:00Z' },
    } as OrcEvent;
    appendEvent(logPath, event, { fsyncPolicy: 'never' });
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it('appends multiple events as separate lines', () => {
    appendEvent(logPath, validEvent(1, 'run_started', { run_id: 'run-1', task_ref: 'orch/task-1' }), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2, 'phase_started', { run_id: 'run-1', task_ref: 'orch/task-1', phase: 'build' }), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(3, 'run_finished', { run_id: 'run-1', task_ref: 'orch/task-1' }), { fsyncPolicy: 'never' });
    const events = readEvents(logPath);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
  });

  it('preserves all event fields', () => {
    const event = {
      seq: 5,
      event_id: 'evt-5-heartbeat',
      ts: '2024-06-01T12:00:00Z',
      event: 'heartbeat',
      actor_type: 'agent',
      actor_id: 'agent-01',
      run_id: 'run-abc123',
      task_ref: 'orch/migrate',
      payload: { phase: 'build', pct: 42 },
    } as OrcEvent;
    appendEvent(logPath, event, { fsyncPolicy: 'never' });
    const [parsed] = readEvents(logPath);
    expect(parsed).toEqual(event);
  });

  it('assigns a durable event_id when one is not provided', () => {
    appendEvent(logPath, {
      seq: 1,
      ts: '2026-01-01T00:00:00Z',
      event: 'heartbeat',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      agent_id: 'agent-01',
    } as OrcEvent, { fsyncPolicy: 'never' });

    const [parsed] = readEvents(logPath);
    expect(typeof parsed.event_id).toBe('string');
    expect(parsed.event_id).toBeTruthy();
  });
});

describe('readEvents', () => {
  it('returns empty array when log file does not exist', () => {
    expect(readEvents(join(dir, 'nonexistent.jsonl'))).toEqual([]);
  });

  it('skips blank lines', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2), { fsyncPolicy: 'never' });
    const events = readEvents(logPath);
    expect(events).toHaveLength(2);
  });
});

describe('readEvents resilience', () => {
  it('skips rows with unparseable JSON and returns remaining events', () => {
    // Insert a valid event, then manually corrupt one row in the DB.
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(3), { fsyncPolicy: 'never' });

    // Directly corrupt row 2 payload in SQLite
    // better-sqlite3 imported at top level
    const db = new Database(join(dir, 'events.db'));
    db.prepare(`UPDATE events SET payload = 'NOT-VALID-JSON' WHERE seq = 2`).run();
    db.close();

    const events = readEvents(logPath);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual([1, 3]);
  });

  it('skips rows that fail validation and returns remaining events', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2), { fsyncPolicy: 'never' });

    // Corrupt row 2 with valid JSON but invalid event schema
    // better-sqlite3 imported at top level
    const db = new Database(join(dir, 'events.db'));
    db.prepare(`UPDATE events SET payload = ? WHERE seq = 2`).run(
      JSON.stringify({ seq: 2, ts: '2026-01-01T00:00:00Z', event: 'handoff_completed', actor_type: 'agent', actor_id: 'worker-01', task_ref: 'docs/task-1' }),
    );
    db.close();

    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
  });

  it('logs console.error for each skipped row', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });

    // better-sqlite3 imported at top level
    const db = new Database(join(dir, 'events.db'));
    db.prepare(`UPDATE events SET payload = 'CORRUPT' WHERE seq = 1`).run();
    db.close();

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      const events = readEvents(logPath);
      expect(events).toHaveLength(0);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('[eventLog]');
      expect(errors[0]).toContain('row 1');
    } finally {
      console.error = origError;
    }
  });
});

describe('readEventsSince', () => {
  it('returns only events with seq greater than afterSeq', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(3), { fsyncPolicy: 'never' });

    const events = readEventsSince(logPath, 1);
    expect(events.map((event) => event.seq)).toEqual([2, 3]);
  });

  it('returns empty array when afterSeq is at or above latest seq', () => {
    appendEvent(logPath, validEvent(5), { fsyncPolicy: 'never' });

    expect(readEventsSince(logPath, 5)).toEqual([]);
    expect(readEventsSince(logPath, 99)).toEqual([]);
  });

  it('returns all events when afterSeq is zero', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2), { fsyncPolicy: 'never' });

    const events = readEventsSince(logPath, 0);
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('returns empty array when log file is missing', () => {
    expect(readEventsSince(join(dir, 'missing-events.jsonl'), 0)).toEqual([]);
  });

  it('skips malformed lines and returns valid events only', () => {
    // With SQLite migration, malformed JSONL lines are skipped on import.
    writeFileSync(
      logPath,
      `${JSON.stringify(validEvent(1))}\nnot-json\n${JSON.stringify(validEvent(3))}\n`,
      'utf8',
    );

    const events = readEventsSince(logPath, 0);
    expect(events.map((event) => event.seq)).toEqual([1, 3]);
  });
});

describe('nextSeq', () => {
  it('returns 1 for a missing log file', () => {
    expect(nextSeq(join(dir, 'empty.jsonl'))).toBe(1);
  });

  it('returns 1 for a log with no events yet', () => {
    writeFileSync(logPath, '', 'utf8');
    expect(nextSeq(logPath)).toBe(1);
  });

  it('returns max seq + 1', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(3), { fsyncPolicy: 'never' });
    expect(nextSeq(logPath)).toBe(4);
  });

  it('returns last-line seq + 1 (O(1) tail read, assumes append order)', () => {
    appendEvent(logPath, validEvent(3), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(7), { fsyncPolicy: 'never' });
    expect(nextSeq(logPath)).toBe(8);
  });

  it('skips malformed lines in migrated JSONL and returns correct next seq', () => {
    // Two valid events followed by a truncated (malformed) line in JSONL — migration skips the malformed line.
    const line1 = JSON.stringify(validEvent(1));
    const line2 = JSON.stringify(validEvent(2));
    writeFileSync(logPath, `${line1}\n${line2}\n{"seq":3,"ts":"t","event":"heartbeat"`, 'utf8');
    // Malformed last line is skipped; max imported seq is 2, so nextSeq = 3.
    expect(nextSeq(logPath)).toBe(3);
  });

  it('returns 1 when every line is malformed', () => {
    writeFileSync(logPath, 'not-json\nalso-not-json\n', 'utf8');
    expect(nextSeq(logPath)).toBe(1);
  });

  it('returns 1 for a single-line file that is malformed', () => {
    writeFileSync(logPath, 'not-json', 'utf8');
    expect(nextSeq(logPath)).toBe(1);
  });

  it('returns 1 for a file containing only blank lines', () => {
    writeFileSync(logPath, '\n\n\n', 'utf8');
    expect(nextSeq(logPath)).toBe(1);
  });

  it('returns MAX(seq) + 1 when events have non-contiguous seqs', () => {
    appendEvent(logPath, validEvent(4), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(10), { fsyncPolicy: 'never' });
    expect(nextSeq(logPath)).toBe(11);
  });
});

describe('appendSequencedEvent', () => {
  it('assigns sequential ids', () => {
    appendSequencedEvent(dir, { ...validEvent(undefined), event_id: 'evt-a-heartbeat' }, { fsyncPolicy: 'never' });
    appendSequencedEvent(dir, { ...validEvent(undefined), event_id: 'evt-b-heartbeat' }, { fsyncPolicy: 'never' });
    const events = readEvents(logPath);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('uses nextSeq based on existing log', () => {
    appendEvent(logPath, validEvent(7), { fsyncPolicy: 'never' });
    const seq = appendSequencedEvent(dir, validEvent(undefined), { fsyncPolicy: 'never' });
    expect(seq).toBe(8);
  });

  it('rejects invalid event contracts on append', () => {
    expect(() => appendEvent(logPath, { seq: 1, event: 'heartbeat' } as OrcEvent, { fsyncPolicy: 'never' }))
      .toThrow('event validation failed');
  });

  it('rejects run lifecycle events missing required task/agent fields', () => {
    expect(() => appendEvent(logPath, {
      seq: 1,
      ts: '2026-01-01T00:00:00Z',
      event: 'run_started',
      actor_type: 'agent',
      actor_id: 'agent-01',
      run_id: 'run-abc123',
    } as OrcEvent, { fsyncPolicy: 'never' })).toThrow('event validation failed');
  });

  it('skips invalid events on read and returns remaining valid events', () => {
    writeFileSync(logPath, `${JSON.stringify(validEvent(1))}\n${JSON.stringify({ seq: 2, ts: '2026-01-01T00:00:00Z', event: 'handoff_completed', actor_type: 'agent', actor_id: 'worker-01', task_ref: 'docs/task-1' })}\n`, 'utf8');
    const events = readEvents(logPath);
    expect(events).toHaveLength(1);
    expect(events[0].seq).toBe(1);
  });

  it('supports lock-free appends without using the shared state lock', () => {
    writeFileSync(join(dir, '.lock'), '', 'utf8');
    const seq1 = appendSequencedEvent(dir, validEvent(undefined, 'run_started', { run_id: 'run-1', task_ref: 'orch/task-1' }), {
      fsyncPolicy: 'never',
      lockStrategy: 'none',
    });
    const seq2 = appendSequencedEvent(dir, validEvent(undefined, 'heartbeat', { run_id: 'run-1', task_ref: 'orch/task-1' }), {
      fsyncPolicy: 'never',
      lockStrategy: 'none',
    });

    const events = readEvents(logPath);
    expect([seq1, seq2]).toEqual([1, 2]);
    expect(events).toHaveLength(2);
    expect(events.every((event) => typeof event.event_id === 'string' && event.event_id.length > 0)).toBe(true);
  });

  it('does not rotate archives during lock-free appends (SQLite has no rotation)', () => {
    const lines = Array.from({ length: 10_000 }, (_, idx) => JSON.stringify(validEvent(idx + 1)));
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    const seq = appendSequencedEvent(dir, validEvent(undefined, 'heartbeat', { run_id: 'run-1', task_ref: 'orch/task-1' }), {
      fsyncPolicy: 'never',
      lockStrategy: 'none',
    });

    expect(seq).toBe(10_001);
    // No rotation archives exist — SQLite stores everything in a single DB.
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(readEvents(logPath)).toHaveLength(10_001);
  });
});

describe('rotation', () => {
  it('rotateEventsLogIfNeeded is a no-op returning false (SQLite handles retention implicitly)', () => {
    const rotated = rotateEventsLogIfNeeded(logPath);
    expect(rotated).toBe(false);
  });

  it('rotateEventsLogIfNeeded returns false regardless of event count', () => {
    const lines = Array.from({ length: 10_000 }, (_, idx) => JSON.stringify(validEvent(idx + 1)));
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
    expect(rotateEventsLogIfNeeded(logPath)).toBe(false);
  });

  it('keeps seq monotonic — MAX(seq)+1 is always the next seq regardless of volume', () => {
    const lines = Array.from({ length: 10_000 }, (_, idx) => JSON.stringify(validEvent(idx + 1)));
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    const seq = appendSequencedEvent(dir, validEvent(undefined), { fsyncPolicy: 'never' });
    expect(seq).toBe(10_001);
  });

  it('readRecentEvents returns the correct tail of events from DB', () => {
    const allEvents = Array.from({ length: 60 }, (_, idx) => validEvent(idx + 1));
    for (const event of allEvents) {
      appendEvent(logPath, event, { fsyncPolicy: 'never' });
    }

    const recent = readRecentEvents(logPath, 50);
    expect(recent).toHaveLength(50);
    expect(recent[0].seq).toBe(11);
    expect(recent.at(-1)!.seq).toBe(60);
  });

  it('skips rotation when file is below both thresholds — no-op', () => {
    writeFileSync(logPath, `${JSON.stringify(validEvent(1))}\n`, 'utf8');
    const rotated = rotateEventsLogIfNeeded(logPath);
    expect(rotated).toBe(false);
  });
});

describe('SQLite migration', () => {
  it('stores events in events.db and not events.jsonl on a fresh state dir', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    expect(existsSync(join(dir, 'events.db'))).toBe(true);
    // events.jsonl is not created by the new implementation
    expect(existsSync(logPath)).toBe(false);
  });

  it('migrates existing events.jsonl into events.db on first open', () => {
    // Write a fixture events.jsonl
    const fixtures = [validEvent(1), validEvent(2), validEvent(3)];
    writeFileSync(logPath, fixtures.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    // Trigger getDb via readEvents → runs migration
    const events = readEvents(logPath);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);

    // events.jsonl renamed to events.jsonl.migrated
    expect(existsSync(logPath)).toBe(false);
    expect(existsSync(join(dir, 'events.jsonl.migrated'))).toBe(true);

    // events.db exists
    expect(existsSync(join(dir, 'events.db'))).toBe(true);
  });

  it('does not re-import if events.jsonl.migrated already exists', () => {
    const fixtures = [validEvent(1)];
    writeFileSync(logPath, fixtures.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    writeFileSync(join(dir, 'events.jsonl.migrated'), '', 'utf8');

    // With migrated marker present, migration is skipped
    const events = readEvents(logPath);
    // events.jsonl still exists because migration was skipped
    expect(existsSync(logPath)).toBe(true);
    expect(events).toHaveLength(0);
  });
});

describe('FTS5 search', () => {
  it('queryEvents with fts_query matches events by event type text', () => {
    appendEvent(logPath, validEvent(1, 'run_started', { run_id: 'run-1', task_ref: 'orch/task-1' }), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2, 'heartbeat', { run_id: 'run-1', task_ref: 'orch/task-1' }), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(3, 'run_finished', { run_id: 'run-1', task_ref: 'orch/task-1' }), { fsyncPolicy: 'never' });

    const results = queryEvents(dir, { fts_query: 'run_started' });
    expect(results).toHaveLength(1);
    expect(results[0].seq).toBe(1);
  });

  it('queryEvents filters by run_id', () => {
    appendEvent(logPath, validEvent(1, 'run_started', { run_id: 'run-aaa', task_ref: 'orch/task-1' }), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2, 'run_started', { run_id: 'run-bbb', task_ref: 'orch/task-2' }), { fsyncPolicy: 'never' });

    const results = queryEvents(dir, { run_id: 'run-aaa' });
    expect(results).toHaveLength(1);
    expect(results[0].seq).toBe(1);
  });

  it('queryEvents filters by after_seq', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(2), { fsyncPolicy: 'never' });
    appendEvent(logPath, validEvent(3), { fsyncPolicy: 'never' });

    const results = queryEvents(dir, { after_seq: 1 });
    expect(results.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('queryEvents returns empty array when DB has no events', () => {
    const results = queryEvents(dir, {});
    expect(results).toEqual([]);
  });
});

describe('WAL concurrent reads', () => {
  it('concurrent reads return consistent results (WAL mode)', async () => {
    for (let i = 1; i <= 10; i++) {
      appendEvent(logPath, validEvent(i), { fsyncPolicy: 'never' });
    }

    // Simulate concurrent reads by running multiple in parallel
    const reads = await Promise.all(
      Array.from({ length: 5 }, () => Promise.resolve(readEvents(logPath))),
    );

    for (const events of reads) {
      expect(events).toHaveLength(10);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
  });
});

describe('closeAllDatabases', () => {
  it('closes connections and clears cache so next access re-opens', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    expect(readEvents(logPath)).toHaveLength(1);

    closeAllDatabases();

    // After closing, the next read should re-open the DB and still work
    expect(readEvents(logPath)).toHaveLength(1);
  });

  it('is idempotent — calling twice does not throw', () => {
    appendEvent(logPath, validEvent(1), { fsyncPolicy: 'never' });
    closeAllDatabases();
    closeAllDatabases(); // second call should be a no-op
  });
});
