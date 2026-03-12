import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent,
  appendSequencedEvent,
  readEvents,
  readEventsSince,
  readRecentEvents,
  nextSeq,
  rotateEventsLogIfNeeded,
} from './eventLog.mjs';

let dir;
let logPath;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-events-test-'));
  logPath = join(dir, 'events.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function validEvent(seq, event = 'heartbeat', extra = {}) {
  return {
    seq,
    ts: '2026-01-01T00:00:00Z',
    event,
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    agent_id: 'agent-01',
    ...extra,
  };
}

describe('appendEvent', () => {
  it('creates the log file and writes a parseable line', () => {
    const event = {
      seq: 1,
      ts: '2024-01-01T00:00:00Z',
      event: 'claim_created',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-abc123',
      task_ref: 'orch/init',
      agent_id: 'agent-01',
      payload: { lease_expires_at: '2024-01-01T01:00:00Z' },
    };
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
      ts: '2024-06-01T12:00:00Z',
      event: 'heartbeat',
      actor_type: 'agent',
      actor_id: 'agent-01',
      run_id: 'run-abc123',
      task_ref: 'orch/migrate',
      payload: { phase: 'build', pct: 42 },
    };
    appendEvent(logPath, event, { fsyncPolicy: 'never' });
    const [parsed] = readEvents(logPath);
    expect(parsed).toEqual(event);
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

  it('scans back past a malformed last line to return the correct next seq', () => {
    // Two valid events followed by a truncated (malformed) line.
    const line1 = JSON.stringify(validEvent(1));
    const line2 = JSON.stringify(validEvent(2));
    writeFileSync(logPath, `${line1}\n${line2}\n{"seq":3,"ts":"t","event":"heartbeat"`, 'utf8');
    // Must not return 1 (collision); must scan back to seq:2 and return 3.
    expect(nextSeq(logPath)).toBe(3);
  });

  it('scans back past a last line that has no seq field', () => {
    const line1 = JSON.stringify(validEvent(5));
    writeFileSync(logPath, `${line1}\n{"ts":"t","event":"note"}\n`, 'utf8');
    expect(nextSeq(logPath)).toBe(6);
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

  it('scans back past a last line whose seq is a string (non-number)', () => {
    const line1 = JSON.stringify(validEvent(4));
    writeFileSync(logPath, `${line1}\n{"seq":"5","ts":"t"}\n`, 'utf8');
    expect(nextSeq(logPath)).toBe(5);
  });
});

describe('appendSequencedEvent', () => {
  it('assigns sequential ids', () => {
    appendSequencedEvent(dir, validEvent(undefined), { fsyncPolicy: 'never' });
    appendSequencedEvent(dir, validEvent(undefined), { fsyncPolicy: 'never' });
    const events = readEvents(logPath);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('uses nextSeq based on existing log', () => {
    appendEvent(logPath, validEvent(7), { fsyncPolicy: 'never' });
    const seq = appendSequencedEvent(dir, validEvent(undefined), { fsyncPolicy: 'never' });
    expect(seq).toBe(8);
  });

  it('rejects invalid event contracts on append', () => {
    expect(() => appendEvent(logPath, { seq: 1, event: 'heartbeat' }, { fsyncPolicy: 'never' }))
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
    }, { fsyncPolicy: 'never' })).toThrow('event validation failed');
  });

  it('rejects invalid event contracts on read', () => {
    writeFileSync(logPath, `${JSON.stringify(validEvent(1))}\n${JSON.stringify({ seq: 2, ts: '2026-01-01T00:00:00Z', event: 'handoff_completed', actor_type: 'agent', actor_id: 'worker-01', task_ref: 'docs/task-1' })}\n`, 'utf8');
    expect(() => readEvents(logPath)).toThrow('events.jsonl schema error at line 2');
  });
});

describe('rotation', () => {
  it('renames events.jsonl to events.jsonl.1 when line count threshold is reached', () => {
    const lines = Array.from({ length: 10_000 }, (_, idx) => JSON.stringify(validEvent(idx + 1)));
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');

    const rotated = rotateEventsLogIfNeeded(logPath);
    expect(rotated).toBe(true);
    expect(readEvents(`${logPath}.1`)).toHaveLength(10_000);
    expect(readEvents(logPath)).toHaveLength(0);
  });

  it('drops .2 and shifts .1 to .2 on second rotation', () => {
    const old1 = [JSON.stringify(validEvent(1))].join('\n');
    const old2 = [JSON.stringify(validEvent(2))].join('\n');
    const current = Array.from({ length: 10_000 }, (_, idx) => JSON.stringify(validEvent(idx + 3))).join('\n');
    writeFileSync(`${logPath}.1`, `${old1}\n`, 'utf8');
    writeFileSync(`${logPath}.2`, `${old2}\n`, 'utf8');
    writeFileSync(logPath, `${current}\n`, 'utf8');

    const rotated = rotateEventsLogIfNeeded(logPath);
    expect(rotated).toBe(true);

    const newArchive2 = readEvents(`${logPath}.2`);
    const newArchive1 = readEvents(`${logPath}.1`);
    expect(newArchive2).toHaveLength(1);
    expect(newArchive2[0].seq).toBe(1);
    expect(newArchive1).toHaveLength(10_000);
    expect(newArchive1[0].seq).toBe(3);
    expect(readEvents(logPath)).toHaveLength(0);
  });

  it('keeps seq monotonic after rotation', () => {
    const lines = Array.from({ length: 10_000 }, (_, idx) => JSON.stringify(validEvent(idx + 1)));
    writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
    rotateEventsLogIfNeeded(logPath);

    const seq = appendSequencedEvent(dir, validEvent(undefined), { fsyncPolicy: 'never' });
    expect(seq).toBe(10_001);
  });

  it('returns recent events spanning rotation boundary', () => {
    const archiveEvents = Array.from({ length: 40 }, (_, idx) => JSON.stringify(validEvent(idx + 1)));
    const currentEvents = Array.from({ length: 20 }, (_, idx) => JSON.stringify(validEvent(idx + 41)));
    writeFileSync(`${logPath}.1`, `${archiveEvents.join('\n')}\n`, 'utf8');
    writeFileSync(logPath, `${currentEvents.join('\n')}\n`, 'utf8');

    const recent = readRecentEvents(logPath, 50);
    expect(recent).toHaveLength(50);
    expect(recent[0].seq).toBe(11);
    expect(recent.at(-1).seq).toBe(60);
  });

  it('skips rotation when file is below both thresholds', () => {
    writeFileSync(logPath, `${JSON.stringify(validEvent(1))}\n`, 'utf8');
    const rotated = rotateEventsLogIfNeeded(logPath);
    expect(rotated).toBe(false);
    expect(readEvents(`${logPath}.1`)).toEqual([]);
  });
});
