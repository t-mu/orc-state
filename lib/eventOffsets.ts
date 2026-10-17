import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEventCheckpoint } from './eventCheckpoint.ts';
import { withEventDb, withEventDbTransaction } from './eventLog.ts';

export const COORDINATOR_EVENT_CONSUMER = 'coordinator';

function assertSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Event offset must be a non-negative safe integer');
}

/**
 * Import the longest processed prefix from the legacy checkpoint. A processed
 * event after a gap cannot advance the cursor past that still-pending event.
 * The JSON file is deliberately retained for recovery and migration replay.
 */
export function initializeEventOffset(stateDir: string, consumerId = COORDINATOR_EVENT_CONSUMER): number {
  if (!consumerId) throw new Error('Consumer ID is required');
  const already = withEventDb(stateDir, (db) => db.prepare('SELECT last_event_seq FROM offsets WHERE consumer_id = ?')
    .get(consumerId) as { last_event_seq: number } | undefined);
  if (already) return already.last_event_seq;
  const hasLegacy = consumerId === COORDINATOR_EVENT_CONSUMER && existsSync(join(stateDir, 'event-checkpoint.json'));
  const legacy = hasLegacy ? readEventCheckpoint(stateDir) : null;
  return withEventDbTransaction(stateDir, (db) => {
    const existing = db.prepare('SELECT last_event_seq FROM offsets WHERE consumer_id = ?')
      .get(consumerId) as { last_event_seq: number } | undefined;
    if (existing) return existing.last_event_seq;
    let cursor = 0;
    if (legacy) {
      const processed = new Set(legacy.processed_event_ids);
      const rows = db.prepare('SELECT seq, event_id FROM events WHERE seq <= ? ORDER BY seq')
        .all(legacy.last_processed_seq) as Array<{ seq: number; event_id: string }>;
      for (const row of rows) {
        if (!processed.has(row.event_id) && !processed.has(`legacy:seq:${row.seq}`)) {
          break;
        }
        cursor = row.seq;
      }
    }
    db.prepare('INSERT INTO offsets (consumer_id, last_event_seq, updated_at) VALUES (?, ?, ?)')
      .run(consumerId, cursor, new Date().toISOString());
    return cursor;
  });
}

export function readEventOffset(stateDir: string, consumerId = COORDINATOR_EVENT_CONSUMER): number {
  return withEventDb(stateDir, (db) => {
    const row = db.prepare('SELECT last_event_seq FROM offsets WHERE consumer_id = ?')
      .get(consumerId) as { last_event_seq: number } | undefined;
    return row?.last_event_seq ?? 0;
  });
}

/** Compare-and-set prevents two consumers using the same name from racing. */
export function advanceEventOffset(stateDir: string, expectedSeq: number, nextSeq: number, consumerId = COORDINATOR_EVENT_CONSUMER): number {
  assertSeq(expectedSeq);
  assertSeq(nextSeq);
  if (nextSeq < expectedSeq) throw new Error('Event offset cannot move backwards');
  return withEventDbTransaction(stateDir, (db) => {
    const result = db.prepare(`UPDATE offsets SET last_event_seq = ?, updated_at = ?
      WHERE consumer_id = ? AND last_event_seq = ?`)
      .run(nextSeq, new Date().toISOString(), consumerId, expectedSeq);
    if (result.changes !== 1) throw new Error('Event offset changed concurrently or was not initialized');
    return nextSeq;
  });
}

/** Recovery only: the operator may deliberately replay from an earlier seq. */
export function resetEventOffset(stateDir: string, seq: number, consumerId = COORDINATOR_EVENT_CONSUMER): void {
  assertSeq(seq);
  withEventDbTransaction(stateDir, (db) => {
    const current = db.prepare('SELECT last_event_seq FROM offsets WHERE consumer_id = ?')
      .get(consumerId) as { last_event_seq: number } | undefined;
    if (!current) throw new Error('Event offset is not initialized');
    if (seq > current.last_event_seq) throw new Error('Recovery reset cannot skip pending events');
    db.prepare('UPDATE offsets SET last_event_seq = ?, updated_at = ? WHERE consumer_id = ?')
      .run(seq, new Date().toISOString(), consumerId);
    db.prepare('INSERT OR IGNORE INTO runtime_cutovers (name, imported_at) VALUES (?, ?)')
      .run(`event_cursor_reset:${consumerId}`, new Date().toISOString());
  });
}

/** An explicit reset overrides legacy checkpoint deduplication. */
export function wasEventOffsetReset(stateDir: string, consumerId = COORDINATOR_EVENT_CONSUMER): boolean {
  return withEventDb(stateDir, (db) => Boolean(db.prepare('SELECT 1 FROM runtime_cutovers WHERE name = ?')
    .get(`event_cursor_reset:${consumerId}`)));
}
