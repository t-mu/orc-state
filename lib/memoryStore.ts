import Database from 'better-sqlite3';
import { join } from 'node:path';
import { registerDb, unregisterDb } from './eventLog.ts';

const MEMORY_DB_FILE = 'memory.db';
let _memDb: Database.Database | null = null;

export function initMemoryDb(stateDir: string): Database.Database {
  if (_memDb) return _memDb;
  const dbPath = join(stateDir, MEMORY_DB_FILE);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    CREATE TABLE IF NOT EXISTS drawers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wing TEXT NOT NULL,
      hall TEXT NOT NULL,
      room TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT,
      importance INTEGER NOT NULL DEFAULT 5,
      source_type TEXT,
      source_ref TEXT,
      agent_id TEXT,
      tags TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS drawers_fts USING fts5(
      content, tags, wing, hall, room,
      content='drawers', content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS drawers_ai AFTER INSERT ON drawers BEGIN
      INSERT INTO drawers_fts(rowid, content, tags, wing, hall, room)
      VALUES (new.id, new.content, new.tags, new.wing, new.hall, new.room);
    END;

    CREATE TRIGGER IF NOT EXISTS drawers_ad AFTER DELETE ON drawers BEGIN
      INSERT INTO drawers_fts(drawers_fts, rowid, content, tags, wing, hall, room)
      VALUES ('delete', old.id, old.content, old.tags, old.wing, old.hall, old.room);
    END;

    -- No UPDATE trigger: no current task updates FTS-indexed columns (content, tags,
    -- wing, hall, room). Task 129 only updates importance (non-FTS field). If a future
    -- task adds content/tag updates, an UPDATE trigger must be added at that time.
  `);

  registerDb('memory', db);
  _memDb = db;
  return db;
}

export function getMemoryDb(stateDir: string): Database.Database {
  return _memDb ?? initMemoryDb(stateDir);
}

export function closeMemoryDb(): void {
  if (_memDb) {
    unregisterDb('memory');
    _memDb.close();
    _memDb = null;
  }
}

export interface DrawerInput {
  wing?: string;
  hall: string;
  room: string;
  content: string;
  importance?: number;
  sourceType?: string;
  sourceRef?: string;
  agentId?: string;
  tags?: string;
  expiresAt?: string;
}

export interface Drawer {
  id: number;
  wing: string;
  hall: string;
  room: string;
  content: string;
  content_hash: string | null;
  importance: number;
  source_type: string | null;
  source_ref: string | null;
  agent_id: string | null;
  tags: string | null;
  created_at: string;
  expires_at: string | null;
}

export function storeDrawer(stateDir: string, input: DrawerInput): number {
  const db = getMemoryDb(stateDir);
  const result = db.prepare(`
    INSERT INTO drawers (wing, hall, room, content, importance, source_type, source_ref, agent_id, tags, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.wing ?? 'general', input.hall, input.room, input.content,
    input.importance ?? 5, input.sourceType ?? null, input.sourceRef ?? null,
    input.agentId ?? null, input.tags ?? null, new Date().toISOString(),
    input.expiresAt ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getDrawer(stateDir: string, id: number): Drawer | null {
  const db = getMemoryDb(stateDir);
  const row = db.prepare('SELECT * FROM drawers WHERE id = ?').get(id) as Drawer | undefined;
  return row ?? null;
}

export function deleteDrawer(stateDir: string, id: number): boolean {
  const db = getMemoryDb(stateDir);
  const result = db.prepare('DELETE FROM drawers WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateDrawerImportance(stateDir: string, id: number, importance: number): boolean {
  const db = getMemoryDb(stateDir);
  const result = db.prepare('UPDATE drawers SET importance = ? WHERE id = ?').run(importance, id);
  return result.changes > 0;
}

export function listDrawers(stateDir: string, opts: {
  wing?: string;
  hall?: string;
  room?: string;
  limit?: number;
  offset?: number;
} = {}): Drawer[] {
  const db = getMemoryDb(stateDir);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts.wing !== undefined) { conditions.push('wing = ?'); params.push(opts.wing); }
  if (opts.hall !== undefined) { conditions.push('hall = ?'); params.push(opts.hall); }
  if (opts.room !== undefined) { conditions.push('room = ?'); params.push(opts.room); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit !== undefined ? `LIMIT ${opts.limit}` : '';
  const offset = opts.offset !== undefined ? `OFFSET ${opts.offset}` : '';

  return db.prepare(`SELECT * FROM drawers ${where} ${limit} ${offset}`.trim()).all(...params) as Drawer[];
}
