import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cleanupTempStateDir, createTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, readEvents } from './eventLog.ts';
import { ensureStateInitialized } from './stateInit.ts';
import { inspectRuntimeSchema, migrateRuntimeSchema, RUNTIME_SCHEMA_VERSION } from './runtimeSchema.ts';

let dir: string;

beforeEach(() => { dir = createTempStateDir('orch-runtime-schema-'); });
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

function doctor(stateDir: string) {
  mkdirSync(join(stateDir, 'backlog'), { recursive: true });
  return spawnSync(process.execPath, ['cli/doctor.ts', '--json'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, ORC_STATE_DIR: stateDir, ORC_REPO_ROOT: stateDir, ORC_BACKLOG_DIR: join(stateDir, 'backlog') },
    encoding: 'utf8',
  });
}

describe('runtime schema migration', () => {
  it('initializes a fresh store once, with operational constraints and a healthy doctor result', () => {
    ensureStateInitialized(dir);
    const health = inspectRuntimeSchema(dir);
    expect(health).toEqual({ ok: true, version: RUNTIME_SCHEMA_VERSION, messages: [] });

    const db = new Database(join(dir, 'events.db'));
    try {
      db.pragma('foreign_keys = ON');
      const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
      for (const name of ['events', 'schema_migrations', 'runs', 'sessions', 'commands', 'messages', 'input_requests', 'offsets', 'control_leases']) {
        expect(names.has(name)).toBe(true);
      }
      db.prepare("INSERT INTO runs (run_id, task_ref, state, created_at, updated_at) VALUES ('run-1', 'project/task', 'claimed', 'now', 'now')").run();
      db.prepare("INSERT INTO commands (command_id, run_id, actor_id, recipient_id, idempotency_key, kind, payload, state, created_at) VALUES ('cmd-1', 'run-1', 'master', 'agent', 'key-1', 'send', '{}', 'queued', 'now')").run();
      expect(() => db.prepare("INSERT INTO commands (command_id, run_id, actor_id, recipient_id, idempotency_key, kind, payload, state, created_at) VALUES ('cmd-2', 'run-1', 'master', 'agent', 'key-1', 'send', '{}', 'queued', 'now')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO runs (run_id, task_ref, state, created_at, updated_at) VALUES ('run-2', 'project/task', 'claimed', 'now', 'now')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at) VALUES ('session-1', 'missing', 'agent', 'codex', 'running', 'now', 'now')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO offsets (consumer_id, last_event_seq, updated_at) VALUES ('reader', -1, 'now')").run()).toThrow();
    } finally {
      db.close();
    }

    closeAllDatabases();
    initEventsDb(dir);
    const repeated = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(repeated.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 2 });
    } finally {
      repeated.close();
    }
    const result = doctor(dir);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect((JSON.parse(result.stdout) as { checks: { runtimeSchema: { ok: boolean } } }).checks.runtimeSchema.ok).toBe(true);
  });

  it('upgrades a copied legacy event database without changing events or FTS', () => {
    const fixtureDir = createTempStateDir('orch-legacy-fixture-');
    try {
      const fixture = new Database(join(fixtureDir, 'events.db'));
      fixture.exec(`
        CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
          ts TEXT NOT NULL, event TEXT NOT NULL, agent_id TEXT, run_id TEXT, task_ref TEXT, payload TEXT NOT NULL);
        CREATE VIRTUAL TABLE events_fts USING fts5(event, agent_id, run_id, task_ref, payload, content='events', content_rowid='seq');
        CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
          INSERT INTO events_fts(rowid, event, agent_id, run_id, task_ref, payload)
          VALUES (new.seq, new.event, new.agent_id, new.run_id, new.task_ref, new.payload);
        END;
      `);
      const payload = JSON.stringify({ seq: 7, event_id: 'legacy-7', ts: '2026-01-01T00:00:00Z', event: 'heartbeat', actor_type: 'coordinator', actor_id: 'coordinator', agent_id: 'agent-1' });
      fixture.prepare("INSERT INTO events (seq, event_id, ts, event, agent_id, payload) VALUES (7, 'legacy-7', '2026-01-01T00:00:00Z', 'heartbeat', 'agent-1', ?)").run(payload);
      fixture.close();
      ensureStateInitialized(dir);
      closeAllDatabases();
      copyFileSync(join(fixtureDir, 'events.db'), join(dir, 'events.db'));

      initEventsDb(dir);
      expect(readEvents(join(dir, 'events.db')).map((event) => event.seq)).toEqual([7]);
      expect(queryEvents(dir, { fts_query: 'legacy' }).map((event) => event.event_id)).toEqual(['legacy-7']);
      expect(inspectRuntimeSchema(dir).ok).toBe(true);
      const result = doctor(dir);
      expect(result.status, result.stderr || result.stdout).toBe(0);
    } finally {
      cleanupTempStateDir(fixtureDir);
    }
  });

  it('rolls back all operational tables and the version after a migration failure', () => {
    const db = new Database(join(dir, 'events.db'));
    try {
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version < 1), name TEXT NOT NULL, applied_at TEXT NOT NULL)');
      expect(() => migrateRuntimeSchema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(0);
      const names = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
      expect(names.has('runs')).toBe(false);
      expect(names.has('control_leases')).toBe(false);
      expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('keeps version 1 intact if the version 2 migration is interrupted, then retries', () => {
    const db = new Database(join(dir, 'events.db'));
    try {
      db.exec('CREATE TABLE runtime_cutovers (name TEXT PRIMARY KEY)');
      expect(() => migrateRuntimeSchema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(1);
      expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }]);
      expect((db.pragma('table_info(runs)') as Array<{ name: string }>).some((column) => column.name === 'claim_json')).toBe(false);
      db.exec('DROP TABLE runtime_cutovers');
      db.prepare("INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at) VALUES ('run-old', 'feature/task', 'agent-old', 'in_progress', 'now', 'now')").run();
      db.prepare("INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at) VALUES ('session-old', 'run-old', 'agent-old', 'codex', 'running', 'now', 'now')").run();
      db.prepare("INSERT INTO commands (command_id, run_id, session_id, actor_id, recipient_id, idempotency_key, kind, payload, state, created_at) VALUES ('cmd-old', 'run-old', 'session-old', 'master', 'agent-old', 'key-old', 'send', '{}', 'queued', 'now')").run();
      db.prepare("INSERT INTO control_leases (resource_type, resource_id, lease_id, session_id, owner_id, expires_at) VALUES ('run', 'run-old', 'lease-old', 'session-old', 'agent-old', 'later')").run();
      migrateRuntimeSchema(db);
      expect(db.pragma('user_version', { simple: true })).toBe(2);
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }]);
      expect(db.prepare("SELECT session_id, run_id FROM sessions WHERE session_id = 'session-old'").get()).toEqual({ session_id: 'session-old', run_id: 'run-old' });
      expect(db.prepare("SELECT session_id FROM commands WHERE command_id = 'cmd-old'").get()).toEqual({ session_id: 'session-old' });
      expect(db.prepare("SELECT session_id FROM control_leases WHERE lease_id = 'lease-old'").get()).toEqual({ session_id: 'session-old' });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses a future version before touching its schema', () => {
    const db = new Database(join(dir, 'events.db'));
    db.exec('CREATE TABLE future_marker (id INTEGER PRIMARY KEY); PRAGMA user_version = 3');
    db.close();
    expect(() => initEventsDb(dir)).toThrow('newer than supported version');
    const check = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toBeUndefined();
      expect(check.pragma('user_version', { simple: true })).toBe(3);
    } finally {
      check.close();
    }
    expect(inspectRuntimeSchema(dir).ok).toBe(false);
    const result = doctor(dir);
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout) as { checks: { runtimeSchema: { version: number; ok: boolean } } }).checks.runtimeSchema)
      .toMatchObject({ version: 3, ok: false });
  });
});
