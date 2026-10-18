import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { normalizeWorkerEnv } from './workerRuntime.ts';

// Task 204: workers start inside their assigned worktree. In the sibling layout
// that worktree belongs to the TARGET repo, so from that cwd the `orc` CLI must
// still resolve the orchestration state, and git writes must stay inside the
// `.git` subtrees the sandbox grants (adapters/pty.ts TARGET_GIT_WRITABLE_SUBPATHS).

const repoRoot = resolve(import.meta.dirname, '..');
const GRANTED_GIT_SUBPATHS = ['objects', 'refs', 'logs', 'worktrees'];

let base: string;
let orch: string;
let stateDir: string;
let target: string;
let worktree: string;

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

beforeEach(() => {
  base = createTempStateDir('orc-worker-launch-');
  orch = join(base, 'orch');
  stateDir = join(orch, '.orc-state');
  target = join(base, 'target');
  worktree = join(orch, '.worktrees', 'run-1');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(orch, 'orc-state.config.json'), JSON.stringify({ target_repo: target }));
  seedState(stateDir, {
    tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'in_progress' }],
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
    claims: [{
      run_id: 'run-1', task_ref: 'orch/task-1', agent_id: 'worker-1', state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:01:00Z', lease_expires_at: '2099-01-01T00:00:00Z',
    }],
  });

  mkdirSync(target);
  git(target, 'init', '-q', '-b', 'main');
  writeFileSync(join(target, 'README.md'), 'target\n');
  git(target, 'add', '.');
  git(target, 'commit', '-q', '-m', 'init');
  git(target, 'worktree', 'add', '-q', '-b', 'task/run-1', worktree);
});

afterEach(() => {
  cleanupTempStateDir(base);
});

describe('worker launched in a sibling-layout worktree', () => {
  it('orc CLI resolves the orchestration state from the worktree cwd', () => {
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

  it('a commit in the worktree writes only the granted target .git subtrees', () => {
    const gitDir = join(target, '.git');
    const before = snapshot(gitDir);

    writeFileSync(join(worktree, 'change.txt'), 'change\n');
    git(worktree, 'add', 'change.txt');
    git(worktree, 'commit', '-q', '-m', 'worker change');

    const after = snapshot(gitDir);
    const written = [...after].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path);
    expect(written.length).toBeGreaterThan(0);
    const outsideGrant = written.filter((path) => !GRANTED_GIT_SUBPATHS.includes(path.split(/[\\/]/)[0]));
    expect(outsideGrant).toEqual([]);
  });
});
