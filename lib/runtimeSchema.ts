import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export const RUNTIME_SCHEMA_VERSION = 1;

const OPERATIONAL_TABLES = [
  'schema_migrations', 'runs', 'sessions', 'commands', 'messages',
  'input_requests', 'offsets', 'control_leases',
] as const;

/** A zero-version database is the legacy event-only store. */
export function assertSupportedRuntimeSchemaVersion(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > RUNTIME_SCHEMA_VERSION) {
    throw new Error(`events.db schema version ${version} is newer than supported version ${RUNTIME_SCHEMA_VERSION}; use a newer orc binary`);
  }
}

/** Install operational tables without importing or changing legacy JSON state. */
export function migrateRuntimeSchema(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  assertSupportedRuntimeSchemaVersion(db);
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === RUNTIME_SCHEMA_VERSION) {
    const health = inspectRuntimeSchemaDb(db);
    if (!health.ok) throw new Error(`events.db schema is inconsistent: ${health.messages.join('; ')}`);
    return;
  }
  db.transaction(() => {
    // Recheck after taking the write lock: another process may have migrated it.
    assertSupportedRuntimeSchemaVersion(db);
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version === RUNTIME_SCHEMA_VERSION) {
      const health = inspectRuntimeSchemaDb(db);
      if (!health.ok) throw new Error(`events.db schema is inconsistent: ${health.messages.join('; ')}`);
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        task_ref TEXT NOT NULL,
        agent_id TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX runs_one_active_task_idx ON runs(task_ref)
        WHERE state IN ('claimed', 'in_progress');
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        state TEXT NOT NULL,
        provider_ref TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        actor_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        acknowledged_at TEXT,
        UNIQUE (run_id, idempotency_key)
      );
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        command_id TEXT REFERENCES commands(command_id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        kind TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)),
        created_at TEXT NOT NULL
      );
      CREATE TABLE input_requests (
        request_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        message_id TEXT UNIQUE REFERENCES messages(message_id) ON DELETE SET NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        question TEXT NOT NULL,
        state TEXT NOT NULL,
        response TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE TABLE offsets (
        consumer_id TEXT PRIMARY KEY,
        last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE control_leases (
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        lease_id TEXT NOT NULL UNIQUE,
        session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
        owner_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id)
      );
      CREATE INDEX commands_pending_idx ON commands(state, created_at);
      CREATE INDEX messages_run_idx ON messages(run_id, created_at);
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (1, 'initial_operational_tables', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
    db.pragma(`user_version = ${RUNTIME_SCHEMA_VERSION}`);
  }).immediate();
}

export function inspectRuntimeSchema(stateDir: string): { ok: boolean; version: number | null; messages: string[] } {
  const path = join(stateDir, 'events.db');
  if (!existsSync(path)) return { ok: false, version: null, messages: ['events.db: file not found'] };
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return inspectRuntimeSchemaDb(db);
    } finally {
      db.close();
    }
  } catch (error) {
    return { ok: false, version: null, messages: [`events.db: ${(error as Error).message}`] };
  }
}

function inspectRuntimeSchemaDb(db: Database.Database): { ok: boolean; version: number; messages: string[] } {
  const version = db.pragma('user_version', { simple: true }) as number;
  const messages: string[] = [];
  if (version > RUNTIME_SCHEMA_VERSION) messages.push(`schema version ${version} is newer than supported version ${RUNTIME_SCHEMA_VERSION}`);
  else if (version < RUNTIME_SCHEMA_VERSION) messages.push(`schema version ${version} requires migration to ${RUNTIME_SCHEMA_VERSION}`);
  if (version === RUNTIME_SCHEMA_VERSION) {
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    for (const table of OPERATIONAL_TABLES) if (!tables.has(table)) messages.push(`missing table ${table}`);
    if (tables.has('schema_migrations')) {
      const row = db.prepare('SELECT name FROM schema_migrations WHERE version = ?').get(RUNTIME_SCHEMA_VERSION) as { name: string } | undefined;
      if (row?.name !== 'initial_operational_tables') messages.push(`missing migration record ${RUNTIME_SCHEMA_VERSION}`);
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) messages.push(`${violations.length} foreign key violation(s)`);
  }
  return { ok: messages.length === 0, version, messages };
}
