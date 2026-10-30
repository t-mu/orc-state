import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, readEventBatch, readEventsForRuns } from './eventLog.ts';
import { advanceEventOffset, initializeEventOffset, readEventOffset, resetEventOffset, wasEventOffsetReset } from './eventOffsets.ts';

let dir: string;
beforeEach(() => { dir = createTempStateDir('orch-event-offset-'); seedState(dir); initEventsDb(dir); });
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

function insertEvents(count: number): void {
  const db = new Database(join(dir, 'events.db'));
  try {
    const insert = db.prepare(`INSERT INTO events (seq, event_id, ts, event, agent_id, run_id, task_ref, payload)
      VALUES (?, ?, ?, 'heartbeat', 'worker-1', 'run-1', NULL, ?)`);
    db.transaction(() => {
      for (let seq = 1; seq <= count; seq++) {
        insert.run(seq, `event-${seq}`, '2026-01-01T00:00:00Z', JSON.stringify({
          seq, event_id: `event-${seq}`, ts: '2026-01-01T00:00:00Z',
          event: 'heartbeat', actor_type: 'agent', actor_id: 'worker-1', agent_id: 'worker-1', run_id: 'run-1',
        }));
      }
    })();
  } finally { db.close(); }
}

describe('durable event offsets', () => {
  it('reads physical batches and advances a named cursor with compare-and-set', () => {
    insertEvents(260);
    expect(initializeEventOffset(dir)).toBe(0);
    expect(readEventBatch(join(dir, 'events.db'), 0, 128)).toHaveLength(128);
    expect(readEventBatch(join(dir, 'events.db'), 128, 128)[0].seq).toBe(129);
    expect(advanceEventOffset(dir, 0, 128)).toBe(128);
    expect(readEventOffset(dir)).toBe(128);
    expect(() => advanceEventOffset(dir, 0, 256)).toThrow('concurrently');
    expect(initializeEventOffset(dir, 'notifications')).toBe(0);
    expect(readEventOffset(dir, 'notifications')).toBe(0);
  });

  it('imports only the contiguous processed prefix and keeps the JSON backup', () => {
    insertEvents(3);
    writeFileSync(join(dir, 'event-checkpoint.json'), JSON.stringify({
      version: '1', last_processed_seq: 3,
      processed_event_ids: ['event-1', 'event-3'], updated_at: '2026-01-01T00:00:00Z',
    }));
    expect(initializeEventOffset(dir)).toBe(1);
    expect(readEventBatch(join(dir, 'events.db'), readEventOffset(dir), 128).map((row) => row.seq)).toEqual([2, 3]);
    expect(initializeEventOffset(dir, 'notifications')).toBe(0);
    expect(queryEvents(dir, { fts_query: 'heartbeat' })).toHaveLength(3);
    mkdirSync(join(dir, 'backlog'), { recursive: true });
    const doctor = spawnSync(process.execPath, ['cli/doctor.ts', '--json'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, ORC_STATE_DIR: dir, ORC_REPO_ROOT: dir },
      encoding: 'utf8',
    });
    expect(doctor.status, doctor.stderr || doctor.stdout).toBe(0);
  });

  it('never migrates the cursor beyond events that exist', () => {
    insertEvents(3);
    writeFileSync(join(dir, 'event-checkpoint.json'), JSON.stringify({
      version: '1', last_processed_seq: 99,
      processed_event_ids: ['event-1', 'event-2', 'event-3'], updated_at: '2026-01-01T00:00:00Z',
    }));
    expect(initializeEventOffset(dir)).toBe(3);
  });

  it('keeps corrupt rows visible to the cursor while preserving later events', () => {
    insertEvents(3);
    const db = new Database(join(dir, 'events.db'));
    try { db.prepare('UPDATE events SET payload = ? WHERE seq = 2').run('INVALID'); }
    finally { db.close(); }
    const batch = readEventBatch(join(dir, 'events.db'), 0, 3);
    expect(batch.map((row) => [row.seq, row.event?.event ?? null])).toEqual([
      [1, 'heartbeat'], [2, null], [3, 'heartbeat'],
    ]);
    initializeEventOffset(dir);
    advanceEventOffset(dir, 0, 3);
    resetEventOffset(dir, 2);
    expect(readEventOffset(dir)).toBe(2);
    expect(wasEventOffsetReset(dir)).toBe(true);
    expect(readEventBatch(join(dir, 'events.db'), 2, 3)).toHaveLength(1);
  });

  it('hydrates a bounded set of latest activity and phase events for active runs', () => {
    insertEvents(400);
    const db = new Database(join(dir, 'events.db'));
    try {
      db.prepare("UPDATE events SET event = 'phase_started', task_ref = 'proj/task', payload = json_set(payload, '$.event', 'phase_started', '$.phase', 'review', '$.task_ref', 'proj/task') WHERE seq = 7").run();
      db.prepare("UPDATE events SET event = 'input_requested', payload = json_set(payload, '$.event', 'input_requested', '$.actor_type', 'coordinator') WHERE seq = 399").run();
    } finally { db.close(); }
    const hydrated = readEventsForRuns(join(dir, 'events.db'), ['run-1']);
    expect(hydrated.length).toBeLessThanOrEqual(13);
    expect(hydrated.some((event) => event.event === 'phase_started' && event.phase === 'review')).toBe(true);
    expect(hydrated.some((event) => event.event === 'heartbeat' && event.seq === 400)).toBe(true);
    expect(hydrated.some((event) => event.seq === 399)).toBe(false);
  });
});
