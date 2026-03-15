import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicWrite.ts';
import { withLock } from './lock.ts';
import { RUN_WORKTREES_FILE, WORKTREES_DIR } from './paths.ts';
import { resolveRepoRoot } from './repoRoot.ts';
import type { RunWorktreesState, RunWorktreeEntry } from '../types/run-worktrees.ts';

function readRunWorktrees(_stateDir: string): RunWorktreesState {
  try {
    return JSON.parse(readFileSync(RUN_WORKTREES_FILE, 'utf8')) as RunWorktreesState;
  } catch {
    return { version: '1', runs: [] };
  }
}

function lockPath(stateDir: string): string {
  return join(stateDir, '.lock');
}

function ensureGitWorktree({ root, path, branch, createBranch }: {
  root: string;
  path: string;
  branch: string;
  createBranch: boolean;
}): void {
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const args = createBranch
    ? ['worktree', 'add', path, '-b', branch]
    : ['worktree', 'add', path, branch];
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
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

export function cleanupRunWorktree(stateDir: string, runId: string): boolean {
  if (!runId) throw new Error('runId is required');

  return withLock(lockPath(stateDir), () => {
    const file = readRunWorktrees(stateDir);
    const entry = file.runs.find((candidate) => candidate.run_id === runId) ?? null;
    if (!entry) {
      console.warn(`[runWorktree] cleanupRunWorktree: no entry found for run ${runId}`);
      return false;
    }

    const root = resolveRepoRoot();
    let cleanupSucceeded = true;
    if (entry.worktree_path) {
      if (existsSync(entry.worktree_path)) {
        const result = spawnSync('git', ['worktree', 'remove', '--force', entry.worktree_path], {
          cwd: root,
          encoding: 'utf8',
        });
        if (result.status !== 0) {
          cleanupSucceeded = false;
          console.warn(`[runWorktree] worktree remove failed for ${entry.worktree_path}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
        }
      } else {
        console.warn(`[runWorktree] cleanupRunWorktree: worktree path not found, skipping remove: ${entry.worktree_path}`);
      }
    }

    if (entry.branch) {
      const result = spawnSync('git', ['branch', '-d', entry.branch], {
        cwd: root,
        encoding: 'utf8',
      });
      if (result.status !== 0) {
        cleanupSucceeded = false;
        console.warn(`[runWorktree] branch delete failed for ${entry.branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
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
    const root = resolveRepoRoot();
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
