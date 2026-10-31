import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { withLock, lockPath } from './lock.ts';
import { RUN_WORKTREES_FILE, WORKTREES_DIR, TARGET_REPO_ROOT } from './paths.ts';
import { HERMETIC_GIT_CONFIG_ARGS } from './gitPlumbing.ts';
import type { RunWorktreesState, RunWorktreeEntry } from '../types/run-worktrees.ts';
import { logger } from './logger.ts';

function readRunWorktrees(_stateDir: string): RunWorktreesState {
  try {
    return JSON.parse(readFileSync(RUN_WORKTREES_FILE, 'utf8')) as RunWorktreesState;
  } catch {
    return { version: '1', runs: [] };
  }
}

// Worktrees are worktrees OF the target repo (root = TARGET_REPO_ROOT, the cwd
// of `git worktree add`) but are PLACED under WORKTREES_DIR: the product branch
// lives in the registered target repo while the working files sit in the
// external project state directory.
function ensureGitWorktree({ root, path, branch, createBranch }: {
  root: string;
  path: string;
  branch: string;
  createBranch: boolean;
}): void {
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const args = createBranch
    ? [...HERMETIC_GIT_CONFIG_ARGS, 'worktree', 'add', path, '-b', branch]
    : [...HERMETIC_GIT_CONFIG_ARGS, 'worktree', 'add', path, branch];
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Failed to allocate worktree ${path}: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function isValidGitWorktree(path: string): boolean {
  return existsSync(path) && existsSync(join(path, '.git'));
}

export function getRunWorktree(stateDir: string, runId: string): RunWorktreeEntry | null {
  const file = readRunWorktrees(stateDir);
  return file.runs.find((entry) => entry.run_id === runId) ?? null;
}

export function deleteRunWorktree(stateDir: string, runId: string): boolean {
  return withLock(lockPath(stateDir), () => {
    const file = readRunWorktrees(stateDir);
    const remaining = file.runs.filter((entry) => entry.run_id !== runId);
    if (remaining.length === file.runs.length) return false;
    atomicWriteJson(RUN_WORKTREES_FILE, {
      version: '1',
      runs: remaining,
    });
    return true;
  });
}

function gitInTarget(args: string[]) {
  return spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, ...args], { cwd: TARGET_REPO_ROOT, encoding: 'utf8' });
}

/**
 * Whether a run branch was merged into `main` as its own line of work: its tip
 * is an ancestor of `main` but not on `main`'s first-parent history. That
 * excludes a run branch with no commits of its own (its tip is a `main`
 * commit, so it is trivially an ancestor) and a fast-forward merge; a missing
 * branch is not merged.
 */
export function runBranchMergedIntoMain(branch: string): boolean {
  const tip = gitInTarget(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (tip.error) throw tip.error;
  const sha = tip.status === 0 ? tip.stdout.trim() : '';
  if (!sha) return false;
  const ancestor = gitInTarget(['merge-base', '--is-ancestor', sha, 'main']);
  if (ancestor.error) throw ancestor.error;
  if (ancestor.status === 1) return false;
  if (ancestor.status !== 0) throw new Error(`git merge-base failed for ${branch}: ${(ancestor.stderr || ancestor.stdout || 'unknown error').trim()}`);
  const firstParents = gitInTarget(['rev-list', '--first-parent', 'main']);
  if (firstParents.error) throw firstParents.error;
  if (firstParents.status !== 0) throw new Error(`git rev-list failed for main: ${(firstParents.stderr || 'unknown error').trim()}`);
  return !firstParents.stdout.split('\n').includes(sha);
}

export function cleanupRunWorktree(stateDir: string, runId: string): boolean {
  if (!runId) throw new Error('runId is required');

  return withLock(lockPath(stateDir), () => {
    const file = readRunWorktrees(stateDir);
    const entry = file.runs.find((candidate) => candidate.run_id === runId) ?? null;
    if (!entry) {
      logger.warn(`[runWorktree] cleanupRunWorktree: no entry found for run ${runId}`);
      return false;
    }

    const root = TARGET_REPO_ROOT;
    let cleanupSucceeded = true;
    if (entry.worktree_path) {
      if (existsSync(entry.worktree_path)) {
        const result = spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, 'worktree', 'remove', '--force', entry.worktree_path], {
          cwd: root,
          encoding: 'utf8',
        });
        if (result.status !== 0 || result.error) {
          cleanupSucceeded = false;
          const detail = result.error?.message ?? (result.stderr || result.stdout || 'unknown error').trim();
          logger.warn(`[runWorktree] worktree remove failed for ${entry.worktree_path}: ${detail}`);
        }
      } else {
        logger.warn(`[runWorktree] cleanupRunWorktree: worktree path not found, skipping remove: ${entry.worktree_path}`);
      }
    }

    if (entry.branch) {
      const result = spawnSync('git', [...HERMETIC_GIT_CONFIG_ARGS, 'branch', '-d', entry.branch], {
        cwd: root,
        encoding: 'utf8',
      });
      if (result.status !== 0 || result.error) {
        cleanupSucceeded = false;
        const detail = result.error?.message ?? (result.stderr || result.stdout || 'unknown error').trim();
        logger.warn(`[runWorktree] branch delete failed for ${entry.branch}: ${detail}`);
      }
    }

    if (!cleanupSucceeded) {
      return false;
    }

    const remaining = file.runs.filter((candidate) => candidate.run_id !== runId);
    atomicWriteJson(RUN_WORKTREES_FILE, {
      version: '1',
      runs: remaining,
    });
    return true;
  });
}

export function pruneMissingRunWorktrees(stateDir: string, activeRunIds: string[] = []): number {
  return withLock(lockPath(stateDir), () => {
    const activeSet = new Set(activeRunIds);
    const file = readRunWorktrees(stateDir);
    const remaining = file.runs.filter((entry) =>
      activeSet.has(entry.run_id) || isValidGitWorktree(entry.worktree_path));
    if (remaining.length === file.runs.length) return 0;
    atomicWriteJson(RUN_WORKTREES_FILE, {
      version: '1',
      runs: remaining,
    });
    return file.runs.length - remaining.length;
  });
}

export function ensureRunWorktree(
  stateDir: string,
  { runId, taskRef, agentId }: { runId: string; taskRef: string; agentId: string },
): RunWorktreeEntry {
  if (!runId) throw new Error('runId is required');
  if (!taskRef) throw new Error('taskRef is required');
  if (!agentId) throw new Error('agentId is required');

  return withLock(lockPath(stateDir), () => {
    const file = readRunWorktrees(stateDir);
    const existing = file.runs.find((entry) => entry.run_id === runId) ?? null;
    const root = TARGET_REPO_ROOT;
    const branch = existing?.branch ?? `task/${runId}`;
    const worktreePath = existing?.worktree_path ?? join(WORKTREES_DIR, runId);

    if (existsSync(worktreePath) && !isValidGitWorktree(worktreePath)) {
      throw new Error(`Assigned worktree path exists but is not a git worktree: ${worktreePath}`);
    }

    if (!isValidGitWorktree(worktreePath)) {
      ensureGitWorktree({
        root,
        path: worktreePath,
        branch,
        createBranch: existing == null,
      });
    }

    const nowIso = new Date().toISOString();
    const entry: RunWorktreeEntry = {
      run_id: runId,
      task_ref: taskRef,
      agent_id: agentId,
      branch,
      worktree_path: worktreePath,
      created_at: existing?.created_at ?? nowIso,
      updated_at: nowIso,
    };
    const remaining = file.runs.filter((candidate) => candidate.run_id !== runId);
    atomicWriteJson(RUN_WORKTREES_FILE, {
      version: '1',
      runs: [...remaining, entry],
    });
    return entry;
  });
}
