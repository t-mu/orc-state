import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { registerDb, unregisterDb } from './eventLog.ts';

const MEMORY_DB_FILE = 'memory.db';
const _memDbs = new Map<string, Database.Database>();

export function initMemoryDb(stateDir: string): Database.Database {
  const existing = _memDbs.get(stateDir);
  if (existing?.open) return existing;
  if (existing) _memDbs.delete(stateDir); // stale closed handle
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_drawers_content_hash
      ON drawers (content_hash) WHERE content_hash IS NOT NULL;
  `);

  registerDb('memory:' + stateDir, db);
  _memDbs.set(stateDir, db);
  return db;
}

export function getMemoryDb(stateDir: string): Database.Database {
  const existing = _memDbs.get(stateDir);
  if (existing?.open) return existing;
  if (existing) _memDbs.delete(stateDir); // stale closed handle
  return initMemoryDb(stateDir);
}

export function closeMemoryDb(stateDir?: string): void {
  if (stateDir) {
    const db = _memDbs.get(stateDir);
    if (db) {
      unregisterDb('memory:' + stateDir);
      if (db.open) db.close();
      _memDbs.delete(stateDir);
    }
    return;
  }
  // No-arg: close all (backward compat)
  for (const [key, db] of _memDbs) {
    unregisterDb('memory:' + key);
    if (db.open) db.close();
  }
  _memDbs.clear();
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

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
  'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then', 'once',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
  'this', 'that', 'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them',
  'we', 'you', 'i', 'me', 'my', 'our', 'your', 'his', 'her', 'their']);

export function extractKeywords(text: string, maxCount = 20): string {
  const words = text.toLowerCase().split(/[^a-z0-9_-]+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCount).map(e => e[0]).join(',');
}

export function wingFromTaskRef(taskRef: string): string {
  const slash = taskRef.indexOf('/');
  return slash > 0 ? taskRef.slice(0, slash) : 'general';
}

export function storeDrawer(stateDir: string, input: DrawerInput): number {
  const db = getMemoryDb(stateDir);
  const contentHash = createHash('sha256').update(input.content.trim().toLowerCase()).digest('hex');
  const existing = db.prepare('SELECT id FROM drawers WHERE content_hash = ?').get(contentHash) as { id: number } | undefined;
  if (existing) return existing.id;
  const tags = input.tags !== undefined ? input.tags : (extractKeywords(input.content) || null);
  const result = db.prepare(`
    INSERT INTO drawers (wing, hall, room, content, content_hash, importance, source_type, source_ref, agent_id, tags, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.wing ?? 'general', input.hall, input.room, input.content, contentHash,
    input.importance ?? 5, input.sourceType ?? null, input.sourceRef ?? null,
    input.agentId ?? null, tags, new Date().toISOString(),
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

export interface MemorySearchResult {
  id: number;
  snippet: string;
  wing: string;
  hall: string;
  room: string;
  importance: number;
  created_at: string;
  rank: number;
}

export function searchMemory(stateDir: string, opts: {
  query: string;
  wing?: string;
  hall?: string;
  room?: string;
  limit?: number;
}): MemorySearchResult[] {
  const db = getMemoryDb(stateDir);
  const conditions = ['drawers_fts MATCH ?'];
  const params: unknown[] = [opts.query];

  if (opts.wing) { conditions.push('d.wing = ?'); params.push(opts.wing); }
  if (opts.hall) { conditions.push('d.hall = ?'); params.push(opts.hall); }
  if (opts.room) { conditions.push('d.room = ?'); params.push(opts.room); }

  // bm25() returns negative values; more negative = better match.
  // rank = bm25 * (importance/10.0) is also negative. ORDER BY rank ASC puts the
  // most-negative (= most relevant, highest importance) rows first.
  // Spatial filters on d.* alongside drawers_fts MATCH in the same WHERE is the
  // established pattern used by queryEvents in eventLog.ts.
  const sql = `
    SELECT d.id, d.content, d.wing, d.hall, d.room, d.importance, d.created_at,
           (bm25(drawers_fts) * (d.importance / 10.0)) AS rank
    FROM drawers d
    JOIN drawers_fts ON drawers_fts.rowid = d.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank
    LIMIT ?
  `;
  params.push(opts.limit ?? 10);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: r.id as number,
    snippet: (r.content as string).slice(0, 200),
    wing: r.wing as string,
    hall: r.hall as string,
    room: r.room as string,
    importance: r.importance as number,
    created_at: r.created_at as string,
    rank: r.rank as number,
  }));
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

  let limitClause = '';
  if (opts.limit !== undefined) {
    limitClause = 'LIMIT ?';
    params.push(opts.limit);
  } else if (opts.offset !== undefined) {
    limitClause = 'LIMIT -1';
  }
  let offsetClause = '';
  if (opts.offset !== undefined) {
    offsetClause = 'OFFSET ?';
    params.push(opts.offset);
  }

  const sql = ['SELECT * FROM drawers', where, limitClause, offsetClause].filter(Boolean).join(' ');
  return db.prepare(sql).all(...params) as Drawer[];
}

export function listWings(stateDir: string): Array<{ wing: string; count: number }> {
  const db = getMemoryDb(stateDir);
  return db.prepare('SELECT wing, COUNT(*) as count FROM drawers GROUP BY wing ORDER BY count DESC').all() as Array<{ wing: string; count: number }>;
}

export function listRooms(stateDir: string, wing: string): Array<{ room: string; hall: string; count: number }> {
  const db = getMemoryDb(stateDir);
  return db.prepare('SELECT room, hall, COUNT(*) as count FROM drawers WHERE wing = ? GROUP BY room, hall ORDER BY count DESC').all(wing) as Array<{ room: string; hall: string; count: number }>;
}

export interface MemoryStats {
  totalDrawers: number;
  distinctWings: number;
  distinctRooms: number;
  oldestMemory: string | null;
  newestMemory: string | null;
  dbSizeBytes: number;
}

interface StatsRow {
  total: number;
  wings: number;
  rooms: number;
  oldest: string | null;
  newest: string | null;
}

export function getMemoryStats(stateDir: string): MemoryStats {
  const db = getMemoryDb(stateDir);
  const row = db.prepare(`
    SELECT COUNT(*) as total,
           COUNT(DISTINCT wing) as wings,
           COUNT(DISTINCT wing || '/' || room) as rooms,
           MIN(created_at) as oldest,
           MAX(created_at) as newest
    FROM drawers
  `).get() as StatsRow;
  const { size } = statSync(join(stateDir, 'memory.db'));
  return {
    totalDrawers: row.total,
    distinctWings: row.wings,
    distinctRooms: row.rooms,
    oldestMemory: row.oldest,
    newestMemory: row.newest,
    dbSizeBytes: size,
  };
}

export function memoryWakeUp(stateDir: string, opts: {
  wing?: string;
  tokenBudget?: number;
} = {}): string {
  const charBudget = (opts.tokenBudget ?? 800) * 4;
  let db: Database.Database;
  try { db = getMemoryDb(stateDir); } catch { return ''; }

  const conditions = opts.wing ? ['wing = ?'] : [];
  const params: unknown[] = opts.wing ? [opts.wing] : [];

  const sql = `SELECT wing, hall, room, content, importance FROM drawers
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY importance DESC, created_at DESC`;
  const rows = db.prepare(sql).all(...params) as Array<Pick<Drawer, 'wing' | 'hall' | 'room' | 'content' | 'importance'>>;

  let output = '';
  let charCount = 0;
  let currentWing = '';
  let currentRoom = '';

  for (const row of rows) {
    const header = (row.wing !== currentWing || row.room !== currentRoom)
      ? `\n## ${row.wing} / ${row.room}\n\n` : '';
    const entry = `- ${row.content}\n`;
    const addition = header + entry;
    if (charCount + addition.length > charBudget) break;
    output += addition;
    charCount += addition.length;
    currentWing = row.wing;
    currentRoom = row.room;
  }

  return output.trim();
}

export function pruneExpiredMemories(stateDir: string): number {
  if (!existsSync(join(stateDir, MEMORY_DB_FILE))) return 0;
  try {
    const db = getMemoryDb(stateDir);
    const result = db.prepare(`DELETE FROM drawers WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(new Date().toISOString());
    return result.changes;
  } catch { return 0; }
}

export function pruneByCapacity(stateDir: string, maxPerRoom = 200): number {
  if (!existsSync(join(stateDir, MEMORY_DB_FILE))) return 0;
  try {
    const db = getMemoryDb(stateDir);
    const overCapacity = db.prepare(`
      SELECT wing, room, COUNT(*) as cnt FROM drawers
      GROUP BY wing, room HAVING cnt > ?
    `).all(maxPerRoom) as Array<{ wing: string; room: string; cnt: number }>;

    let totalDeleted = 0;
    for (const { wing, room } of overCapacity) {
      const result = db.prepare(`
        DELETE FROM drawers WHERE id IN (
          SELECT id FROM drawers WHERE wing = ? AND room = ?
          ORDER BY importance DESC, created_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(wing, room, maxPerRoom);
      totalDeleted += result.changes;
    }
    return totalDeleted;
  } catch { return 0; }
}
