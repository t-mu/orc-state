import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
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
 *
 * The repo is a functional project that supports the full worker phased
 * workflow: npm test works (Node built-in test runner), git operations work,
 * and the directory structure matches coordinator expectations.
 */
export function createRuntimeRepo(): RuntimeRepo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orc-real-provider-'));

  const stateDir = join(repoRoot, '.orc-state');
  const backlogDir = join(repoRoot, 'backlog');
  const worktreesDir = join(repoRoot, '.worktrees');
  const artifactsDir = join(repoRoot, 'artifacts');
  const libDir = join(repoRoot, 'lib');

  for (const dir of [stateDir, backlogDir, worktreesDir, artifactsDir, libDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // ── Project scaffolding ──────────────────────────────────────────────
  // package.json — uses Node 24 built-in test runner, no npm install needed.
  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({
    name: 'orc-smoke-test',
    private: true,
    type: 'module',
    scripts: {
      test: 'node --test',
    },
  }, null, 2) + '\n');

  // Baseline test — ensures `npm test` passes before the worker touches anything.
  writeFileSync(join(libDir, 'baseline.test.mjs'), [
    "import { describe, it } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "describe('baseline', () => {",
    "  it('passes', () => { assert.ok(true); });",
    '});',
    '',
  ].join('\n'));

  // .gitignore — keep state and worktrees out of git
  writeFileSync(join(repoRoot, '.gitignore'), [
    '.orc-state/',
    '.worktrees/',
    'node_modules/',
    'bin/',
  ].join('\n') + '\n');

  // ── Git initialization ───────────────────────────────────────────────
  git(['init', '--initial-branch=main'], repoRoot);
  git(['config', 'user.email', 'test@orc-real-provider.local'], repoRoot);
  git(['config', 'user.name', 'ORC Real Provider Test'], repoRoot);

  git(['add', '.'], repoRoot);
  git(['commit', '-m', 'chore: initial project scaffold'], repoRoot);

  // ── Claude Code workspace trust ────────────────────────────────────
  // Claude Code shows a workspace trust dialog for unknown directories.
  // Pre-create the project directory in ~/.claude/projects/ so the dialog
  // is bypassed. Also trust potential worktree paths.
  const trustedPaths = preTrustWorkspace(repoRoot);

  return {
    repoRoot,
    stateDir,
    backlogDir,
    worktreesDir,
    artifactsDir,
    cleanup() {
      rmSync(repoRoot, { recursive: true, force: true });
      for (const p of trustedPaths) {
        rmSync(p, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Encode a filesystem path to the Claude Code project directory name format.
 * Slashes become dashes: /tmp/foo → -tmp-foo
 */
function encodeProjectPath(dirPath: string): string {
  return dirPath.replace(/\//g, '-');
}

/**
 * Pre-trust a workspace directory so Claude Code skips the trust dialog.
 * Creates the project directory structure in ~/.claude/projects/.
 * Returns the list of created directories (for cleanup).
 */
function preTrustWorkspace(repoRoot: string): string[] {
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeProjectsDir)) return [];

  const created: string[] = [];

  // Trust the repo root
  const encodedRoot = encodeProjectPath(repoRoot);
  const projectDir = join(claudeProjectsDir, encodedRoot);
  mkdirSync(projectDir, { recursive: true });
  created.push(projectDir);

  // Trust the worktrees directory and potential worktree paths
  // (workers are launched at repo root but cd into worktrees)
  const worktreesBase = join(repoRoot, '.worktrees');
  const encodedWorktrees = encodeProjectPath(worktreesBase);
  const worktreesProjectDir = join(claudeProjectsDir, encodedWorktrees);
  mkdirSync(worktreesProjectDir, { recursive: true });
  created.push(worktreesProjectDir);

  return created;
}
