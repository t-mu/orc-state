/**
 * lib/projectLayoutCheck.ts
 *
 * Layout health of a registered project: the orchestration state lives in an
 * external data home and product code in the target repository, so the two
 * roots are checked separately. Pure and injectable so `orc doctor` /
 * `orc preflight` can wire it (through lib/projectHealth.ts) and unit tests
 * can assert each check directly — mirrors lib/sandboxDeps.ts.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

export interface ProjectLayoutCheck {
  ok: boolean;
  errors: string[];
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function checkProjectLayout({
  targetRepoRoot,
  stateDir,
  dataHome,
  worktreesDir,
}: {
  targetRepoRoot: string;
  stateDir: string;
  dataHome?: string | undefined;
  worktreesDir?: string | undefined;
}): ProjectLayoutCheck {
  const errors: string[] = [];

  // 1. The target is an existing Git repository whose metadata runs can write (worktrees, branches, merges).
  if (!existsSync(targetRepoRoot)) {
    errors.push(`target repository does not exist: ${targetRepoRoot}`);
  } else {
    const commonDir = gitCommonDir(targetRepoRoot);
    if (!commonDir) errors.push(`target repository is not a git repository: ${targetRepoRoot}`);
    else if (!isWritable(commonDir)) errors.push(`target repository Git metadata is not writable: ${commonDir}`);
  }

  // 2. The external state directory and its data home are writable.
  if (!existsSync(stateDir)) {
    errors.push(`state dir does not exist: ${stateDir}`);
  } else if (!isWritable(stateDir)) {
    errors.push(`state dir is not writable: ${stateDir}`);
  }
  if (dataHome !== undefined && existsSync(dataHome) && !isWritable(dataHome)) {
    errors.push(`data home is not writable: ${dataHome}`);
  }

  // 3. Run worktrees belong outside the target working tree.
  if (worktreesDir !== undefined && existsSync(targetRepoRoot) && within(targetRepoRoot, worktreesDir)) {
    errors.push(`run worktrees directory is inside the target working tree: ${worktreesDir}`);
  }

  return { ok: errors.length === 0, errors };
}

function gitCommonDir(dir: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
