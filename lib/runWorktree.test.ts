import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;
let targetRoot: string;
let savedRepoRoot: string | undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  // vi.doMock registrations survive resetModules; clear any node:child_process
  // mock left by a prior test so real-git tests get the real spawnSync.
  vi.doUnmock('node:child_process');
  dir = createTempStateDir('orch-run-worktree-test-');
  process.env.ORC_STATE_DIR = dir;
  process.env.ORC_WORKTREES_DIR = join(dir, 'repo', '.worktrees');
  process.env.ORC_BACKLOG_DIR = join(dir, 'docs', 'backlog');
  process.env.ORC_PLANS_DIR = join(dir, 'plans');
  // Worktree git operations run against the TARGET repo root. ORC_REPO_ROOT
  // short-circuits TARGET_REPO_ROOT resolution, so it pins the target repo the
  // worktree is a worktree *of* — distinct from ORC_WORKTREES_DIR, which is
  // where the worktree files are placed (under the orchestration root).
  savedRepoRoot = process.env.ORC_REPO_ROOT;
  targetRoot = join(dir, 'target-repo');
  process.env.ORC_REPO_ROOT = targetRoot;
});

afterEach(() => {
  cleanupTempStateDir(dir);
  delete process.env.ORC_STATE_DIR;
  delete process.env.ORC_WORKTREES_DIR;
  delete process.env.ORC_BACKLOG_DIR;
  delete process.env.ORC_PLANS_DIR;
  if (savedRepoRoot !== undefined) process.env.ORC_REPO_ROOT = savedRepoRoot;
  else delete process.env.ORC_REPO_ROOT;
});

describe('ensureRunWorktree', () => {
  it('persists and reuses the same run worktree metadata', async () => {
    const worktreePath = join(dir, 'repo', '.worktrees', 'run-1');
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' }); // git worktree add

    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { ensureRunWorktree, getRunWorktree } = await import('./runWorktree.ts');

    const first = ensureRunWorktree(dir, {
      runId: 'run-1',
      taskRef: 'orch/task-148',
      agentId: 'orc-1',
    });
    expect(first.worktree_path).toBe(worktreePath);
    expect(first.branch).toBe('task/run-1');

    // The worktree is created as a worktree OF the target repo (cwd), while its
    // files live under the orchestration WORKTREES_DIR (the add path arg).
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'git', ['worktree', 'add', worktreePath, '-b', 'task/run-1'], expect.objectContaining({
      cwd: targetRoot,
    }));

    mkdirSync(first.worktree_path, { recursive: true });
    writeFileSync(join(first.worktree_path, '.git'), 'gitdir: /tmp/mock');
    const second = ensureRunWorktree(dir, {
      runId: 'run-1',
      taskRef: 'orch/task-148',
      agentId: 'orc-1',
    });

    expect(second).toMatchObject({
      run_id: 'run-1',
      worktree_path: worktreePath,
      branch: 'task/run-1',
    });
    // Second call reuses the valid worktree — no further git invocation.
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(getRunWorktree(dir, 'run-1')).toMatchObject({
      run_id: 'run-1',
      worktree_path: worktreePath,
      branch: 'task/run-1',
    });
    expect(existsSync(join(dir, 'run-worktrees.json'))).toBe(true);

    const persisted = JSON.parse(readFileSync(join(dir, 'run-worktrees.json'), 'utf8'));
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].worktree_path).toBe(worktreePath);
  });

  it('fails when the assigned path exists but is not a git worktree', async () => {
    const worktreePath = join(dir, 'repo', '.worktrees', 'run-2');
    const spawnSync = vi.fn();

    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { ensureRunWorktree } = await import('./runWorktree.ts');

    mkdirSync(worktreePath, { recursive: true });

    expect(() => ensureRunWorktree(dir, {
      runId: 'run-2',
      taskRef: 'orch/task-148',
      agentId: 'orc-1',
    })).toThrow('is not a git worktree');
    // The invalid-path guard trips before any git invocation.
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('deletes terminal run metadata and prunes missing inactive worktrees', async () => {
    writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
      version: '1',
      runs: [
        {
          run_id: 'run-1',
          task_ref: 'orch/task-148',
          agent_id: 'orc-1',
          branch: 'task/run-1',
          worktree_path: join(dir, 'repo', '.worktrees', 'run-1'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          run_id: 'run-2',
          task_ref: 'orch/task-149',
          agent_id: 'orc-1',
          branch: 'task/run-2',
          worktree_path: join(dir, 'repo', '.worktrees', 'run-2'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));

    const { deleteRunWorktree, pruneMissingRunWorktrees } = await import('./runWorktree.ts');

    expect(deleteRunWorktree(dir, 'run-1')).toBe(true);

    const pruned = pruneMissingRunWorktrees(dir, ['run-3']);
    expect(pruned).toBe(1);

    const persisted = JSON.parse(readFileSync(join(dir, 'run-worktrees.json'), 'utf8'));
    expect(persisted.runs).toHaveLength(0);
  });

  it('cleanupRunWorktree removes git worktree metadata and issues cleanup git commands', async () => {
    writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
      version: '1',
      runs: [
        {
          run_id: 'run-cleanup',
          task_ref: 'orch/task-151',
          agent_id: 'orc-1',
          branch: 'task/run-cleanup',
          worktree_path: join(dir, 'repo', '.worktrees', 'run-cleanup'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));
    mkdirSync(join(dir, 'repo', '.worktrees', 'run-cleanup'), { recursive: true });
    writeFileSync(join(dir, 'repo', '.worktrees', 'run-cleanup', '.git'), 'gitdir: /tmp/mock');

    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })  // git worktree remove
      .mockReturnValueOnce({ status: 0, stdout: '' });  // git branch -d
    vi.doMock('node:child_process', () => ({ spawnSync }));

    const { cleanupRunWorktree } = await import('./runWorktree.ts');
    expect(cleanupRunWorktree(dir, 'run-cleanup')).toBe(true);
    // Cleanup git ops run against the target repo (the worktree's owning repo).
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'git', ['worktree', 'remove', '--force', join(dir, 'repo', '.worktrees', 'run-cleanup')], expect.objectContaining({
      cwd: targetRoot,
      encoding: 'utf8',
    }));
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'git', ['branch', '-d', 'task/run-cleanup'], expect.objectContaining({
      cwd: targetRoot,
      encoding: 'utf8',
    }));

    const persisted = JSON.parse(readFileSync(join(dir, 'run-worktrees.json'), 'utf8'));
    expect(persisted.runs).toHaveLength(0);
  });

  it('cleanupRunWorktree warns and continues when worktree path is missing', async () => {
    writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
      version: '1',
      runs: [
        {
          run_id: 'run-missing-path',
          task_ref: 'orch/task-151',
          agent_id: 'orc-1',
          branch: 'task/run-missing-path',
          worktree_path: join(dir, 'repo', '.worktrees', 'run-missing-path'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' });  // git branch -d (remove skipped)
    vi.doMock('node:child_process', () => ({ spawnSync }));

    const { cleanupRunWorktree } = await import('./runWorktree.ts');
    expect(cleanupRunWorktree(dir, 'run-missing-path')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('worktree path not found'));
    // Only the branch delete runs; the missing worktree remove is skipped.
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenNthCalledWith(1, 'git', ['branch', '-d', 'task/run-missing-path'], expect.objectContaining({
      cwd: targetRoot,
    }));
  });

  it('respects ORC_WORKTREES_DIR env var for worktree path', async () => {
    const customWorktreesDir = join(dir, 'custom-worktrees');
    process.env.ORC_WORKTREES_DIR = customWorktreesDir;

    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' }); // git worktree add
    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { ensureRunWorktree } = await import('./runWorktree.ts');

    const result = ensureRunWorktree(dir, {
      runId: 'run-custom',
      taskRef: 'orch/task-161',
      agentId: 'orc-1',
    });
    expect(result.worktree_path).toBe(join(customWorktreesDir, 'run-custom'));
  });

  it('throws the underlying OS error when git spawn fails', async () => {
    vi.resetModules();
    const spawnError = new Error('spawnSync git ENOENT');
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: null, error: spawnError, stdout: '', stderr: '', pid: 0, output: [], signal: null });

    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { ensureRunWorktree } = await import('./runWorktree.ts');

    expect(() =>
      ensureRunWorktree(dir, { runId: 'run-fail', taskRef: 'general/26', agentId: 'orc-1' }),
    ).toThrow('spawnSync git ENOENT');
  });

  it('cleanupRunWorktree warns and returns when the run entry is missing', async () => {
    writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({ version: '1', runs: [] }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { cleanupRunWorktree } = await import('./runWorktree.ts');
    expect(cleanupRunWorktree(dir, 'run-unknown')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no entry found for run run-unknown'));
  });

  it('cleanupRunWorktree preserves metadata when git cleanup fails', async () => {
    writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
      version: '1',
      runs: [
        {
          run_id: 'run-branch-failure',
          task_ref: 'orch/task-151',
          agent_id: 'orc-1',
          branch: 'task/run-branch-failure',
          worktree_path: join(dir, 'repo', '.worktrees', 'run-branch-failure'),
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));
    mkdirSync(join(dir, 'repo', '.worktrees', 'run-branch-failure'), { recursive: true });
    writeFileSync(join(dir, 'repo', '.worktrees', 'run-branch-failure', '.git'), 'gitdir: /tmp/mock');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })              // git worktree remove
      .mockReturnValueOnce({ status: 1, stderr: 'branch delete failed' }); // git branch -d
    vi.doMock('node:child_process', () => ({ spawnSync }));

    const { cleanupRunWorktree } = await import('./runWorktree.ts');
    expect(cleanupRunWorktree(dir, 'run-branch-failure')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('branch delete failed'));

    const persisted = JSON.parse(readFileSync(join(dir, 'run-worktrees.json'), 'utf8'));
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].run_id).toBe('run-branch-failure');
  });
});

// Real-git integration: exercises the sibling layout end to end with two actual
// git repos — a target (product) repo and an orchestration root whose
// WORKTREES_DIR holds the worktree files. No child_process mock here.
describe('ensureRunWorktree (real git, sibling layout)', () => {
  let orchRoot: string;
  let target: string;

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  let stateDir: string;

  beforeEach(() => {
    // realpathSync: macOS tmpdir is a symlink; git reports resolved paths.
    orchRoot = realpathSync(dir);

    // Model the real sibling layout: orchRoot is itself a git repo holding
    // tracked framework files (AGENTS.md, backlog/) plus a real .orc-state, and
    // gitignoring the runtime dirs. The target-repo worktree is created NESTED
    // inside this orchestration repo's working tree.
    git(orchRoot, 'init', '-b', 'main');
    git(orchRoot, 'config', 'user.email', 'test@example.com');
    git(orchRoot, 'config', 'user.name', 'Test');
    writeFileSync(join(orchRoot, '.gitignore'), '.orc-state/\n.worktrees/\ntarget-repo/\n');
    writeFileSync(join(orchRoot, 'AGENTS.md'), '# Orchestration home\n');
    mkdirSync(join(orchRoot, 'backlog'), { recursive: true });
    writeFileSync(join(orchRoot, 'backlog', '1-task.md'), '# framework spec\n');
    mkdirSync(join(orchRoot, '.orc-state'), { recursive: true });
    git(orchRoot, 'add', '.gitignore', 'AGENTS.md', 'backlog/1-task.md');
    git(orchRoot, 'commit', '-m', 'orchestration home');

    // Separate target (product) repo.
    target = join(orchRoot, 'target-repo');
    mkdirSync(target, { recursive: true });
    git(target, 'init', '-b', 'main');
    git(target, 'config', 'user.email', 'test@example.com');
    git(target, 'config', 'user.name', 'Test');
    writeFileSync(join(target, 'product.txt'), 'product code\n');
    git(target, 'add', 'product.txt');
    git(target, 'commit', '-m', 'initial product commit');

    // Framework roots live under the orchestration home; git ops target the
    // product repo. ORC_STATE_DIR under orchRoot makes ORCHESTRATION_ROOT resolve
    // to orchRoot (parent of .orc-state).
    stateDir = join(orchRoot, '.orc-state');
    process.env.ORC_STATE_DIR = stateDir;
    process.env.ORC_WORKTREES_DIR = join(orchRoot, '.worktrees');
    process.env.ORC_BACKLOG_DIR = join(orchRoot, 'backlog');
    process.env.ORC_REPO_ROOT = target;
  });

  it('creates the worktree under the orchestration root but as a worktree of the target repo', async () => {
    const { ensureRunWorktree } = await import('./runWorktree.ts');
    const entry = ensureRunWorktree(stateDir, {
      runId: 'run-real-1',
      taskRef: 'sibling/task-1',
      agentId: 'orc-1',
    });

    // Placed under the orchestration WORKTREES_DIR.
    expect(entry.worktree_path).toBe(join(orchRoot, '.worktrees', 'run-real-1'));
    expect(existsSync(entry.worktree_path)).toBe(true);
    // ...but its git dir resolves into the TARGET repo, not the orchestration root.
    const commonDir = git(entry.worktree_path, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    expect(commonDir).toBe(join(target, '.git'));
    // The branch was created in the target repo, not the orchestration repo.
    expect(git(target, 'branch', '--list', 'task/run-real-1')).toContain('task/run-real-1');
    expect(git(orchRoot, 'branch', '--list', 'task/run-real-1')).toBe('');
    // Product file from the target repo is present in the worktree checkout.
    expect(existsSync(join(entry.worktree_path, 'product.txt'))).toBe(true);
    // The nested worktree does not dirty the orchestration repo (it is gitignored).
    expect(git(orchRoot, 'status', '--porcelain')).toBe('');
  });

  it('merges the worktree branch into the target repo, and no framework files leak in', async () => {
    const { ensureRunWorktree, cleanupRunWorktree } = await import('./runWorktree.ts');
    const entry = ensureRunWorktree(stateDir, {
      runId: 'run-real-2',
      taskRef: 'sibling/task-2',
      agentId: 'orc-1',
    });

    // Simulate a worker committing product-only changes in the worktree.
    writeFileSync(join(entry.worktree_path, 'feature.txt'), 'new feature\n');
    git(entry.worktree_path, 'add', 'feature.txt');
    git(entry.worktree_path, 'commit', '-m', 'add feature');

    // Coordinator merges from the target repo (cwd = target root), as task 185 wired.
    git(target, 'merge', entry.branch, '--no-ff', '-m', 'task(sibling/task-2): merge worktree');

    // The product commit landed on the target's main.
    expect(existsSync(join(target, 'feature.txt'))).toBe(true);
    expect(git(target, 'log', '--oneline', '--all')).toContain('add feature');

    // Framework files exist in the orchestration repo but must NOT appear in the
    // target repo — these checks are meaningful because orchRoot really has them.
    expect(existsSync(join(orchRoot, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(orchRoot, 'backlog'))).toBe(true);
    expect(existsSync(join(target, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(target, 'backlog'))).toBe(false);
    expect(existsSync(join(target, '.orc-state'))).toBe(false);
    expect(existsSync(join(target, '.worktrees'))).toBe(false);
    // The orchestration repo's tracked files are untouched by the whole flow.
    expect(git(orchRoot, 'status', '--porcelain')).toBe('');

    // Cleanup (worktree remove + branch delete) runs against the target repo.
    expect(cleanupRunWorktree(stateDir, 'run-real-2')).toBe(true);
    expect(existsSync(entry.worktree_path)).toBe(false);
  });
});
