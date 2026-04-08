import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  initMemoryDb, getMemoryDb, closeMemoryDb,
  storeDrawer, getDrawer, deleteDrawer, updateDrawerImportance, listDrawers,
  searchMemory,
  extractKeywords,
  listWings, listRooms, getMemoryStats,
  memoryWakeUp,
  wingFromTaskRef,
  pruneExpiredMemories, pruneByCapacity,
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

describe('importance validation', () => {
  it('storeDrawer clamps importance > 10 to 10', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'over-limit importance', importance: 15 });
    expect(getDrawer(dir, id)?.importance).toBe(10);
  });

  it('storeDrawer clamps negative importance to 1', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'negative importance', importance: -3 });
    expect(getDrawer(dir, id)?.importance).toBe(1);
  });

  it('storeDrawer defaults NaN importance to 5', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'nan importance', importance: NaN });
    expect(getDrawer(dir, id)?.importance).toBe(5);
  });

  it('storeDrawer defaults Infinity importance to 5', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'infinity importance', importance: Infinity });
    expect(getDrawer(dir, id)?.importance).toBe(5);
  });

  it('storeDrawer rounds fractional importance', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'fractional importance', importance: 7.6 });
    expect(getDrawer(dir, id)?.importance).toBe(8);
  });

  it('updateDrawerImportance clamps value > 10 to 10', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'clamp update high', importance: 5 });
    expect(updateDrawerImportance(dir, id, 20)).toBe(true);
    expect(getDrawer(dir, id)?.importance).toBe(10);
  });

  it('updateDrawerImportance clamps negative value to 1', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'clamp update low', importance: 5 });
    expect(updateDrawerImportance(dir, id, -5)).toBe(true);
    expect(getDrawer(dir, id)?.importance).toBe(1);
  });
});

describe('duplicate detection and keyword tagging', () => {
  it('populates content_hash on insert', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'hello world' });
    const row = getDrawer(dir, id);
    expect(row?.content_hash).toBeTruthy();
    expect(typeof row?.content_hash).toBe('string');
    expect(row?.content_hash).toHaveLength(64); // SHA-256 hex
  });

  it('returns existing ID for duplicate content', () => {
    initMemoryDb(dir);
    const id1 = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'duplicate content' });
    const id2 = storeDrawer(dir, { hall: 'h2', room: 'r2', content: 'duplicate content' });
    expect(id1).toBe(id2);
    expect(listDrawers(dir).length).toBe(1);
  });

  it('stores different content as separate drawers', () => {
    initMemoryDb(dir);
    const id1 = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'content alpha' });
    const id2 = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'content beta' });
    expect(id1).not.toBe(id2);
    expect(listDrawers(dir).length).toBe(2);
  });

  it('auto-extracts keywords when tags not provided', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'javascript typescript programming language' });
    const row = getDrawer(dir, id);
    expect(row?.tags).toBeTruthy();
    expect(row?.tags).toContain('javascript');
    expect(row?.tags).toContain('typescript');
  });

  it('preserves explicit tags without overwriting', () => {
    initMemoryDb(dir);
    const id = storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'some content here', tags: 'mytag,custom' });
    const row = getDrawer(dir, id);
    expect(row?.tags).toBe('mytag,custom');
  });

  it('filters stopwords from extracted keywords', () => {
    initMemoryDb(dir);
    const keywords = extractKeywords('the quick brown fox and the lazy dog');
    const parts = keywords.split(',');
    expect(parts).not.toContain('the');
    expect(parts).not.toContain('and');
    expect(parts).toContain('quick');
    expect(parts).toContain('brown');
    expect(parts).toContain('lazy');
  });
});

describe('searchMemory', () => {
  it('searchMemory finds drawers by FTS5 text match', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'typescript programming language' });
    storeDrawer(dir, { hall: 'h1', room: 'r2', content: 'python programming language' });
    const results = searchMemory(dir, { query: 'typescript' });
    expect(results.length).toBe(1);
    expect(results[0]?.snippet).toContain('typescript');
  });

  it('searchMemory filters by wing when provided', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'shared keyword content' });
    storeDrawer(dir, { wing: 'beta', hall: 'h1', room: 'r1', content: 'shared keyword content beta' });
    const results = searchMemory(dir, { query: 'shared', wing: 'alpha' });
    expect(results.length).toBe(1);
    expect(results[0]?.wing).toBe('alpha');
  });

  it('searchMemory returns empty array for no matches', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'some content here' });
    const results = searchMemory(dir, { query: 'xyznonexistent' });
    expect(results).toEqual([]);
  });

  it('searchMemory ranks higher-importance drawers above lower', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { hall: 'h1', room: 'r1', content: 'orchestration workflow system', importance: 2 });
    storeDrawer(dir, { hall: 'h1', room: 'r2', content: 'orchestration pipeline system', importance: 8 });
    const results = searchMemory(dir, { query: 'orchestration' });
    expect(results.length).toBe(2);
    expect(results[0]?.importance).toBe(8);
    expect(results[1]?.importance).toBe(2);
  });

  it('searchMemory respects limit parameter', () => {
    initMemoryDb(dir);
    for (let i = 0; i < 5; i++) {
      storeDrawer(dir, { hall: 'h1', room: `r${i}`, content: `searchable item number ${i}` });
    }
    const results = searchMemory(dir, { query: 'searchable', limit: 3 });
    expect(results.length).toBe(3);
  });

  it('searchMemory returns snippets capped at 200 chars', () => {
    initMemoryDb(dir);
    const longContent = 'keyword ' + 'x'.repeat(300);
    storeDrawer(dir, { hall: 'h1', room: 'r1', content: longContent });
    const results = searchMemory(dir, { query: 'keyword' });
    expect(results.length).toBe(1);
    expect(results[0]?.snippet.length).toBeLessThanOrEqual(200);
  });

  it('searchMemory returns empty array when the database has no drawers', () => {
    initMemoryDb(dir);
    const results = searchMemory(dir, { query: 'anything' });
    expect(results).toEqual([]);
  });
});

describe('spatial taxonomy queries', () => {
  it('listWings returns distinct wings with counts', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'alpha one' });
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r2', content: 'alpha two' });
    storeDrawer(dir, { wing: 'beta', hall: 'h2', room: 'r1', content: 'beta one' });
    const wings = listWings(dir);
    expect(wings.length).toBe(2);
    const alpha = wings.find(w => w.wing === 'alpha');
    const beta = wings.find(w => w.wing === 'beta');
    expect(alpha?.count).toBe(2);
    expect(beta?.count).toBe(1);
    // ordered by count desc
    expect(wings[0]?.wing).toBe('alpha');
  });

  it('listWings returns empty array on empty DB', () => {
    initMemoryDb(dir);
    expect(listWings(dir)).toEqual([]);
  });

  it('listRooms filters by wing', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'alpha r1 entry one' });
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'alpha r1 entry two' });
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r2', content: 'alpha r2 entry' });
    storeDrawer(dir, { wing: 'beta', hall: 'h2', room: 'r1', content: 'beta r1 entry' });
    const rooms = listRooms(dir, 'alpha');
    expect(rooms.length).toBe(2);
    const r1 = rooms.find(r => r.room === 'r1');
    expect(r1?.count).toBe(2);
    expect(r1?.hall).toBe('h1');
  });

  it('listRooms returns empty array for nonexistent wing', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'something here' });
    expect(listRooms(dir, 'nonexistent')).toEqual([]);
  });

  it('getMemoryStats returns correct aggregates', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'first entry' });
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r2', content: 'second entry' });
    storeDrawer(dir, { wing: 'beta', hall: 'h2', room: 'r1', content: 'third entry' });
    const stats = getMemoryStats(dir);
    expect(stats.totalDrawers).toBe(3);
    expect(stats.distinctWings).toBe(2);
    expect(stats.distinctRooms).toBe(3);
    expect(stats.oldestMemory).toBeTruthy();
    expect(stats.newestMemory).toBeTruthy();
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  it('getMemoryStats returns zeroes and nulls on empty DB', () => {
    initMemoryDb(dir);
    const stats = getMemoryStats(dir);
    expect(stats.totalDrawers).toBe(0);
    expect(stats.distinctWings).toBe(0);
    expect(stats.distinctRooms).toBe(0);
    expect(stats.oldestMemory).toBeNull();
    expect(stats.newestMemory).toBeNull();
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });
});

describe('memoryWakeUp', () => {
  it('returns formatted text with wing/room headers', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'first memory', importance: 7 });
    storeDrawer(dir, { wing: 'beta', hall: 'h2', room: 'r2', content: 'second memory', importance: 5 });
    const result = memoryWakeUp(dir);
    expect(result).toContain('## alpha / r1');
    expect(result).toContain('- first memory');
    expect(result).toContain('## beta / r2');
    expect(result).toContain('- second memory');
  });

  it('returns highest-importance memories first', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'w', hall: 'h', room: 'r1', content: 'low importance', importance: 2 });
    storeDrawer(dir, { wing: 'w', hall: 'h', room: 'r2', content: 'high importance', importance: 9 });
    const result = memoryWakeUp(dir);
    const highIdx = result.indexOf('high importance');
    const lowIdx = result.indexOf('low importance');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('respects token budget — output does not exceed tokenBudget * 4 characters', () => {
    initMemoryDb(dir);
    // Each row produces ~23 chars: header "\n## w / rN\n\n" (13) + "- entry-N\n" (10).
    // tokenBudget=8 → charBudget=32: fits the first entry (~23 chars) but not the second (~46 total).
    for (let i = 0; i < 5; i++) {
      storeDrawer(dir, { wing: 'w', hall: 'h', room: `r${i}`, content: `entry-${i}`, importance: 5 });
    }
    const tokenBudget = 8; // charBudget = 32
    const result = memoryWakeUp(dir, { tokenBudget });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(tokenBudget * 4);
  });

  it('filters by wing when provided', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'alpha', hall: 'h1', room: 'r1', content: 'alpha content', importance: 7 });
    storeDrawer(dir, { wing: 'beta', hall: 'h2', room: 'r2', content: 'beta content', importance: 7 });
    const result = memoryWakeUp(dir, { wing: 'alpha' });
    expect(result).toContain('alpha content');
    expect(result).not.toContain('beta content');
  });

  it('returns empty string on empty DB', () => {
    initMemoryDb(dir);
    expect(memoryWakeUp(dir)).toBe('');
  });

  it('returns empty string when memory.db does not exist (graceful degradation)', () => {
    // Use a non-existent directory so getMemoryDb/initMemoryDb throws
    const result = memoryWakeUp('/nonexistent/path/that/does/not/exist');
    expect(result).toBe('');
  });
});

describe('wingFromTaskRef', () => {
  it('extracts feature prefix before first slash', () => {
    expect(wingFromTaskRef('e2e-real/127-some-task')).toBe('e2e-real');
    expect(wingFromTaskRef('memory-access/137-ingestion')).toBe('memory-access');
    expect(wingFromTaskRef('proj/fix-bug')).toBe('proj');
  });

  it('falls back to general for refs without a slash', () => {
    expect(wingFromTaskRef('no-slash-here')).toBe('general');
    expect(wingFromTaskRef('')).toBe('general');
  });

  it('falls back to general when slash is the first character', () => {
    expect(wingFromTaskRef('/leading-slash')).toBe('general');
  });
});

describe('pruneExpiredMemories', () => {
  it('deletes drawers past their expires_at', () => {
    initMemoryDb(dir);
    const past = new Date(Date.now() - 1000).toISOString();
    storeDrawer(dir, { hall: 'h', room: 'r', content: 'expired entry', expiresAt: past });
    const count = pruneExpiredMemories(dir);
    expect(count).toBe(1);
    expect(listDrawers(dir, {})).toHaveLength(0);
  });

  it('leaves non-expired drawers intact', () => {
    initMemoryDb(dir);
    const future = new Date(Date.now() + 60_000).toISOString();
    storeDrawer(dir, { hall: 'h', room: 'r', content: 'still valid', expiresAt: future });
    const count = pruneExpiredMemories(dir);
    expect(count).toBe(0);
    expect(listDrawers(dir, {})).toHaveLength(1);
  });

  it('leaves drawers without expires_at intact', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { hall: 'h', room: 'r', content: 'no expiry' });
    const count = pruneExpiredMemories(dir);
    expect(count).toBe(0);
    expect(listDrawers(dir, {})).toHaveLength(1);
  });

  it('returns 0 on empty DB', () => {
    initMemoryDb(dir);
    expect(pruneExpiredMemories(dir)).toBe(0);
  });

  it('returns 0 when memory.db does not exist', () => {
    // Use a real temp dir that exists, but without calling initMemoryDb — so memory.db is absent.
    const emptyDir = createTempStateDir();
    try {
      expect(pruneExpiredMemories(emptyDir)).toBe(0);
      expect(existsSync(join(emptyDir, 'memory.db'))).toBe(false);
    } finally {
      cleanupTempStateDir(emptyDir);
    }
  });
});

describe('pruneByCapacity', () => {
  it('keeps top-N drawers per room by importance, deletes the rest', () => {
    initMemoryDb(dir);
    for (let i = 1; i <= 5; i++) {
      storeDrawer(dir, { wing: 'w', hall: 'h', room: 'r', content: `entry-${i}`, importance: i });
    }
    const deleted = pruneByCapacity(dir, 3);
    expect(deleted).toBe(2);
    const remaining = listDrawers(dir, { wing: 'w', room: 'r' });
    expect(remaining).toHaveLength(3);
    // Highest importance entries (5, 4, 3) should be kept
    const importances = remaining.map(d => d.importance).sort((a, b) => b - a);
    expect(importances).toEqual([5, 4, 3]);
  });

  it('preserves highest-importance drawers', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { wing: 'w', hall: 'h', room: 'r', content: 'low-imp', importance: 1 });
    storeDrawer(dir, { wing: 'w', hall: 'h', room: 'r', content: 'high-imp', importance: 9 });
    const deleted = pruneByCapacity(dir, 1);
    expect(deleted).toBe(1);
    const remaining = listDrawers(dir, { wing: 'w', room: 'r' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.importance).toBe(9);
  });

  it('is a no-op when all rooms are under the limit', () => {
    initMemoryDb(dir);
    storeDrawer(dir, { hall: 'h', room: 'r', content: 'solo entry' });
    const deleted = pruneByCapacity(dir, 200);
    expect(deleted).toBe(0);
    expect(listDrawers(dir, {})).toHaveLength(1);
  });

  it('returns 0 on empty DB', () => {
    initMemoryDb(dir);
    expect(pruneByCapacity(dir, 200)).toBe(0);
  });

  it('returns 0 when memory.db does not exist', () => {
    // Use a real temp dir that exists, but without calling initMemoryDb — so memory.db is absent.
    const emptyDir = createTempStateDir();
    try {
      expect(pruneByCapacity(emptyDir, 200)).toBe(0);
      expect(existsSync(join(emptyDir, 'memory.db'))).toBe(false);
    } finally {
      cleanupTempStateDir(emptyDir);
    }
  });
});

describe('multi-stateDir', () => {
  it('initMemoryDb supports multiple stateDirs simultaneously', () => {
    const dir2 = createTempStateDir('orch-memory-test2-');
    try {
      const db1 = initMemoryDb(dir);
      const db2 = initMemoryDb(dir2);
      expect(db1).not.toBe(db2);
      // Insert in dir only — dir2 should remain empty
      storeDrawer(dir, { hall: 'h', room: 'r', content: 'only in dir1' });
      expect(listDrawers(dir2)).toHaveLength(0);
      expect(listDrawers(dir)).toHaveLength(1);
    } finally {
      closeMemoryDb(dir2);
      cleanupTempStateDir(dir2);
    }
  });

  it('closeMemoryDb(stateDir) closes only that stateDir', () => {
    const dir2 = createTempStateDir('orch-memory-test2-');
    try {
      initMemoryDb(dir);
      initMemoryDb(dir2);
      closeMemoryDb(dir);
      // dir2 DB is still open and usable
      expect(() => storeDrawer(dir2, { hall: 'h', room: 'r', content: 'still works' })).not.toThrow();
      expect(listDrawers(dir2)).toHaveLength(1);
    } finally {
      closeMemoryDb(dir2);
      cleanupTempStateDir(dir2);
    }
  });

  it('getMemoryDb returns distinct DBs for different stateDirs', () => {
    const dir2 = createTempStateDir('orch-memory-test2-');
    try {
      const db1 = getMemoryDb(dir);
      const db2 = getMemoryDb(dir2);
      expect(db1).not.toBe(db2);
    } finally {
      closeMemoryDb(dir2);
      cleanupTempStateDir(dir2);
    }
  });

  it('getMemoryDb re-initializes after closeAllDatabases()', () => {
    initMemoryDb(dir);
    closeAllDatabases();
    // _memDbs still has a stale closed handle — getMemoryDb must detect and re-initialize
    const db = getMemoryDb(dir);
    expect(db.open).toBe(true);
    // Verify it's fully functional
    expect(() => storeDrawer(dir, { hall: 'h', room: 'r', content: 'after reopen' })).not.toThrow();
  });
});
