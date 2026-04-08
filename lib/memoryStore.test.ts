import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { initMemoryDb, closeMemoryDb } from './memoryStore.ts';
import { closeAllDatabases } from './eventLog.ts';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-memory-test-');
});

afterEach(() => {
  closeMemoryDb();
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('initMemoryDb', () => {
  it('creates memory.db with drawers table and FTS5 index', () => {
    initMemoryDb(dir);
    expect(existsSync(join(dir, 'memory.db'))).toBe(true);

    const db = initMemoryDb(dir);
    // Verify drawers table exists by inserting and querying a row
    db.prepare(`
      INSERT INTO drawers (wing, hall, room, content, created_at)
      VALUES ('w', 'h', 'r', 'hello', '2026-01-01T00:00:00Z')
    `).run();
    const row = db.prepare('SELECT content FROM drawers WHERE wing = ?').get('w') as { content: string } | undefined;
    expect(row?.content).toBe('hello');

    // Verify FTS5 virtual table exists by running a basic FTS query
    const ftsRows = db.prepare("SELECT rowid FROM drawers_fts WHERE drawers_fts MATCH 'hello'").all() as { rowid: number }[];
    expect(ftsRows.length).toBe(1);
  });

  it('is idempotent — calling initMemoryDb twice does not error', () => {
    const db1 = initMemoryDb(dir);
    const db2 = initMemoryDb(dir);
    expect(db1).toBe(db2);

    // Second call also idempotent at schema level (CREATE TABLE IF NOT EXISTS)
    expect(() => initMemoryDb(dir)).not.toThrow();
  });

  it('uses WAL journal mode', () => {
    const db = initMemoryDb(dir);
    const row = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(row[0]?.journal_mode).toBe('wal');
  });

  it('registers with closeAllDatabases via registerDb', () => {
    initMemoryDb(dir);
    // closeAllDatabases should close the memory DB without error
    expect(() => closeAllDatabases()).not.toThrow();
    // After closeAllDatabases, the module singleton must be cleared or the db closed
    // We can verify by checking that closeMemoryDb is now a no-op (already closed)
    expect(() => closeMemoryDb()).not.toThrow();
  });
});
