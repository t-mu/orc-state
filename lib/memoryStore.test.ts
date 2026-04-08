import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  initMemoryDb, closeMemoryDb,
  storeDrawer, getDrawer, deleteDrawer, updateDrawerImportance, listDrawers,
} from './memoryStore.ts';
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

describe('drawer CRUD', () => {
  it('storeDrawer inserts and returns an integer ID', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'hello' });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('storeDrawer defaults wing to general', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'hello' });
    const row = getDrawer(dir, id);
    expect(row?.wing).toBe('general');
  });

  it('storeDrawer sets created_at to a valid ISO timestamp', () => {
    initMemoryDb(dir);
    const before = new Date().toISOString();
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'hello' });
    const after = new Date().toISOString();
    const row = getDrawer(dir, id);
    expect(row?.created_at).toBeDefined();
    const createdAt = row?.created_at ?? '';
    expect(createdAt >= before).toBe(true);
    expect(createdAt <= after).toBe(true);
  });

  it('getDrawer returns null for missing ID', () => {
    initMemoryDb(dir);
    expect(getDrawer(dir, 99999)).toBeNull();
  });

  it('deleteDrawer removes the record and returns true', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'bye' });
    expect(deleteDrawer(dir, id)).toBe(true);
    expect(getDrawer(dir, id)).toBeNull();
  });

  it('deleteDrawer returns false for missing ID', () => {
    initMemoryDb(dir);
    expect(deleteDrawer(dir, 99999)).toBe(false);
  });

  it('updateDrawerImportance updates the importance field', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'x', importance: 3 });
    expect(updateDrawerImportance(dir, id, 9)).toBe(true);
    expect(getDrawer(dir, id)?.importance).toBe(9);
  });

  it('listDrawers filters by wing', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'a' });
    storeDrawer(dir, { wing: 'beta', hall: 'h2', room: 'r2', content: 'b' });
    const rows = listDrawers(dir, { wing: 'alpha' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.wing).toBe('alpha');
  });

  it('listDrawers filters by hall', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { hall: 'hallA', room: 'r1', content: 'a' });
    storeDrawer(dir, { hall: 'hallB', room: 'r2', content: 'b' });
    const rows = listDrawers(dir, { hall: 'hallA' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.hall).toBe('hallA');
  });

  it('listDrawers filters by room', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { hall: 'h1', room: 'roomX', content: 'a' });
    storeDrawer(dir, { hall: 'h1', room: 'roomY', content: 'b' });
    const rows = listDrawers(dir, { room: 'roomX' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.room).toBe('roomX');
  });

  it('listDrawers returns empty array on empty DB', () => {
    initMemoryDb(dir);
    expect(listDrawers(dir)).toEqual([]);
  });

  it('listDrawers respects limit and offset', () => {
    initMemoryDb(dir);
    for (let i = 0; i < 5; i++) {
      storeDrawer(dir, { hall: 'h', room: 'r', content: `item${i}` });
    }
    const page1 = listDrawers(dir, { limit: 2, offset: 0 });
    const page2 = listDrawers(dir, { limit: 2, offset: 2 });
    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });
});
