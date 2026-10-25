import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSequencedEvent, closeAllDatabases } from './eventLog.ts';
import { closeMemoryDb } from './memoryStore.ts';
import { MIGRATION_MARKER, MIGRATION_RECORD, resolveActiveProject } from './projectContext.ts';
import { migrateLegacyInstallation, migrationCleanupReport, planMigration } from './projectMigration.ts';
import { ProjectRegistry } from './projectRegistry.ts';
import { closeProjectTaskStores, createProjectTask, initProjectTaskStore, projectTaskStoreFor } from './projectTasks.ts';
import { ensureStateInitialized } from './stateInit.ts';

let temp: string;
let dataHome: string;
let registry: ProjectRegistry;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' });
}

function gitRepo(name: string): string {
  const root = join(temp, name);
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'README.md'), 'product\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'initial');
  return realpathSync(root);
}

function spec(ref: string, status: string, extra = ''): string {
  return `---\nref: ${ref}\nfeature: ${ref.split('/')[0]}\nstatus: ${status}\npriority: normal\n${extra}---\n\n# Task ${ref.split('/')[1].split('-')[0]} — ${ref.split('/')[1]}\n\n## Acceptance criteria\n\n- [ ] works\n`;
}

const PLAN = `---
plan_id: 1
name: alpha-plan
title: Alpha plan
created_at: 2026-01-01T00:00:00Z
updated_at: 2026-01-01T00:00:00Z
derived_task_refs: []
---

# Alpha plan

## Objective

Ship alpha.

## Scope

Alpha only.

## Out of Scope

Beta.

## Constraints

None.

## Affected Areas

lib/alpha.ts

## Implementation Steps

### Step 1 — Build alpha

Write the alpha module.
`;

/** A legacy attached installation: state, specs, plans and config inside the product repo. */
function legacyInstallation(root: string, { claims = [] as unknown[] } = {}): string {
  const stateDir = join(root, '.orc-state');
  ensureStateInitialized(stateDir);
  writeFileSync(join(stateDir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'alpha', title: 'Alpha', tasks: [
        // Runtime done; the spec still says todo (a stale mirror).
        { ref: 'alpha/1-first', title: 'first', status: 'done', task_type: 'implementation', attempt_count: 1, created_at: '2026-01-01T00:00:00.000Z' },
        { ref: 'alpha/2-second', title: 'second', status: 'blocked', blocked_reason: 'needs input', task_type: 'implementation', depends_on: ['alpha/1-first'] },
        // No spec file: rebuilt from runtime fields.
        { ref: 'alpha/runtime-only', title: 'Runtime only', status: 'todo', description: 'from runtime', task_type: 'implementation', owner: 'orc-1', planning_state: 'ready_for_dispatch' },
      ],
    }],
  }));
  writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({ version: '1', claims: [
    { run_id: 'run-1', task_ref: 'alpha/1-first', agent_id: 'orc-1', state: 'done', claimed_at: '2026-01-01T00:00:00.000Z' },
    ...claims,
  ] }));
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({ version: '1', agents: [{ agent_id: 'orc-1', provider: 'claude', status: 'running', session_handle: 'tmux:orc-1', session_token: 'secret', role: 'worker', capabilities: [] }] }));
  appendSequencedEvent(stateDir, { ts: '2026-01-01T00:00:01.000Z', event: 'task_added', actor_type: 'human', actor_id: 'human', task_ref: 'alpha/1-first', payload: { title: 'first' } } as never);
  closeAllDatabases();
  closeMemoryDb();
  mkdirSync(join(root, 'backlog', 'legacy'), { recursive: true });
  writeFileSync(join(root, 'backlog', '1-first.md'), spec('alpha/1-first', 'todo'));
  writeFileSync(join(root, 'backlog', '2-second.md'), spec('alpha/2-second', 'blocked', 'depends_on:\n  - alpha/1-first\n'));
  // Not yet in runtime: the coordinator's next sync would add it from the spec.
  writeFileSync(join(root, 'backlog', '3-third.md'), spec('alpha/3-third', 'todo'));
  writeFileSync(join(root, 'backlog', 'TASK_TEMPLATE.md'), '# Template\n');
  mkdirSync(join(root, 'plans'));
  writeFileSync(join(root, 'plans', '1-alpha-plan.md'), PLAN);
  writeFileSync(join(root, 'orc-state.config.json'), JSON.stringify({ default_provider: 'claude', worker_pool: { max_workers: 3, model: null }, unknown_key: 1 }));
  return stateDir;
}

/** Content hashes of every file under a directory, to prove a dry run writes nothing. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    if (name.startsWith('.git/') || name === '.git' || statSync(path).isDirectory() || /\.db-(wal|shm)$/.test(name)) continue;
    files[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return files;
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'orc-migrate-test-'));
  dataHome = join(temp, 'data');
  registry = new ProjectRegistry(dataHome);
});

afterEach(() => {
  closeProjectTaskStores();
  closeAllDatabases();
  closeMemoryDb();
  registry.close();
  rmSync(temp, { recursive: true, force: true });
});

describe('legacy installation migration', () => {
  it('dry-runs an inventory with conflicts and writes nothing', () => {
    const root = gitRepo('product');
    legacyInstallation(root);
    const before = snapshot(root);
    const result = migrateLegacyInstallation(root, registry);
    expect(result.status).toBe('dry_run');
    expect(result.inventory.source).toMatchObject({ layout: 'attached', target_repo_root: root });
    expect(result.inventory.tasks).toEqual({ total: 4, by_status: { done: 1, blocked: 1, todo: 2 }, from_specs: 3, from_archived_specs: 0, runtime_only: 1 });
    expect(result.inventory.plans.importable).toBe(1);
    expect(result.inventory.runs).toMatchObject({ claims: 1, active_claims: 0 });
    expect(result.inventory.databases['events.db']?.events).toBe(1);
    expect(result.inventory.settings).toEqual({ importable: { default_provider: 'claude', 'worker_pool.max_workers': 3 }, skipped: ['unknown_key'] });
    const codes = result.inventory.issues.map((issue) => `${issue.severity}:${issue.code}:${issue.ref ?? ''}`);
    expect(codes).toContain('warning:status_conflict:alpha/1-first');
    expect(codes).toContain('warning:runtime_only:alpha/runtime-only');
    expect(result.inventory.blocking).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(registry.list()).toEqual([]);
  });

  it('migrates, keeping runtime status over stale frontmatter, history and settings, then cuts over', () => {
    const root = gitRepo('product');
    const legacyState = legacyInstallation(root);
    const before = snapshot(root);
    const result = migrateLegacyInstallation(root, registry, { execute: true, name: 'product' });
    expect(result.status).toBe('migrated');
    const project = result.project!;
    expect(project).toMatchObject({ name: 'product', canonicalGitRoot: root });

    const store = projectTaskStoreFor(project.stateDir)!;
    const tasks = Object.fromEntries(store.listTasks().map((task) => [task.ref, task]));
    expect(tasks['alpha/1-first']).toMatchObject({ status: 'done', attemptCount: 1, createdAt: '2026-01-01T00:00:00.000Z', revision: 1 });
    expect(tasks['alpha/2-second']).toMatchObject({ status: 'blocked', blockedReason: 'needs input', dependsOn: ['alpha/1-first'] });
    expect(tasks['alpha/3-third'].status).toBe('todo');
    expect(tasks['alpha/runtime-only']).toMatchObject({ status: 'todo', dispatch: { owner: 'orc-1', planningState: 'ready_for_dispatch' } });
    expect(tasks['alpha/runtime-only'].bodyMarkdown).toContain('from runtime');
    expect(store.listImports('alpha/1-first')[0].sourcePath).toBe(join(root, 'backlog', '1-first.md'));
    const transitions = store.withDatabase((db) => db.prepare("SELECT task_ref, cause, to_status FROM task_transitions ORDER BY task_ref").all());
    expect(transitions).toEqual([
      { task_ref: 'alpha/1-first', cause: 'migration_import', to_status: 'done' },
      { task_ref: 'alpha/2-second', cause: 'migration_import', to_status: 'blocked' },
    ]);
    expect(store.listPlans().map((plan) => plan.planId)).toEqual([1]);
    expect(registry.settings(project.id)).toEqual({ default_provider: 'claude', 'worker_pool.max_workers': 3 });

    // History is copied; legacy sessions are not carried over.
    expect(JSON.parse(readFileSync(join(project.stateDir, 'claims.json'), 'utf8')).claims).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(project.stateDir, 'agents.json'), 'utf8')).agents[0]).toMatchObject({ agent_id: 'orc-1', status: 'offline', session_handle: null, session_token: null });
    expect(JSON.parse(readFileSync(join(project.stateDir, 'backlog.json'), 'utf8')).features[0].tasks).toHaveLength(4);
    expect(existsSync(join(result.backup_dir!, 'state', 'events.db'))).toBe(true);
    expect(existsSync(join(result.backup_dir!, 'backlog', '1-first.md'))).toBe(true);

    // The legacy installation only gains its marker; nothing is deleted.
    const after = snapshot(root);
    const marker = join('.orc-state', MIGRATION_MARKER);
    expect(Object.keys(after).filter((file) => !(file in before))).toEqual([marker]);
    expect({ ...after, [marker]: undefined }).toEqual({ ...before, [marker]: undefined });
    expect(JSON.parse(readFileSync(join(legacyState, MIGRATION_MARKER), 'utf8'))).toMatchObject({ project_id: project.id });
    expect(JSON.parse(readFileSync(join(project.stateDir, MIGRATION_RECORD), 'utf8'))).toMatchObject({ status: 'cut_over', attempts: 1 });

    // The repository, legacy layout and all, now selects the project.
    expect(resolveActiveProject({ ORC_DATA_HOME: dataHome }, root)).toMatchObject({ id: project.id, stateDir: project.stateDir, source: 'cwd' });
    expect(resolveActiveProject({ ORC_DATA_HOME: dataHome }, join(root, 'backlog'))).toMatchObject({ id: project.id });

    // A repeated run changes nothing.
    const again = migrateLegacyInstallation(root, registry, { execute: true });
    expect(again.status).toBe('already_migrated');
    expect(store.listTasks()).toHaveLength(4);
    expect(registry.list()).toHaveLength(1);
  });

  it('refuses to execute while a run is active or a definition conflicts', () => {
    const root = gitRepo('product');
    legacyInstallation(root, { claims: [{ run_id: 'run-2', task_ref: 'alpha/3-third', agent_id: 'orc-1', state: 'in_progress' }] });
    writeFileSync(join(root, 'backlog', '9-dup.md'), spec('alpha/2-second', 'todo'));
    const result = migrateLegacyInstallation(root, registry, { execute: true });
    expect(result.status).toBe('blocked');
    expect(result.inventory.issues.filter((issue) => issue.severity === 'blocking').map((issue) => issue.code).sort()).toEqual(['active_claim', 'duplicate_ref']);
    expect(registry.list()).toEqual([]);
  });

  it('keeps an interrupted migration inactive and finishes it on retry without duplicating anything', () => {
    const root = gitRepo('product');
    legacyInstallation(root);
    // An earlier attempt registered the project and stopped mid-import.
    const project = registry.add(root);
    writeFileSync(join(project.stateDir, MIGRATION_RECORD), JSON.stringify({ status: 'importing', project_id: project.id, source_state_dir: join(root, '.orc-state'), attempts: 1, backup_dir: null }));
    expect(resolveActiveProject({ ORC_DATA_HOME: dataHome }, temp)).toBeNull();
    expect(() => resolveActiveProject({ ORC_DATA_HOME: dataHome, ORC_PROJECT_ID: project.id }, temp)).toThrow('still being migrated');

    const result = migrateLegacyInstallation(root, registry, { execute: true });
    expect(result.status).toBe('migrated');
    expect(result.project!.id).toBe(project.id);
    expect(projectTaskStoreFor(project.stateDir)!.listTasks()).toHaveLength(4);
    expect(JSON.parse(readFileSync(join(project.stateDir, MIGRATION_RECORD), 'utf8'))).toMatchObject({ status: 'cut_over', attempts: 2 });
  });

  it('refuses to merge into a registered project that already has its own tasks', () => {
    const root = gitRepo('product');
    legacyInstallation(root);
    const project = registry.add(root);
    initProjectTaskStore(project.stateDir);
    createProjectTask(project.stateDir, { feature: 'beta', title: 'Own work' });
    closeProjectTaskStores();
    const result = planMigration(root, registry);
    expect(result.inventory.issues.map((issue) => issue.code)).toContain('project_in_use');
  });

  it('migrates a sibling layout to its target repository and selects it from either root', () => {
    const target = gitRepo('product');
    const home = gitRepo('orch-home');
    legacyInstallation(home);
    writeFileSync(join(home, 'orc-state.config.json'), JSON.stringify({ target_repo: '../product', default_provider: 'codex' }));
    const result = migrateLegacyInstallation(home, registry, { execute: true });
    expect(result.status).toBe('migrated');
    expect(result.inventory.source.layout).toBe('sibling');
    expect(result.project!.canonicalGitRoot).toBe(target);
    expect(registry.settings(result.project!.id)).toEqual({ default_provider: 'codex' });
    expect(resolveActiveProject({ ORC_DATA_HOME: dataHome }, home)).toMatchObject({ id: result.project!.id, targetRepoRoot: target });
    expect(resolveActiveProject({ ORC_DATA_HOME: dataHome }, target)).toMatchObject({ id: result.project!.id });
    expect(readdirSync(target).sort()).toEqual(['.git', 'README.md']);
  });

  it('reports what is left to clean up only after the cutover, and deletes nothing', () => {
    const root = gitRepo('product');
    legacyInstallation(root);
    writeFileSync(join(root, '.gitignore'), '.orc-state/\n.worktrees\n');
    mkdirSync(join(root, '.worktrees'));
    git(root, 'worktree', 'add', '-qb', 'task/run-1', join(root, '.worktrees', 'run-1'));
    expect(() => migrationCleanupReport(root, registry)).toThrow('has not been migrated');
    migrateLegacyInstallation(root, registry, { execute: true });
    const report = migrationCleanupReport(root, registry);
    expect(report.items.map((item) => item.kind)).toEqual(['git_worktree', 'worktrees_dir', 'state_dir', 'backlog_dir', 'plans_dir', 'config_file', 'gitignore_entry']);
    expect(report.commands[0]).toBe(`git -C '${root}' worktree remove '${join(root, '.worktrees', 'run-1')}'`);
    expect(existsSync(join(root, '.orc-state'))).toBe(true);
    expect(existsSync(join(root, '.worktrees', 'run-1'))).toBe(true);
  });
});
