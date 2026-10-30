import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

/**
 * The open failures of a process that may read but not write a state
 * directory — a sandboxed project session — which cannot run the setup
 * (`journal_mode = WAL`, DDL, migrations) a read-write open performs.
 */
export function isReadOnlyOpenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_READONLY') || code.startsWith('SQLITE_CANTOPEN') || code === 'SQLITE_PERM');
}

/**
 * Whether an open that failed with `error` should be retried read-only.
 * Only a sandboxed session (one launched with ORC_SESSION_SECRET) does: it
 * sends every write to the coordinator. A writer — the coordinator, the MCP
 * server, an operator shell — keeps failing loudly at open instead of caching
 * a read-only handle its later writes would trip over.
 */
export function shouldOpenReadOnly(error: unknown, path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ORC_SESSION_SECRET?.trim()) && isReadOnlyOpenError(error) && existsSync(path);
}

/**
 * Open an existing WAL database read-only. SQLite can do so without write
 * access only while another process keeps its `-wal`/`-shm` files (the
 * running coordinator); otherwise the read is refused with a retryable error.
 */
export function openReadOnlyDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    // Opening is lazy; the first read touches the WAL index. WAL/SHM may
    // survive a coordinator crash or a version-skewed client, so this is only
    // a limited read fallback, never an alternate write path.
    db.pragma('schema_version', { simple: true });
    return db;
  } catch (error) {
    db.close();
    if (!isReadOnlyOpenError(error)) throw error;
    throw new Error(`${path} cannot be read without write access while no coordinator holds it open; retry once the coordinator is running`, { cause: error });
  }
}
