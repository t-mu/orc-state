import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync } from 'node:fs';
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
  return spawnSync(process.execPath, ['cli/doctor.ts', '--json'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, ORC_STATE_DIR: stateDir },
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
      for (const name of ['events', 'schema_migrations', 'runs', 'sessions', 'commands', 'messages', 'input_requests', 'offsets', 'control_leases', 'terminals']) {
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
      expect(repeated.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 8 });
    } finally {
      repeated.close();
    }
    const result = doctor(dir);
    // Without a project doctor fails overall; the fixture's state checks still pass.
    expect(JSON.parse(result.stdout).checks.stateErrors, result.stderr || result.stdout).toEqual([]);
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
      expect(JSON.parse(result.stdout).checks.stateErrors, result.stderr || result.stdout).toEqual([]);
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
      expect(db.pragma('user_version', { simple: true })).toBe(8);
      expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }]);
      expect((db.pragma('table_info(sessions)') as Array<{ name: string }>).map((column) => column.name)).toContain('credential_hash');
      expect((db.pragma('table_info(sessions)') as Array<{ name: string }>).map((column) => column.name))
        .toEqual(expect.arrayContaining(['transport', 'process_pid', 'process_start', 'owner_id', 'owner_expires_at', 'state_reason']));
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
    db.exec('CREATE TABLE future_marker (id INTEGER PRIMARY KEY); PRAGMA user_version = 9');
    db.close();
    expect(() => initEventsDb(dir)).toThrow('newer than supported version');
    const check = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'events'").get()).toBeUndefined();
      expect(check.pragma('user_version', { simple: true })).toBe(9);
    } finally {
      check.close();
    }
    expect(inspectRuntimeSchema(dir).ok).toBe(false);
    const result = doctor(dir);
    expect(result.status).toBe(1);
    expect((JSON.parse(result.stdout) as { checks: { runtimeSchema: { version: number; ok: boolean } } }).checks.runtimeSchema)
      .toMatchObject({ version: 9, ok: false });
  });

  it('upgrades a version 7 store with terminal and message rows intact after an interrupted attempt', () => {
    const db = new Database(join(dir, 'events.db'));
    try {
      db.exec('CREATE TABLE terminals_v8 (id INTEGER PRIMARY KEY)');
      expect(() => migrateRuntimeSchema(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(7);
      expect((db.pragma('table_info(sessions)') as Array<{ name: string }>).map((column) => column.name)).not.toContain('generation');
      db.exec('DROP TABLE terminals_v8');
      db.exec(`
        INSERT INTO runs (run_id, task_ref, agent_id, state, created_at, updated_at) VALUES ('run-1', 'feature/task', 'worker-1', 'in_progress', 'now', 'now');
        INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at) VALUES ('session-1', 'run-1', 'worker-1', 'claude', 'running', 'now', 'now');
        INSERT INTO terminals (terminal_id, run_id, kind, handle, worktree_path, log_path, state, created_at, updated_at)
          VALUES ('provider:run-1', 'run-1', 'provider', 'tmux:worker-1', '/wt', '/log', 'running', 'now', 'now');
        INSERT INTO messages (message_id, run_id, idempotency_key, direction, kind, payload, created_at, sender_id, recipient_id, recipient_session_id, recipient_run_id)
          VALUES ('msg-session', 'run-1', 'k-session', 'outbound', 'message', '{}', 'now', 'master', 'worker-1', 'session-1', 'run-1'),
            ('msg-agent', 'run-1', 'k-agent', 'outbound', 'question', '{}', 'now', 'worker-1', 'master', NULL, NULL);
        INSERT INTO input_requests (request_id, run_id, message_id, idempotency_key, question, state, created_at)
          VALUES ('req-1', 'run-1', 'msg-agent', 'k-agent', 'why?', 'pending', 'now');
      `);
      migrateRuntimeSchema(db);
      expect(db.pragma('user_version', { simple: true })).toBe(8);
      expect(db.prepare('SELECT terminal_id, session_id, run_id, handle FROM terminals').all())
        .toEqual([{ terminal_id: 'provider:run-1', session_id: 'session-1', run_id: 'run-1', handle: 'tmux:worker-1' }]);
      expect(db.prepare('SELECT message_id, recipient_id, recipient_session_id, recipient_agent_id FROM messages ORDER BY message_id').all()).toEqual([
        { message_id: 'msg-agent', recipient_id: 'master', recipient_session_id: null, recipient_agent_id: 'master' },
        { message_id: 'msg-session', recipient_id: 'worker-1', recipient_session_id: 'session-1', recipient_agent_id: null },
      ]);
      expect(db.prepare("SELECT message_id FROM input_requests WHERE request_id = 'req-1'").get()).toEqual({ message_id: 'msg-agent' });
      expect(db.prepare("SELECT generation, resume_count, exit_reason, provider_conversation_id FROM sessions WHERE session_id = 'session-1'").get())
        .toEqual({ generation: 0, resume_count: 0, exit_reason: null, provider_conversation_id: null });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
    expect(inspectRuntimeSchema(dir)).toEqual({ ok: true, version: 8, messages: [] });
  });

  it('stores terminals and messages for a run-less session and enforces one message recipient', () => {
    ensureStateInitialized(dir);
    const db = new Database(join(dir, 'events.db'));
    try {
      db.pragma('foreign_keys = ON');
      db.prepare("INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at) VALUES ('session-master', NULL, 'master', 'claude', 'running', 'now', 'now')").run();
      db.prepare(`INSERT INTO terminals (terminal_id, session_id, run_id, kind, handle, worktree_path, log_path, state, created_at, updated_at)
        VALUES ('provider:session-master', 'session-master', NULL, 'provider', 'tmux:master', '/repo', '/log', 'running', 'now', 'now')`).run();
      const message = db.prepare(`INSERT INTO messages (message_id, run_id, idempotency_key, direction, kind, payload, created_at, recipient_id, recipient_session_id, recipient_agent_id)
        VALUES (?, NULL, ?, 'outbound', 'message', '{}', 'now', 'master', ?, ?)`);
      message.run('msg-1', 'k-1', 'session-master', null);
      message.run('msg-2', 'k-2', null, 'master');
      expect(() => message.run('msg-3', 'k-3', 'session-master', 'master')).toThrow(/CHECK/);
      expect(() => message.run('msg-4', 'k-4', null, null)).toThrow(/CHECK/);
      expect(() => db.prepare("UPDATE sessions SET exit_reason = 'exploded' WHERE session_id = 'session-master'").run()).toThrow(/CHECK/);
      db.prepare("UPDATE sessions SET exit_reason = 'user_exit', generation = 1, resume_count = 1 WHERE session_id = 'session-master'").run();
      expect(db.prepare('SELECT count(*) AS n FROM messages WHERE run_id IS NULL').get()).toEqual({ n: 2 });
    } finally {
      db.close();
    }
  });
});
