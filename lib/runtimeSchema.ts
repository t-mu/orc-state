import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export const RUNTIME_SCHEMA_VERSION = 8;

const OPERATIONAL_TABLES = [
  'schema_migrations', 'runs', 'sessions', 'commands', 'messages',
  'input_requests', 'offsets', 'control_leases', 'runtime_cutovers', 'terminals',
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
  let currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === RUNTIME_SCHEMA_VERSION) {
    const health = inspectRuntimeSchemaDb(db);
    if (!health.ok) throw new Error(`events.db schema is inconsistent: ${health.messages.join('; ')}`);
    return;
  }
  if (currentVersion === 0) {
    db.transaction(() => {
      assertSupportedRuntimeSchemaVersion(db);
      if ((db.pragma('user_version', { simple: true }) as number) !== 0) return;
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
      db.pragma('user_version = 1');
    }).immediate();
    currentVersion = db.pragma('user_version', { simple: true }) as number;
  }
  if (currentVersion === 1) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        assertSupportedRuntimeSchemaVersion(db);
        if ((db.pragma('user_version', { simple: true }) as number) !== 1) return;
        db.exec(`
        ALTER TABLE runs ADD COLUMN claim_json TEXT;
        CREATE TABLE sessions_v2 (
          session_id TEXT PRIMARY KEY,
          run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
          agent_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          state TEXT NOT NULL,
          provider_ref TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO sessions_v2
          (session_id, run_id, agent_id, provider, state, provider_ref, started_at, updated_at)
        SELECT session_id, run_id, agent_id, provider, state, provider_ref, started_at, updated_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v2 RENAME TO sessions;
        CREATE UNIQUE INDEX sessions_one_running_agent_idx ON sessions(agent_id)
          WHERE state = 'running';
        CREATE TABLE runtime_cutovers (
          name TEXT PRIMARY KEY,
          imported_at TEXT NOT NULL
        );
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (2, 'run_authority_cutover', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        `);
        db.pragma('user_version = 2');
      }).immediate();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === 2) {
    db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) !== 2) return;
      db.exec(`
        ALTER TABLE commands ADD COLUMN actor_session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL;
        ALTER TABLE commands ADD COLUMN side_effecting INTEGER NOT NULL DEFAULT 1 CHECK (side_effecting IN (0, 1));
        ALTER TABLE commands ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
        ALTER TABLE commands ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1);
        ALTER TABLE commands ADD COLUMN next_attempt_at TEXT;
        ALTER TABLE commands ADD COLUMN deadline_at TEXT;
        ALTER TABLE commands ADD COLUMN dispatch_started_at TEXT;
        ALTER TABLE commands ADD COLUMN send_started_at TEXT;
        ALTER TABLE commands ADD COLUMN terminal_at TEXT;
        ALTER TABLE commands ADD COLUMN last_error TEXT;
        CREATE INDEX commands_ready_idx ON commands(state, next_attempt_at, created_at);
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (3, 'durable_command_delivery', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      db.pragma('user_version = 3');
    }).immediate();
  }
  currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === 3) {
    db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) !== 3) return;
      db.exec(`
        ALTER TABLE sessions ADD COLUMN transport TEXT;
        ALTER TABLE sessions ADD COLUMN process_pid INTEGER;
        ALTER TABLE sessions ADD COLUMN process_start TEXT;
        ALTER TABLE sessions ADD COLUMN owner_id TEXT;
        ALTER TABLE sessions ADD COLUMN owner_expires_at TEXT;
        ALTER TABLE sessions ADD COLUMN state_reason TEXT;
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (4, 'session_supervision', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      db.pragma('user_version = 4');
    }).immediate();
  }
  currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === 4) {
    db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) !== 4) return;
      db.exec(`
        CREATE TABLE terminals (
          terminal_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('provider', 'shell')),
          handle TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          log_path TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('running', 'offline')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (run_id, kind)
        );
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (5, 'terminal_broker', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      db.pragma('user_version = 5');
    }).immediate();
  }
  currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === 5) {
    db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) !== 5) return;
      db.exec(`
        ALTER TABLE messages ADD COLUMN sender_id TEXT;
        ALTER TABLE messages ADD COLUMN sender_session_id TEXT;
        ALTER TABLE messages ADD COLUMN recipient_id TEXT;
        ALTER TABLE messages ADD COLUMN recipient_session_id TEXT;
        ALTER TABLE messages ADD COLUMN recipient_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL;
        ALTER TABLE messages ADD COLUMN parent_message_id TEXT REFERENCES messages(message_id) ON DELETE SET NULL;
        ALTER TABLE messages ADD COLUMN state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'consumed'));
        ALTER TABLE messages ADD COLUMN consumed_at TEXT;
        CREATE INDEX messages_recipient_idx ON messages(recipient_session_id, state, created_at);
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (6, 'semantic_message_routing', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      db.pragma('user_version = 6');
    }).immediate();
  }
  currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === 6) {
    db.transaction(() => {
      if ((db.pragma('user_version', { simple: true }) as number) !== 6) return;
      // A session authenticates with a secret only its process holds; the state keeps its hash (task 231).
      db.exec(`
        ALTER TABLE sessions ADD COLUMN credential_hash TEXT;
        CREATE UNIQUE INDEX sessions_credential_idx ON sessions(credential_hash) WHERE credential_hash IS NOT NULL;
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (7, 'session_credentials', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      db.pragma('user_version = 7');
    }).immediate();
  }
  currentVersion = db.pragma('user_version', { simple: true }) as number;
  if (currentVersion === 7) {
    // Rebuilding messages and terminals drops their NOT NULL run_id; foreign keys stay off so the
    // drop does not cascade into input_requests, and are checked before commit.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        if ((db.pragma('user_version', { simple: true }) as number) !== 7) return;
        db.exec(`
        ALTER TABLE sessions ADD COLUMN provider_conversation_id TEXT;
        ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);
        ALTER TABLE sessions ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0 CHECK (resume_count >= 0);
        ALTER TABLE sessions ADD COLUMN exit_reason TEXT
          CHECK (exit_reason IS NULL OR exit_reason IN ('crash', 'finished', 'user_exit', 'killed', 'unknown'));
        CREATE TABLE terminals_v8 (
          terminal_id TEXT PRIMARY KEY,
          session_id TEXT REFERENCES sessions(session_id) ON DELETE CASCADE,
          run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('provider', 'shell')),
          handle TEXT NOT NULL,
          worktree_path TEXT NOT NULL,
          log_path TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('running', 'offline')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (session_id IS NOT NULL OR run_id IS NOT NULL)
        );
        INSERT INTO terminals_v8
          (terminal_id, session_id, run_id, kind, handle, worktree_path, log_path, state, created_at, updated_at)
        SELECT t.terminal_id,
          (SELECT s.session_id FROM sessions s WHERE s.run_id = t.run_id ORDER BY s.rowid DESC LIMIT 1),
          t.run_id, t.kind, t.handle, t.worktree_path, t.log_path, t.state, t.created_at, t.updated_at
        FROM terminals t;
        DROP TABLE terminals;
        ALTER TABLE terminals_v8 RENAME TO terminals;
        -- Pre-v8 rows keep their <kind>:<run_id> id but are retired: the next open creates the
        -- session-keyed row, so one handle never has two live ids with separate writer leases.
        UPDATE terminals SET state = 'offline' WHERE state = 'running';
        DELETE FROM control_leases WHERE resource_type = 'terminal';
        CREATE INDEX terminals_session_idx ON terminals(session_id, kind);
        CREATE INDEX terminals_run_idx ON terminals(run_id);
        CREATE TABLE messages_v8 (
          message_id TEXT PRIMARY KEY,
          run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
          command_id TEXT REFERENCES commands(command_id) ON DELETE SET NULL,
          idempotency_key TEXT NOT NULL UNIQUE,
          direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
          kind TEXT NOT NULL,
          payload TEXT NOT NULL CHECK (json_valid(payload)),
          created_at TEXT NOT NULL,
          sender_id TEXT,
          sender_session_id TEXT,
          recipient_id TEXT,
          recipient_session_id TEXT,
          recipient_agent_id TEXT,
          recipient_run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
          parent_message_id TEXT REFERENCES messages(message_id) ON DELETE SET NULL,
          state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'consumed')),
          consumed_at TEXT,
          CHECK ((recipient_session_id IS NULL) <> (recipient_agent_id IS NULL))
        );
        INSERT INTO messages_v8
          (message_id, run_id, command_id, idempotency_key, direction, kind, payload, created_at, sender_id,
           sender_session_id, recipient_id, recipient_session_id, recipient_agent_id, recipient_run_id,
           parent_message_id, state, consumed_at)
        SELECT message_id, run_id, command_id, idempotency_key, direction, kind, payload, created_at, sender_id,
          sender_session_id, recipient_id, recipient_session_id,
          CASE WHEN recipient_session_id IS NULL THEN recipient_id END,
          recipient_run_id, parent_message_id, state, consumed_at
        FROM messages ORDER BY rowid;
        DROP TABLE messages;
        ALTER TABLE messages_v8 RENAME TO messages;
        CREATE INDEX messages_run_idx ON messages(run_id, created_at);
        CREATE INDEX messages_recipient_idx ON messages(recipient_session_id, state, created_at);
        CREATE INDEX messages_recipient_agent_idx ON messages(recipient_agent_id, state, created_at);
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (8, 'session_identity', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        `);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) throw new Error(`session_identity migration left ${violations.length} foreign key violation(s)`);
        db.pragma('user_version = 8');
      }).immediate();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  const health = inspectRuntimeSchemaDb(db);
  if (!health.ok) throw new Error(`events.db schema is inconsistent: ${health.messages.join('; ')}`);
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
      const rows = db.prepare('SELECT version, name FROM schema_migrations').all() as Array<{ version: number; name: string }>;
      const byVersion = new Map(rows.map((row) => [row.version, row.name]));
      if (byVersion.get(1) !== 'initial_operational_tables') messages.push('missing migration record 1');
      if (byVersion.get(2) !== 'run_authority_cutover') messages.push('missing migration record 2');
      if (byVersion.get(3) !== 'durable_command_delivery') messages.push('missing migration record 3');
      if (byVersion.get(4) !== 'session_supervision') messages.push('missing migration record 4');
      if (byVersion.get(5) !== 'terminal_broker') messages.push('missing migration record 5');
      if (byVersion.get(6) !== 'semantic_message_routing') messages.push('missing migration record 6');
      if (byVersion.get(7) !== 'session_credentials') messages.push('missing migration record 7');
      if (byVersion.get(8) !== 'session_identity') messages.push('missing migration record 8');
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) messages.push(`${violations.length} foreign key violation(s)`);
  }
  return { ok: messages.length === 0, version, messages };
}
