import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface RuntimeRepo {
  repoRoot: string;
  stateDir: string;
  backlogDir: string;
  worktreesDir: string;
  artifactsDir: string;
  cleanup(): void;
}

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

/**
 * Creates a disposable git-backed runtime repo in a system temp directory.
 * The repo has an explicit `main` branch and an initial commit so git
 * worktree operations work without error.
 */
export function createRuntimeRepo(): RuntimeRepo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orc-real-provider-'));

  const stateDir = join(repoRoot, '.orc-state');
  const backlogDir = join(repoRoot, 'backlog');
  const worktreesDir = join(repoRoot, '.worktrees');
  const artifactsDir = join(repoRoot, 'artifacts');

  for (const dir of [stateDir, backlogDir, worktreesDir, artifactsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // Initialize git repo and set up main branch with an initial commit.
  git(['init', '--initial-branch=main'], repoRoot);
  git(['config', 'user.email', 'test@orc-real-provider.local'], repoRoot);
  git(['config', 'user.name', 'ORC Real Provider Test'], repoRoot);

  // Write a placeholder so there is something to commit.
  writeFileSync(join(repoRoot, '.gitkeep'), '');
  git(['add', '.gitkeep'], repoRoot);
  git(['commit', '-m', 'chore: initial commit'], repoRoot);

  return {
    repoRoot,
    stateDir,
    backlogDir,
    worktreesDir,
    artifactsDir,
    cleanup() {
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}
