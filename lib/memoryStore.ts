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
