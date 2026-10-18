import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { normalizeWorkerEnv } from './workerRuntime.ts';

// Task 204: workers start inside their assigned worktree. From that cwd the
// `orc` CLI must still resolve the orchestration state, and a worker's git
// commit/rebase must write only inside the `.git` subtrees the sandbox grants
// (adapters/pty.ts TARGET_GIT_WRITABLE_SUBPATHS). In the attached layout the
// worktree belongs to the orchestration repo; in the sibling layout to the
// target repo.

const repoRoot = resolve(import.meta.dirname, '..');
const GRANTED_GIT_SUBPATHS = ['objects', 'refs', 'logs', 'worktrees'];

let base: string;

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function snapshot(dir: string): Map<string, number> {
  const files = new Map<string, number>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path), statSync(path).mtimeMs);
    }
  };
  walk(dir);
  return files;
}

/** Run `operation` and return the files under `<repo>/.git` it wrote outside the grant. */
function gitWritesOutsideGrant(repo: string, operation: () => void): { written: string[]; outsideGrant: string[] } {
  const gitDir = join(repo, '.git');
  const before = snapshot(gitDir);
  operation();
  const written = [...snapshot(gitDir)].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path);
  return { written, outsideGrant: written.filter((path) => !GRANTED_GIT_SUBPATHS.includes(path.split(/[\\/]/)[0])) };
}

/**
 * Build an orchestration root with seeded state and a run worktree. Attached:
 * the orchestration root is itself the repo. Sibling: a separate target repo
 * owns the worktree.
 */
function setupLayout(layout: 'attached' | 'sibling') {
  const orch = join(base, 'orch');
  const stateDir = join(orch, '.orc-state');
  const repo = layout === 'attached' ? orch : join(base, 'target');
  const worktree = join(orch, '.worktrees', 'run-1');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  if (layout === 'sibling') writeFileSync(join(orch, 'orc-state.config.json'), JSON.stringify({ target_repo: repo }));
  seedState(stateDir, {
    tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'in_progress' }],
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
    claims: [{
      run_id: 'run-1', task_ref: 'orch/task-1', agent_id: 'worker-1', state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:01:00Z', lease_expires_at: '2099-01-01T00:00:00Z',
    }],
  });

  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), '.orc-state/\n.worktrees/\n');
  writeFileSync(join(repo, 'README.md'), 'repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'worktree', 'add', '-q', '-b', 'task/run-1', worktree);
  return { orch, stateDir, repo, worktree };
}

beforeEach(() => {
  base = createTempStateDir('orc-worker-launch-');
});

afterEach(() => {
  cleanupTempStateDir(base);
});

describe.each(['attached', 'sibling'] as const)('worker launched in its worktree (%s layout)', (layout) => {
  it('orc CLI resolves the orchestration state from the worktree cwd', () => {
    const { orch, stateDir, worktree } = setupLayout(layout);
    const env = normalizeWorkerEnv({ ...process.env, ORC_STATE_DIR: stateDir }, orch);
    const result = spawnSync(process.execPath, [join(repoRoot, 'cli', 'orc.ts'), 'runs-active', '--json'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const runs = (JSON.parse(result.stdout) as { runs: Array<{ run_id: string }> }).runs;
    expect(runs.map((run) => run.run_id)).toEqual(['run-1']);
  });

  it('commit and rebase in the worktree write only the granted .git subtrees', () => {
    const { repo, worktree } = setupLayout(layout);

    const commit = gitWritesOutsideGrant(repo, () => {
      writeFileSync(join(worktree, 'change.txt'), 'change\n');
      git(worktree, 'add', 'change.txt');
      git(worktree, 'commit', '-q', '-m', 'worker change');
    });
    expect(commit.written.length).toBeGreaterThan(0);
    expect(commit.outsideGrant).toEqual([]);

    // main moves on (coordinator-side, unsandboxed), then the worker rebases.
    writeFileSync(join(repo, 'main.txt'), 'main\n');
    git(repo, 'add', 'main.txt');
    git(repo, 'commit', '-q', '-m', 'main change');

    const rebase = gitWritesOutsideGrant(repo, () => git(worktree, 'rebase', '-q', 'main'));
    expect(rebase.written.length).toBeGreaterThan(0);
    expect(rebase.outsideGrant).toEqual([]);
    expect(git(worktree, 'log', '--format=%s').trim().split('\n')).toEqual(['worker change', 'main change', 'init']);
  });
});
