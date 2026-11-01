import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeProjectEnv, cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents } from './eventLog.ts';
import { readClaims } from './stateReader.ts';
import type { Claim } from '../types/claims.ts';

// orc run-close / close_run against a real target repository: the merge check
// and the worktree cleanup are git operations, so nothing is mocked here.

let root: string;
let target: string;
let stateDir: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    run_id: 'run-1', task_ref: 'app/task-1', agent_id: 'worker-a', state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z',
    finalization_state: 'blocked_finalize', finalization_retry_count: 2,
    finalization_blocked_reason: 'finalization retry timed out waiting for worker progress',
    ...overrides,
  };
}

function seed(taskStatus: string, claimOverrides: Partial<Claim> = {}) {
  seedState(stateDir, {
    tasks: [{ ref: 'app/task-1', title: 'Task 1', status: taskStatus }],
    agents: [],
    claims: [claim(claimOverrides)],
  });
  // seedState points the descriptor at the state dir; worktree git runs against the target repo.
  Object.assign(process.env, bridgeProjectEnv(stateDir, target));
  initEventsDb(stateDir);
}

async function load() {
  const runWorktree = await import('./runWorktree.ts');
  const mutations = await import('./operatorMutations.ts');
  return { ...runWorktree, ...mutations };
}

/** A run worktree with one product commit on its branch. */
async function runWithCommit() {
  const { ensureRunWorktree } = await load();
  const entry = ensureRunWorktree(stateDir, { runId: 'run-1', taskRef: 'app/task-1', agentId: 'worker-a' });
  writeFileSync(join(entry.worktree_path, 'feature.txt'), 'feature\n');
  git(entry.worktree_path, 'add', 'feature.txt');
  git(entry.worktree_path, 'commit', '-m', 'add feature');
  return entry;
}

const runWorktreeEntries = () => (JSON.parse(readFileSync(join(stateDir, 'run-worktrees.json'), 'utf8')) as { runs: Array<{ run_id: string }> }).runs;
const runClaim = () => readClaims(stateDir).claims.find((entry) => entry.run_id === 'run-1')!;

beforeEach(() => {
  vi.resetModules();
  root = realpathSync(createTempStateDir('orch-close-run-'));
  target = join(root, 'target-repo');
  mkdirSync(target, { recursive: true });
  git(target, 'init', '-b', 'main');
  git(target, 'config', 'user.email', 'test@example.com');
  git(target, 'config', 'user.name', 'Test');
  writeFileSync(join(target, 'product.txt'), 'product\n');
  git(target, 'add', 'product.txt');
  git(target, 'commit', '-m', 'initial');
  stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  delete process.env.ORC_WORKTREES_DIR;
});

afterEach(() => {
  closeAllDatabases();
  cleanupTempStateDir(root);
  delete process.env.ORC_STATE_DIR;
  delete process.env.ORC_PROJECT_ID;
});

describe('closeRun (orc run-close / close_run)', () => {
  it('closes a blocked_finalize claim of a done task, cleans its worktree and branch, and emits run_finished', async () => {
    seed('done');
    const entry = await runWithCommit();
    git(target, 'merge', entry.branch, '--no-ff', '-m', 'task(app/task-1): merge worktree');
    const { applyOperatorMutation } = await load();

    const result = applyOperatorMutation(stateDir, { op: 'run-close', run_id: 'run-1', reason: 'merged by hand', actor_id: 'human' });

    expect(result).toMatchObject({ run_id: 'run-1', closed: true, task_ref: 'app/task-1', task_status: 'done', branch_merged: true, worktree_cleaned: true });
    const closed = runClaim();
    expect(closed.state).toBe('done');
    expect(closed.finished_at).toEqual(expect.any(String));
    expect(closed.finalization_state).toBeNull();
    expect(closed.finalization_retry_count).toBe(0);
    expect(closed.finalization_blocked_reason).toBeNull();

    const finished = queryEvents(stateDir, { event_type: 'run_finished', run_id: 'run-1' });
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ actor_id: 'human', agent_id: 'worker-a', task_ref: 'app/task-1',
      payload: { closed_by: 'human', reason: 'merged by hand', manual: true } });

    // Post-merge cleanup: worktree removed, branch deleted, entry dropped.
    expect(existsSync(entry.worktree_path)).toBe(false);
    expect(git(target, 'branch', '--list', entry.branch)).toBe('');
    expect(runWorktreeEntries().some((run) => run.run_id === 'run-1')).toBe(false);
  });

  it('closes the claim of a task that is not yet done when its branch is merged into main', async () => {
    seed('in_progress');
    const entry = await runWithCommit();
    git(target, 'merge', entry.branch, '--no-ff', '-m', 'task(app/task-1): merge worktree');
    const { closeRun } = await load();

    expect(closeRun(stateDir, { run_id: 'run-1' })).toMatchObject({ closed: true, task_status: 'done', branch_merged: true });
    expect(runClaim().state).toBe('done');

    // The merged work is not requeued: reconcile leaves the done task alone.
    const { reconcileState } = await import('./reconcile.ts');
    const { findTask, readBacklog } = await import('./stateReader.ts');
    reconcileState(stateDir);
    expect(findTask(readBacklog(stateDir), 'app/task-1')?.status).toBe('done');
  });

  it('closes the claim of a done task whose branch is not merged but keeps its worktree and branch', async () => {
    seed('done');
    const entry = await runWithCommit();
    writeFileSync(join(entry.worktree_path, 'uncommitted.txt'), 'keep me\n');
    const { closeRun } = await load();

    expect(closeRun(stateDir, { run_id: 'run-1' })).toMatchObject({ closed: true, task_status: 'done', branch_merged: false, worktree_cleaned: false });
    expect(runClaim().state).toBe('done');
    expect(existsSync(join(entry.worktree_path, 'uncommitted.txt'))).toBe(true);
    expect(git(target, 'branch', '--list', entry.branch)).toContain(entry.branch);
    expect(runWorktreeEntries().some((run) => run.run_id === 'run-1')).toBe(true);
  });

  it('refuses an unmerged branch of a task that is not done, pointing at run-expire and task-reset', async () => {
    seed('in_progress');
    const entry = await runWithCommit();
    const { closeRun } = await load();

    expect(() => closeRun(stateDir, { run_id: 'run-1' })).toThrow(/not merged.*orc task-mark-done app\/task-1.*orc run-expire run-1.*orc task-reset app\/task-1/);
    expect(runClaim().state).toBe('in_progress');
    expect(runClaim().finalization_state).toBe('blocked_finalize');
    expect(existsSync(entry.worktree_path)).toBe(true);
    expect(queryEvents(stateDir, { event_type: 'run_finished' })).toHaveLength(0);
  });

  it('does not count a run branch without commits of its own as merged', async () => {
    seed('in_progress');
    const { ensureRunWorktree, closeRun, runBranchMergedIntoMain } = await load();
    ensureRunWorktree(stateDir, { runId: 'run-1', taskRef: 'app/task-1', agentId: 'worker-a' });

    expect(runBranchMergedIntoMain('task/run-1')).toBe(false);
    expect(runBranchMergedIntoMain('task/missing')).toBe(false);
    expect(() => closeRun(stateDir, { run_id: 'run-1' })).toThrow(/not merged/);
  });

  it('refuses a run that is already terminal or unknown', async () => {
    seed('done', { state: 'done', finished_at: '2026-01-01T01:00:00.000Z' });
    const { closeRun } = await load();

    expect(() => closeRun(stateDir, { run_id: 'run-1' })).toThrow(/already terminal/);
    expect(() => closeRun(stateDir, { run_id: 'run-missing' })).toThrow(/run not found/);
  });

  it('accepts run-close with run_id and reason only', async () => {
    const { parseOperatorRequest } = await load();
    expect(parseOperatorRequest({ op: 'run-close', run_id: 'run-1', reason: 'x' })).toMatchObject({ op: 'run-close' });
    expect(() => parseOperatorRequest({ op: 'run-close', run_id: 'run-1', task_ref: 'x' })).toThrow(/Unknown field/);
  });
});
