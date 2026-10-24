import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(() => store.transition('feature/1', 'manual_block', 'blocked')).toThrow();
    store.transition('feature/1', 'claim', 'claimed');
    expect(store.getTask('feature/1')).toMatchObject({ status: 'claimed', attemptCount: 1 });
    store.transition('feature/1', 'run_start', 'in_progress');
    expect(() => store.transition('feature/1', 'failure_block', 'blocked', '')).toThrow();
    store.transition('feature/1', 'failure_block', 'blocked', 'Needs credential');
    expect(store.getTask('feature/1')).toMatchObject({ status: 'blocked', blockedReason: 'Needs credential' });
    store.transition('feature/1', 'unblock', 'todo');
    expect(store.getTask('feature/1')).toMatchObject({ status: 'todo', blockedReason: null });
    store.withDatabase((db) => {
      expect(() => db.prepare("UPDATE tasks SET status = 'done' WHERE ref = 'feature/1'").run()).toThrow('requires a transition');
      expect(() => db.prepare("DELETE FROM task_transitions WHERE task_ref = 'feature/1'").run()).toThrow('immutable');
    });
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
      expect(db.prepare('SELECT count(*) AS count FROM schema_migrations').get()).toEqual({ count: 1 });
      db.pragma('user_version = 2');
      expect(() => migrateProjectTaskSchema(db)).toThrow('newer');
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
