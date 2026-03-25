import { existsSync, readFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { validateEventObject } from './eventValidation.ts';
import type { OrcEvent, OrcEventInput } from '../types/events.ts';

// Module-level singleton: one DB connection per stateDir.
const _dbs = new Map<string, Database.Database>();

function getDb(stateDir: string): Database.Database {
  const existing = _dbs.get(stateDir);
  if (existing) return existing;

  const dbPath = join(stateDir, 'events.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id  TEXT    NOT NULL UNIQUE,
      ts        TEXT    NOT NULL,
      event     TEXT    NOT NULL,
      agent_id  TEXT,
      run_id    TEXT,
      task_ref  TEXT,
      payload   TEXT    NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      event, agent_id, run_id, task_ref, payload,
      content='events', content_rowid='seq'
    );
    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, event, agent_id, run_id, task_ref, payload)
      VALUES (new.seq, new.event, new.agent_id, new.run_id, new.task_ref, new.payload);
    END;
  `);

  migrateJsonlIfNeeded(db, stateDir);
  _dbs.set(stateDir, db);
  return db;
}

function migrateJsonlIfNeeded(db: Database.Database, stateDir: string): void {
  const jsonlPath = join(stateDir, 'events.jsonl');
  const migratedPath = join(stateDir, 'events.jsonl.migrated');
  if (!existsSync(jsonlPath) || existsSync(migratedPath)) return;

  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (seq, event_id, ts, event, agent_id, run_id, task_ref, payload)
    VALUES (@seq, @event_id, @ts, @event, @agent_id, @run_id, @task_ref, @payload)
  `);

  const migrate = db.transaction(() => {
    let nextSeq = 1;
    for (const line of lines) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const eventId = typeof ev.event_id === 'string' ? ev.event_id : randomUUID();
      const seq = typeof ev.seq === 'number' ? ev.seq : nextSeq;
      nextSeq = Math.max(nextSeq, seq) + 1;
      // Store augmented payload so all required fields (event_id, seq) are present when read back.
      const needsAugment = typeof ev.event_id !== 'string' || typeof ev.seq !== 'number';
      const payload = needsAugment ? JSON.stringify({ ...ev, event_id: eventId, seq }) : line;
      insert.run({
        seq,
        event_id: eventId,
        ts: typeof ev.ts === 'string' ? ev.ts : new Date().toISOString(),
        event: typeof ev.event === 'string' ? ev.event : 'unknown',
        agent_id: typeof ev.agent_id === 'string' ? ev.agent_id : null,
        run_id: typeof ev.run_id === 'string' ? ev.run_id : null,
        task_ref: typeof ev.task_ref === 'string' ? ev.task_ref : null,
        payload,
      });
    }
  });
  migrate();
  renameSync(jsonlPath, migratedPath);
}

/**
 * Explicitly initialize the events SQLite DB for a state directory.
 * Used during `orc init` to create events.db before first event is appended.
 */
export function initEventsDb(stateDir: string): void {
  getDb(stateDir);
}

export function ensureEventIdentity<T extends { event_id?: string }>(
  event: T,
  { createIfMissing = true }: { createIfMissing?: boolean } = {},
): T {
  if (typeof event.event_id === 'string' && event.event_id.length > 0) {
    return event;
  }
  if (!createIfMissing) {
    return event;
  }
  return {
    ...event,
    event_id: randomUUID(),
  };
}

export function eventIdentity(event: {
  event_id?: unknown;
  seq?: unknown;
  ts?: unknown;
  event?: unknown;
  run_id?: unknown;
  task_ref?: unknown;
  agent_id?: unknown;
}): string {
  if (typeof event.event_id === 'string' && event.event_id.length > 0) {
    return event.event_id;
  }

  const parts = [
    typeof event.seq === 'number' ? `seq:${event.seq}` : 'seq:missing',
    typeof event.ts === 'string' ? `ts:${event.ts}` : 'ts:missing',
    typeof event.event === 'string' ? `event:${event.event}` : 'event:missing',
    typeof event.run_id === 'string' ? `run:${event.run_id}` : 'run:missing',
    typeof event.task_ref === 'string' ? `task:${event.task_ref}` : 'task:missing',
    typeof event.agent_id === 'string' ? `agent:${event.agent_id}` : 'agent:missing',
  ];
  return `legacy:${parts.join('|')}`;
}

/**
 * No-op: rotation is no longer needed with SQLite storage.
 * Kept for API compatibility.
 */
export function rotateEventsLogIfNeeded(
  _logPath: string,
  _opts?: { maxLines?: number; maxBytes?: number },
): boolean {
  return false;
}

/**
 * Append one event to the SQLite events table.
 *
 * fsyncPolicy is accepted for API compatibility but SQLite WAL provides
 * durability guarantees without manual fsync.
 */
export function appendEvent(logPath: string, event: OrcEvent, { fsyncPolicy: _fsyncPolicy = 'always' } = {}): void {
  const stateDir = dirname(logPath);
  const db = getDb(stateDir);

  const normalizedEvent = ensureEventIdentity(event);
  const errors = validateEventObject(normalizedEvent);
  if (errors.length > 0) {
    throw new Error(`event validation failed: ${errors.join('; ')}`);
  }

  const payload = JSON.stringify(normalizedEvent);
  const ev = normalizedEvent as unknown as Record<string, unknown>;

  const hasSeq = typeof normalizedEvent.seq === 'number';

  if (hasSeq) {
    db.prepare(`
      INSERT INTO events (seq, event_id, ts, event, agent_id, run_id, task_ref, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedEvent.seq,
      normalizedEvent.event_id ?? null,
      normalizedEvent.ts,
      normalizedEvent.event,
      ev.agent_id ?? null,
      ev.run_id ?? null,
      ev.task_ref ?? null,
      payload,
    );
  } else {
    db.prepare(`
      INSERT INTO events (event_id, ts, event, agent_id, run_id, task_ref, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedEvent.event_id ?? null,
      normalizedEvent.ts,
      normalizedEvent.event,
      ev.agent_id ?? null,
      ev.run_id ?? null,
      ev.task_ref ?? null,
      payload,
    );
  }
}

/**
 * Append an event with a DB-assigned monotonic seq.
 * lockAlreadyHeld and lockStrategy are accepted for API compatibility;
 * SQLite handles atomicity internally.
 */
export function appendSequencedEvent(
  stateDir: string,
  event: OrcEventInput,
  {
    fsyncPolicy: _fsyncPolicy = 'always',
    lockAlreadyHeld: _lockAlreadyHeld = false,
    lockStrategy: _lockStrategy = 'state',
  }: {
    fsyncPolicy?: 'always' | 'never';
    lockAlreadyHeld?: boolean;
    lockStrategy?: 'state' | 'none';
  } = {},
): number {
  const db = getDb(stateDir);

  // Assign seq first so validation can check all required fields including seq.
  const maxRow = db.prepare(`SELECT MAX(seq) as max_seq FROM events`).get() as { max_seq: number | null };
  const seq = (maxRow.max_seq ?? 0) + 1;

  const withSeq = ensureEventIdentity({ ...event, seq } as OrcEvent);
  const errors = validateEventObject(withSeq);
  if (errors.length > 0) {
    throw new Error(`event validation failed: ${errors.join('; ')}`);
  }

  const ev = withSeq as unknown as Record<string, unknown>;
  const payload = JSON.stringify(withSeq);

  db.prepare(`
    INSERT INTO events (seq, event_id, ts, event, agent_id, run_id, task_ref, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    seq,
    withSeq.event_id ?? null,
    withSeq.ts,
    withSeq.event,
    ev.agent_id ?? null,
    ev.run_id ?? null,
    ev.task_ref ?? null,
    payload,
  );

  return seq;
}

/**
 * Read and parse all events from the SQLite events DB.
 * Returns an empty array if no events exist.
 */
export function readEvents(logPath: string): OrcEvent[] {
  const stateDir = dirname(logPath);
  const db = getDb(stateDir);
  const rows = db.prepare(`SELECT payload FROM events ORDER BY seq`).all() as Array<{ payload: string }>;
  const events: OrcEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const event = ensureEventIdentity(JSON.parse(row.payload) as OrcEvent, { createIfMissing: false });
      const validationErrors = validateEventObject(event);
      if (validationErrors.length > 0) {
        throw new Error(`events.jsonl schema error at line ${i + 1}: ${validationErrors.join('; ')}`);
      }
      events.push(event);
    } catch (error) {
      if (String((error as Error).message ?? '').startsWith('events.jsonl schema error at line')) {
        throw error;
      }
      throw new Error(`events.jsonl parse error at line ${i + 1}: ${(error as Error).message}`);
    }
  }
  return events;
}

/**
 * Read events with seq strictly greater than afterSeq.
 * Returns an empty array if no events exist.
 */
export function readEventsSince(logPath: string, afterSeq: number): OrcEvent[] {
  const stateDir = dirname(logPath);
  const db = getDb(stateDir);
  const rows = db.prepare(`SELECT payload FROM events WHERE seq > ? ORDER BY seq`).all(afterSeq) as Array<{ payload: string }>;
  const events: OrcEvent[] = [];
  for (const row of rows) {
    try {
      const event = ensureEventIdentity(JSON.parse(row.payload) as OrcEvent, { createIfMissing: false });
      events.push(event);
    } catch {
      // Skip malformed payloads
    }
  }
  return events;
}

/**
 * Return recent events from the SQLite DB (newest last).
 */
export function readRecentEvents(logPath: string, limit = 50): OrcEvent[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error('limit must be a non-negative integer');
  }
  if (limit === 0) return [];

  const stateDir = dirname(logPath);
  const db = getDb(stateDir);
  const cap = Math.min(limit, 200);
  const rows = db.prepare(`SELECT payload FROM events ORDER BY seq DESC LIMIT ?`).all(cap) as Array<{ payload: string }>;

  return rows
    .reverse()
    .map((row) => {
      const event = JSON.parse(row.payload) as OrcEvent;
      return ensureEventIdentity(event, { createIfMissing: false });
    });
}

/**
 * Return the next sequence number to use when appending an event.
 * Returns 1 for an empty DB.
 */
export function nextSeq(logPath: string): number {
  const stateDir = dirname(logPath);
  const db = getDb(stateDir);
  const row = db.prepare(`SELECT MAX(seq) as max_seq FROM events`).get() as { max_seq: number | null };
  if (row.max_seq == null) return 1;
  return row.max_seq + 1;
}

/**
 * Query events with SQL filters. Used by the query_events MCP tool.
 */
export function queryEvents(
  stateDir: string,
  {
    run_id,
    agent_id,
    event_type,
    after_seq,
    limit = 50,
    fts_query,
    order = 'asc',
  }: {
    run_id?: string;
    agent_id?: string;
    event_type?: string;
    after_seq?: number;
    limit?: number;
    fts_query?: string;
    order?: 'asc' | 'desc';
  } = {},
): OrcEvent[] {
  const db = getDb(stateDir);
  const cap = Math.min(Number.isInteger(limit) ? limit : 50, 500);

  if (fts_query) {
    const params: unknown[] = [fts_query];
    const conditions: string[] = ['events_fts MATCH ?'];
    if (run_id != null) { conditions.push('e.run_id = ?'); params.push(run_id); }
    if (agent_id != null) { conditions.push('e.agent_id = ?'); params.push(agent_id); }
    if (event_type != null) { conditions.push('e.event = ?'); params.push(event_type); }
    if (after_seq != null) { conditions.push('e.seq > ?'); params.push(after_seq); }
    params.push(cap);

    const rows = db.prepare(`
      SELECT e.payload FROM events e
      JOIN events_fts ON events_fts.rowid = e.seq
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.seq
      LIMIT ?
    `).all(...params) as Array<{ payload: string }>;

    return rows.map((row) => JSON.parse(row.payload) as OrcEvent);
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (run_id != null) { conditions.push('run_id = ?'); params.push(run_id); }
  if (agent_id != null) { conditions.push('agent_id = ?'); params.push(agent_id); }
  if (event_type != null) { conditions.push('event = ?'); params.push(event_type); }
  if (after_seq != null) { conditions.push('seq > ?'); params.push(after_seq); }
  params.push(cap);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderDir = order === 'desc' ? 'DESC' : 'ASC';
  const rows = db.prepare(`SELECT payload FROM events ${where} ORDER BY seq ${orderDir} LIMIT ?`).all(...params) as Array<{ payload: string }>;

  return rows.map((row) => JSON.parse(row.payload) as OrcEvent);
}
