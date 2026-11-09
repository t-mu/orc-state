import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConflictError } from './domainErrors.ts';
import { migrateProjectTaskSchema, PROJECT_TASK_SCHEMA_VERSION, ProjectTaskStore } from './projectTaskStore.ts';

let dir: string;
let store: ProjectTaskStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-project-tasks-'));
  store = new ProjectTaskStore(join(dir, 'project-a'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('project task SQLite schema', () => {
  it('stores a database-only Markdown spec and indexed metadata independently per project', () => {
    store.createTask({ ref: 'feature/1', title: 'First', bodyMarkdown: '# First\n\nFull instructions.\n', priority: 'high', requiredProvider: 'codex', metadata: { review_level: 'full' }, dependsOn: ['feature/2'] });
    expect(store.getTask('feature/1')).toMatchObject({
      ref: 'feature/1', title: 'First', status: 'todo', attemptCount: 0,
      revision: 1, bodyMarkdown: '# First\n\nFull instructions.\n',
      metadata: { review_level: 'full' }, dependsOn: ['feature/2'],
    });
    expect(store.getTask('feature/1')?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.withDatabase((db) => db.prepare("SELECT priority, required_provider FROM tasks WHERE ref = 'feature/1'").get()))
      .toEqual({ priority: 'high', required_provider: 'codex' });
    const second = new ProjectTaskStore(join(dir, 'project-b'));
    try { expect(second.getTask('feature/1')).toBeNull(); }
    finally { second.close(); }
    expect(() => store.createTask({ ref: 'feature/1', title: 'Duplicate', bodyMarkdown: 'x' })).toThrow();
  });

  it('keeps revisions and refs immutable and rejects bad dependencies', () => {
    store.createTask({ ref: 'feature/1', title: 'First', bodyMarkdown: '# First' });
    store.withDatabase((db) => {
      expect(() => db.prepare("UPDATE tasks SET ref = 'feature/renamed' WHERE ref = 'feature/1'").run()).toThrow('immutable');
      expect(() => db.prepare("UPDATE task_spec_revisions SET body_markdown = 'changed' WHERE task_ref = 'feature/1'").run()).toThrow('immutable');
      expect(() => db.prepare("DELETE FROM task_spec_revisions WHERE task_ref = 'feature/1'").run()).toThrow('immutable');
      expect(() => db.prepare("INSERT INTO task_dependencies (task_ref, depends_on_ref) VALUES ('feature/1','feature/1')").run()).toThrow();
    });
  });

  it('enforces lifecycle transitions, reason and attempt tracking at the database boundary', () => {
    store.createTask({ ref: 'feature/1', title: 'First', bodyMarkdown: '# First' });
    expect(() => store.transition('feature/1', 'merge_succeeded', 'done')).toThrow('invalid task transition');
    // A refused move is a typed conflict naming the transition, not a raw SQLite abort.
    expect(() => store.transition('feature/1', 'merge_succeeded', 'done'))
      .toThrow(expect.objectContaining({ name: 'ConflictError', message: 'invalid task transition for feature/1: todo -> done (cause merge_succeeded)' }));
    expect(() => store.transition('feature/1', 'merge_succeeded', 'done')).toThrow(ConflictError);
    expect(() => store.transition('feature/1', 'manual_block', 'blocked')).toThrow();
    store.transition('feature/1', 'claim', 'claimed');
    // Attempts follow the failure policy and are set by lifecycle writers, not by the claim itself.
    expect(store.getTask('feature/1')).toMatchObject({ status: 'claimed', attemptCount: 0 });
    store.transition('feature/1', 'run_start', 'in_progress');
    // Other store failures, here a missing block reason, stay raw SQLite errors.
    expect(() => store.transition('feature/1', 'failure_block', 'blocked', '')).toThrow(Database.SqliteError);
    store.transition('feature/1', 'failure_block', 'blocked', 'Needs credential');
    expect(store.getTask('feature/1')).toMatchObject({ status: 'blocked', blockedReason: 'Needs credential' });
    store.transition('feature/1', 'unblock', 'todo');
    expect(store.getTask('feature/1')).toMatchObject({ status: 'todo', blockedReason: null });
    store.withDatabase((db) => {
      expect(() => db.prepare("UPDATE tasks SET status = 'done' WHERE ref = 'feature/1'").run()).toThrow('requires a transition');
      expect(() => db.prepare("DELETE FROM task_transitions WHERE task_ref = 'feature/1'").run()).toThrow('immutable');
    });
  });

  it('carries a migrated status only as a task\'s first transition', () => {
    store.createTask({ ref: 'feature/1', title: 'First', bodyMarkdown: '# First' });
    store.transition('feature/1', 'migration_import', 'done');
    expect(store.getTask('feature/1')?.status).toBe('done');
    store.transition('feature/1', 'operator_reset', 'todo');
    // Replaying a migration cannot complete the reopened task again.
    expect(() => store.transition('feature/1', 'migration_import', 'done')).toThrow('invalid task transition');
    store.createTask({ ref: 'feature/2', title: 'Second', bodyMarkdown: '# Second' });
    expect(() => store.transition('feature/2', 'migration_import', 'claimed')).toThrow('invalid task transition');
    store.createTask({ ref: 'feature/3', title: 'Third', bodyMarkdown: '# Third' });
    expect(() => store.transition('feature/3', 'migration_import', 'blocked')).toThrow();
  });

  it('migrates a released task to done and rejects released afterwards', () => {
    const db = new Database(':memory:');
    try {
      migrateProjectTaskSchema(db, 4);
      db.prepare("INSERT INTO tasks (ref, title, created_at, updated_at) VALUES ('feature/1','First','now','now')").run();
      db.prepare("INSERT INTO tasks (ref, title, created_at, updated_at) VALUES ('feature/2','Second','now','now')").run();
      db.prepare("INSERT INTO task_transitions (task_ref, from_status, to_status, cause, created_at) VALUES ('feature/1','todo','released','migration_import','now')").run();
      expect(db.prepare("SELECT status FROM tasks WHERE ref = 'feature/1'").get()).toEqual({ status: 'released' });
      migrateProjectTaskSchema(db);
      expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_TASK_SCHEMA_VERSION);
      expect(db.prepare('SELECT ref, status FROM tasks ORDER BY ref').all()).toEqual([{ ref: 'feature/1', status: 'done' }, { ref: 'feature/2', status: 'todo' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(() => db.prepare("UPDATE tasks SET status = 'released' WHERE ref = 'feature/2'").run()).toThrow();
      expect(() => db.prepare("INSERT INTO task_transitions (task_ref, from_status, to_status, cause, created_at) VALUES ('feature/2','todo','released','migration_import','now')").run()).toThrow('invalid task transition');
      expect(() => db.prepare("INSERT INTO task_transitions (task_ref, from_status, to_status, cause, created_at) VALUES ('feature/1','done','released','post_merge_release','now')").run()).toThrow('invalid task transition');
      // The rebuilt table keeps its guards.
      expect(() => db.prepare("UPDATE tasks SET status = 'blocked' WHERE ref = 'feature/2'").run()).toThrow('requires a transition');
      expect(() => db.prepare("UPDATE tasks SET ref = 'x' WHERE ref = 'feature/2'").run()).toThrow('immutable');
    } finally { db.close(); }
  });

  it('pins runs to revisions and prevents two active claims for one task', () => {
    store.createTask({ ref: 'feature/1', title: 'First', bodyMarkdown: '# First' });
    store.withDatabase((db) => {
      db.prepare("INSERT INTO task_runs (run_id, task_ref, spec_revision, state, created_at, updated_at) VALUES ('run-1','feature/1',1,'claimed','now','now')").run();
      expect(() => db.prepare("UPDATE task_runs SET spec_revision = 2 WHERE run_id = 'run-1'").run()).toThrow('immutable');
      expect(() => db.prepare("UPDATE task_runs SET task_ref = 'feature/other' WHERE run_id = 'run-1'").run()).toThrow('immutable');
      expect(() => db.prepare("INSERT INTO task_runs (run_id, task_ref, spec_revision, state, created_at, updated_at) VALUES ('run-2','feature/1',1,'claimed','now','now')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO task_runs (run_id, task_ref, spec_revision, state, created_at, updated_at) VALUES ('run-3','feature/1',2,'failed','now','now')").run()).toThrow();
      db.prepare("UPDATE task_runs SET state = 'failed' WHERE run_id = 'run-1'").run();
      db.prepare("INSERT INTO task_runs (run_id, task_ref, spec_revision, state, created_at, updated_at) VALUES ('run-2','feature/1',1,'claimed','now','now')").run();
    });
  });

  it('migrates once, rejects future versions, and rolls back a failed schema migration', () => {
    const path = join(dir, 'project-a', 'runtime.db');
    store.close();
    const db = new Database(path);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(PROJECT_TASK_SCHEMA_VERSION);
      migrateProjectTaskSchema(db);
      expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 6 });
      db.pragma('user_version = 7');
      expect(() => migrateProjectTaskSchema(db)).toThrow('needs code of schema 7 or newer');
    } finally { db.close(); }
    const broken = new Database(join(dir, 'broken.db'));
    try {
      broken.exec('CREATE TABLE tasks (ref TEXT)');
      expect(() => migrateProjectTaskSchema(broken)).toThrow();
      expect(broken.pragma('user_version', { simple: true })).toBe(0);
      expect(broken.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    } finally { broken.close(); }
    store = new ProjectTaskStore(join(dir, 'project-b'));
  });
});
