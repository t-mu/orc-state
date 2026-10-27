import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * A process that may read but not write a state directory — a sandboxed
 * project worker — cannot run the setup (`journal_mode = WAL`, DDL,
 * migrations) the read-write open performs, and SQLite refuses even a
 * read-only open of a WAL database whose `-wal`/`-shm` files it cannot create.
 */
export function isReadOnlyOpenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_READONLY') || code.startsWith('SQLITE_CANTOPEN') || code === 'SQLITE_PERM');
}

/**
 * Open an existing database for reading without writing its directory. A
 * read-only connection works while another process keeps the WAL files open
 * (the running coordinator); otherwise the database and its WAL are copied
 * to a private temporary directory and read there. The copy is a snapshot:
 * callers are short-lived reads, and writes go through the coordinator.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      // Opening is lazy; the first read is what touches the WAL index.
      db.pragma('schema_version', { simple: true });
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    if (!isReadOnlyOpenError(error)) throw error;
  }
  const dir = mkdtempSync(join(tmpdir(), 'orc-readonly-'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  const copy = join(dir, basename(path));
  copyFileSync(path, copy);
  if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`);
  const db = new Database(copy, { fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}
