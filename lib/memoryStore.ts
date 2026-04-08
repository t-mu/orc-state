import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_drawers_content_hash
      ON drawers (content_hash) WHERE content_hash IS NOT NULL;
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
