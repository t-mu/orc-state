import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, queryEvents } from './eventLog.ts';
import { closeProjectTaskStores, createProjectTask, initProjectTaskStore } from './projectTasks.ts';
import { migrateProjectTaskSchema, RevisionConflictError } from './projectTaskStore.ts';
import { exportPlanMarkdown, exportTaskMarkdown, importPlanMarkdown, importTaskMarkdown, parseFrontmatter, renderTaskMarkdown } from './taskMarkdown.ts';

let dir: string;
let outside: string;

const SPEC = `---
ref: app/12-login
feature: app
status: todo
priority: high
review_level: light
depends_on:
  - app/11-setup
---

# Task 12 — Add login

Implement it.

## Acceptance criteria

- [ ] Users can log in
`;

beforeEach(() => {
  dir = createTempStateDir('orc-markdown-');
  outside = createTempStateDir('orc-markdown-outside-');
  seedState(dir);
  initProjectTaskStore(dir);
});

afterEach(() => {
  closeProjectTaskStores();
  closeAllDatabases();
  cleanupTempStateDir(dir);
  cleanupTempStateDir(outside);
});

describe('Markdown task import', () => {
  it('parses the spec frontmatter subset and rejects malformed blocks', () => {
    expect(parseFrontmatter('---\na: 1\nlist:\n  - x\n  - "y"\nempty: []\n---\nbody', 'f')).toEqual({ frontmatter: { a: '1', list: ['x', 'y'], empty: [] }, body: 'body' });
    expect(parseFrontmatter('no frontmatter', 'f')).toBeNull();
    expect(() => parseFrontmatter('---\n  - orphan\n---\n', 'f')).toThrow('outside a list');
    expect(() => parseFrontmatter('---\na: 1\na: 2\n---\n', 'f')).toThrow('duplicate');
  });

  it('imports a file from outside any repository without carrying lifecycle status', () => {
    const file = join(outside, 'login.md');
    writeFileSync(file, SPEC);
    const result = importTaskMarkdown(dir, file);
    expect(result.imported).toEqual([{ path: file, ref: 'app/12-login', action: 'created', revision: 1, ignored_fields: ['status'] }]);
    const task = initProjectTaskStore(dir).getTask('app/12-login')!;
    expect(task).toMatchObject({ title: 'Add login', status: 'todo', priority: 'high', dependsOn: ['app/11-setup'], metadata: { review_level: 'light', acceptance_criteria: ['Users can log in'] } });
    expect(task.bodyMarkdown.startsWith('# Task 12')).toBe(true);
    expect(initProjectTaskStore(dir).listImports('app/12-login')).toMatchObject([{ revision: 1, sourcePath: file }]);
    expect(() => importTaskMarkdown(dir, file, { strict: true })).toThrow('lifecycle field(s) status');
  });

  it('refuses to create a todo task from a spec that is already finished or blocked', () => {
    const file = join(outside, 'done.md');
    writeFileSync(file, SPEC.replace('status: todo', 'status: done'));
    expect(() => importTaskMarkdown(dir, file)).toThrow('has status done');
    expect(initProjectTaskStore(dir).getTask('app/12-login')).toBeNull();
  });

  it('rejects a named file that is not a task spec', () => {
    writeFileSync(join(outside, 'notes.md'), '# Notes\n');
    expect(() => importTaskMarkdown(dir, join(outside, 'notes.md'))).toThrow('not a task spec');
  });

  it('rolls back the whole import when a later file fails validation', () => {
    const backlog = join(outside, 'mixed');
    mkdirSync(backlog);
    writeFileSync(join(backlog, '1-good.md'), '---\nref: app/1-good\nfeature: app\n---\n# Good\n');
    writeFileSync(join(backlog, '2-bad.md'), '---\nref: app/2-bad\nfeature: app\npriority: urgent\n---\n# Bad\n');
    expect(() => importTaskMarkdown(dir, backlog)).toThrow('Invalid priority');
    expect(initProjectTaskStore(dir).listTasks()).toEqual([]);
    expect(queryEvents(dir, { event_type: 'task_added' })).toHaveLength(0);
  });

  it('never resets or completes runtime status on re-import', () => {
    const file = join(outside, 'login.md');
    writeFileSync(file, SPEC);
    importTaskMarkdown(dir, file);
    const store = initProjectTaskStore(dir);
    store.transition('app/12-login', 'claim', 'claimed');
    store.transition('app/12-login', 'run_start', 'in_progress');
    store.transition('app/12-login', 'merge_succeeded', 'done');
    writeFileSync(file, SPEC.replace('status: done', 'status: todo').replace('Implement it.', 'Implement it again.'));
    expect(importTaskMarkdown(dir, file).imported[0]).toMatchObject({ action: 'revised', revision: 2 });
    expect(store.getTask('app/12-login')).toMatchObject({ status: 'done', revision: 2 });
  });

  it('imports a directory, skipping templates and notes, and validates every file before writing', () => {
    const backlog = join(outside, 'backlog');
    mkdirSync(join(backlog, 'nested'), { recursive: true });
    writeFileSync(join(backlog, '12-login.md'), SPEC);
    writeFileSync(join(backlog, 'TASK_TEMPLATE.md'), '---\nref: <feature>/<slug>\n---\n# Template\n');
    writeFileSync(join(backlog, 'notes.md'), '# Just notes\n');
    writeFileSync(join(backlog, 'plan-notes.md'), '---\ndescription: >\n  folded text\n---\n# Not a spec\n');
    mkdirSync(join(backlog, 'legacy'));
    writeFileSync(join(backlog, 'legacy', '1-old.md'), '---\nref: app/1-old\nfeature: app\n---\n# Archived\n');
    writeFileSync(join(backlog, 'nested', '13-logout.md'), '---\nref: app/13-logout\nfeature: app\n---\n# Logout\n');
    const result = importTaskMarkdown(dir, backlog);
    expect(result.imported.map((entry) => entry.ref)).toEqual(['app/12-login', 'app/13-logout']);
    expect(result.skipped).toHaveLength(3);

    writeFileSync(join(backlog, 'zz-bad.md'), '---\nref: app/bad\nfeature: other\n---\n# Bad\n');
    writeFileSync(join(backlog, '12-login.md'), SPEC.replace('Implement it.', 'Changed.'));
    expect(() => importTaskMarkdown(dir, backlog)).toThrow('does not belong to feature');
    expect(initProjectTaskStore(dir).getTask('app/12-login')?.revision).toBe(1);
  });
});

describe('Markdown task export', () => {
  it('renders readable Markdown without status and round-trips without a new revision', () => {
    createProjectTask(dir, { feature: 'app', title: 'Database task', description: 'From SQLite only.', depends_on: ['app/other'], required_provider: 'codex' });
    const [written] = exportTaskMarkdown(dir, join(outside, 'export'));
    expect(written).toEqual({ ref: 'app/database-task', path: join(outside, 'export', 'app', 'database-task.md'), revision: 1 });
    const text = readFileSync(written.path, 'utf8');
    expect(text).toContain('ref: app/database-task\nfeature: app\ntitle: Database task\n');
    expect(text).toContain('depends_on:\n  - app/other\n');
    expect(text).toContain('required_provider: codex\ndepends_on:\n  - app/other\nrequired_capabilities: []\nspec_revision: 1\n');
    expect(text).not.toMatch(/^status:/m);
    expect(text).toContain('# Database task\n\nFrom SQLite only.\n');
    expect(importTaskMarkdown(dir, join(outside, 'export')).imported[0]).toMatchObject({ action: 'unchanged', revision: 1 });
    expect(exportTaskMarkdown(dir, join(outside, 'one.md'), { refs: ['app/database-task'] })[0].path).toBe(join(outside, 'one.md'));
    expect(() => exportTaskMarkdown(dir, join(outside, 'two.md'))).not.toThrow();
    createProjectTask(dir, { feature: 'app', title: 'Second' });
    expect(() => exportTaskMarkdown(dir, join(outside, 'two.md'))).toThrow('exactly one task');
  });

  it('uses an exported spec_revision as the expected revision so stale edits fail', () => {
    createProjectTask(dir, { feature: 'app', ref: 'stale', body_markdown: '# Stale\n\nv1\n' });
    const [{ path }] = exportTaskMarkdown(dir, join(outside, 'stale.md'), { refs: ['app/stale'] });
    const { task } = (() => {
      const store = initProjectTaskStore(dir);
      return store.reviseTask('app/stale', 1, { bodyMarkdown: '# Stale\n\nv2 by someone else\n' });
    })();
    expect(task.revision).toBe(2);
    writeFileSync(path, readFileSync(path, 'utf8').replace('v1', 'my edit'));
    expect(() => importTaskMarkdown(dir, path)).toThrow(RevisionConflictError);
    expect(renderTaskMarkdown(initProjectTaskStore(dir).getTask('app/stale')!)).toContain('v2 by someone else');
  });
});

describe('Markdown round trips', () => {
  it('treats an edited export as the full definition and stays idempotent when re-imported', () => {
    createProjectTask(dir, { feature: 'app', ref: 'edit', title: '"Fast" path: #1', body_markdown: '# Edit\n', depends_on: ['app/dep'], review_level: 'light' });
    const [{ path }] = exportTaskMarkdown(dir, join(outside, 'edit.md'), { refs: ['app/edit'] });
    expect(importTaskMarkdown(dir, path).imported[0]).toMatchObject({ action: 'unchanged', revision: 1 });
    const edited = readFileSync(path, 'utf8').replace('depends_on:\n  - app/dep\n', 'depends_on: []\n').replace('review_level: light\n', '');
    writeFileSync(path, edited);
    expect(importTaskMarkdown(dir, path).imported[0]).toMatchObject({ action: 'revised', revision: 2 });
    expect(importTaskMarkdown(dir, path).imported[0]).toMatchObject({ action: 'unchanged', revision: 2 });
    const task = initProjectTaskStore(dir).getTask('app/edit')!;
    expect(task).toMatchObject({ title: '"Fast" path: #1', dependsOn: [] });
    expect(task.metadata.review_level).toBeUndefined();
  });
});

describe('plan documents in project state', () => {
  it('imports a validated plan and exports it as readable Markdown', () => {
    const plan = readFileSync(join(import.meta.dirname, '..', 'plans', '3-global-project-state.md'), 'utf8');
    const source = join(outside, '3-global-project-state.md');
    writeFileSync(source, plan);
    expect(importPlanMarkdown(dir, source)).toEqual({ plan_id: 3, changed: true });
    expect(importPlanMarkdown(dir, source)).toEqual({ plan_id: 3, changed: false });
    const store = initProjectTaskStore(dir);
    expect(store.listPlans()).toMatchObject([{ planId: 3, name: 'global-project-state' }]);
    expect(store.getPlan(3)?.metadata).toMatchObject({ steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
    const exported = exportPlanMarkdown(dir, 3, join(outside, 'plans-out'));
    expect(exported).toBe(join(outside, 'plans-out', '3-global-project-state.md'));
    expect(readFileSync(exported, 'utf8')).toBe(plan);
    writeFileSync(join(outside, 'bad.md'), '---\nplan_id: 4\n---\n# nope\n');
    expect(() => importPlanMarkdown(dir, join(outside, 'bad.md'))).toThrow();
  });
});

describe('project task schema v2', () => {
  it('upgrades a version 1 database in place, keeping its tasks', () => {
    const path = join(outside, 'v1.db');
    const db = new Database(path);
    try {
      migrateProjectTaskSchema(db, 1);
      expect(db.pragma('user_version', { simple: true })).toBe(1);
      db.exec(`INSERT INTO tasks (ref, title, created_at, updated_at) VALUES ('app/old', 'Old', 'now', 'now');
        INSERT INTO task_transitions (task_ref, from_status, to_status, cause, created_at) VALUES ('app/old', 'todo', 'claimed', 'claim', 'now');`);
      expect(db.prepare("SELECT attempt_count FROM tasks WHERE ref = 'app/old'").get()).toEqual({ attempt_count: 1 });
      migrateProjectTaskSchema(db, 2);
      db.exec(`INSERT INTO task_spec_revisions (task_ref, revision, content_hash, body_markdown, title, metadata_json, created_at)
        VALUES ('app/old', 1, '${'0'.repeat(64)}', '# Old', 'Old', '{"owner":"worker-z","planning_state":"ready_for_dispatch","delegated_by":"master"}', 'now');`);
      migrateProjectTaskSchema(db);
      expect(db.pragma('user_version', { simple: true })).toBe(3);
      // Owner moves from revision metadata to its column; the version 2 claim no longer counts as an attempt.
      expect(db.prepare("SELECT status, attempt_count, owner, planning_state, delegated_by FROM tasks WHERE ref = 'app/old'").get())
        .toEqual({ status: 'claimed', attempt_count: 0, owner: 'worker-z', planning_state: 'ready_for_dispatch', delegated_by: 'master' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('task_imports','plan_documents') ORDER BY name").all())
        .toEqual([{ name: 'plan_documents' }, { name: 'task_imports' }]);
    } finally { db.close(); }
  });
});
