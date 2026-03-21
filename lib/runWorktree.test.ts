import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'orch-run-worktree-test-'));
  process.env.ORCH_STATE_DIR = dir;
  process.env.ORC_WORKTREES_DIR = join(dir, 'repo', '.worktrees');
  process.env.ORC_BACKLOG_DIR = join(dir, 'docs', 'backlog');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
  delete process.env.ORC_WORKTREES_DIR;
  delete process.env.ORC_BACKLOG_DIR;
});

describe('ensureRunWorktree', () => {
  it('persists and reuses the same run worktree metadata', async () => {
    const worktreePath = join(dir, 'repo', '.worktrees', 'run-1');
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git') })
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git') });

    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { ensureRunWorktree, getRunWorktree } = await import('./runWorktree.ts');

    const first = ensureRunWorktree(dir, {
      runId: 'run-1',
      taskRef: 'orch/task-148',
      agentId: 'orc-1',
    });
    expect(first.worktree_path).toBe(worktreePath);
    expect(first.branch).toBe('task/run-1');

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
    expect(spawnSync).toHaveBeenCalledTimes(3);
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
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git') });

    vi.doMock('node:child_process', () => ({ spawnSync }));
    const { ensureRunWorktree } = await import('./runWorktree.ts');

    mkdirSync(worktreePath, { recursive: true });

    expect(() => ensureRunWorktree(dir, {
      runId: 'run-2',
      taskRef: 'orch/task-148',
      agentId: 'orc-1',
    })).toThrow('is not a git worktree');
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
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git') })
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: '' });
    vi.doMock('node:child_process', () => ({ spawnSync }));

    const { cleanupRunWorktree } = await import('./runWorktree.ts');
    expect(cleanupRunWorktree(dir, 'run-cleanup')).toBe(true);
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'git', ['worktree', 'remove', '--force', join(dir, 'repo', '.worktrees', 'run-cleanup')], expect.objectContaining({
      cwd: join(dir, 'repo'),
      encoding: 'utf8',
    }));
    expect(spawnSync).toHaveBeenNthCalledWith(3, 'git', ['branch', '-d', 'task/run-cleanup'], expect.objectContaining({
      cwd: join(dir, 'repo'),
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
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git') })
      .mockReturnValueOnce({ status: 0, stdout: '' });
    vi.doMock('node:child_process', () => ({ spawnSync }));

    const { cleanupRunWorktree } = await import('./runWorktree.ts');
    expect(cleanupRunWorktree(dir, 'run-missing-path')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('worktree path not found'));
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it('respects ORC_WORKTREES_DIR env var for worktree path', async () => {
    const customWorktreesDir = join(dir, 'custom-worktrees');
    process.env.ORC_WORKTREES_DIR = customWorktreesDir;

    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git') }) // resolveRepoRoot
      .mockReturnValueOnce({ status: 0, stdout: '' });                        // git worktree add
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
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git'), stderr: '' })
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
      .mockReturnValueOnce({ status: 0, stdout: join(dir, 'repo', '.git') })
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 1, stderr: 'branch delete failed' });
    vi.doMock('node:child_process', () => ({ spawnSync }));

    const { cleanupRunWorktree } = await import('./runWorktree.ts');
    expect(cleanupRunWorktree(dir, 'run-branch-failure')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('branch delete failed'));

    const persisted = JSON.parse(readFileSync(join(dir, 'run-worktrees.json'), 'utf8'));
    expect(persisted.runs).toHaveLength(1);
    expect(persisted.runs[0].run_id).toBe('run-branch-failure');
  });
});
