import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRegistry, type ProjectRecord } from './projectRegistry.ts';
import { closeProjectTaskStores, initProjectTaskStore } from './projectTasks.ts';

const PROBE = join(import.meta.dirname, '..', 'test-fixtures', 'projectModeProbe.ts');
let temp: string;
let repo: string;
let dataHome: string;
let project: ProjectRecord;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

function probe(cwd: string, env: Record<string, string> = {}, action = 'paths'): Record<string, unknown> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
  const output = execFileSync(process.execPath, [PROBE, action], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...clean, ORC_DATA_HOME: dataHome, ORC_SESSION_TRANSPORT: 'pty', ...env },
  });
  return JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-project-mode-')));
  repo = join(temp, 'product');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Product\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  dataHome = join(temp, 'data');
  const registry = new ProjectRegistry(dataHome);
  try {
    project = registry.add(repo, 'product');
    registry.setSetting('worker_pool.max_workers', 3, project.id);
  } finally {
    registry.close();
  }
  initProjectTaskStore(project.stateDir);
  closeProjectTaskStores();
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe('project mode against a registered target repository', () => {
  it('selects the project from the current repository and keeps every harness path outside it', () => {
    const paths = probe(repo);
    expect(paths).toMatchObject({
      project: { id: project.id, source: 'cwd', targetRepoRoot: repo },
      stateDir: project.stateDir, targetRepoRoot: repo, worktreesDir: join(project.stateDir, 'worktrees'),
      configFile: join(project.stateDir, 'orc-state.config.json'), sibling: false,
    });
    const elsewhere = join(temp, 'elsewhere');
    mkdirSync(elsewhere);
    expect(probe(elsewhere, { ORC_PROJECT_ID: project.id })).toMatchObject({ project: { id: project.id, source: 'environment' }, stateDir: project.stateDir });
    expect(probe(elsewhere)).toMatchObject({ project: null });
  });

  it('leaves a repository with a legacy orc layout in legacy mode until it is migrated', () => {
    mkdirSync(join(repo, '.orc-state'));
    expect(probe(repo)).toMatchObject({ project: null, stateDir: join(repo, '.orc-state') });
    expect(probe(repo, { ORC_PROJECT_ID: project.id })).toMatchObject({ project: { id: project.id } });
  });

  it('fails clearly for an unregistered explicit project id', () => {
    expect(() => probe(repo, { ORC_PROJECT_ID: 'missing' })).toThrow('not a registered project');
  });

  it('launches CLI and structured-runtime workers from external worktrees without ORC_HOME or repo-local files', () => {
    const launch = probe(repo, {}, 'launch');
    const worktreePath = join(project.stateDir, 'worktrees', 'run-probe');
    expect(launch.worktree).toMatchObject({ worktree_path: worktreePath, branch: 'task/run-probe' });
    expect(git(repo, 'branch', '--list', 'task/run-probe').trim()).toContain('task/run-probe');
    expect(launch.env).toMatchObject({
      ORC_PROJECT_ID: project.id, ORC_HOME: '', ORC_REPO_ROOT: '', ORC_STATE_DIR: project.stateDir, ORC_SESSION_TOKEN: 'session-probe',
    });
    expect(String((launch.env as Record<string, string>).ORC_CONTROL_SOCKET)).toMatch(/\.sock$/);
    expect(launch.claudeCwd).toBe(worktreePath);
    expect(String(launch.claudeSettingsPath).startsWith(project.stateDir)).toBe(true);
    // Sandbox grants: the state dir and the target's .git write subtrees, never the target working tree.
    const allowWrite = launch.claudeAllowWrite as string[];
    expect(allowWrite[0]).toBe('.');
    expect(allowWrite).toContain(project.stateDir);
    expect(allowWrite.some((root) => root.startsWith(join(repo, '.git')))).toBe(true);
    expect(allowWrite).not.toContain(repo);
    expect((launch.codexArgs as string[]).join(' ')).toContain(project.stateDir);
    expect(launch.structuredRoots).toEqual(allowWrite.slice(1));
    expect(launch.maxWorkers).toBe(3);
    // Nothing was written into the target working tree.
    expect(readdirSync(repo).sort()).toEqual(['.git', 'README.md']);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });
});
