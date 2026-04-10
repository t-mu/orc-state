import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface RuntimeRepo {
  repoRoot: string;
  stateDir: string;
  backlogDir: string;
  worktreesDir: string;
  artifactsDir: string;
  commitAll(message: string): void;
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
  // Pre-trust the temp repo by running `claude -p` in print mode (which
  // skips the trust dialog and creates the project entry in ~/.claude/projects/).
  // This makes subsequent interactive sessions skip the trust dialog.
  preTrustWorkspace(repoRoot);

  return {
    repoRoot,
    stateDir,
    backlogDir,
    worktreesDir,
    artifactsDir,
    commitAll(message: string) {
      git(['add', '.'], repoRoot);
      git(['commit', '-m', message], repoRoot);
    },
    cleanup() {
      // Clean up the trust entry so ~/.claude/projects/ doesn't accumulate stale entries.
      const encoded = repoRoot.replace(/\//g, '-');
      const projectDir = join(homedir(), '.claude', 'projects', encoded);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Pre-trust a workspace directory for Claude Code.
 *
 * Runs `claude -p 'ok'` in print mode, which:
 *   1. Skips the workspace trust dialog (print mode always skips it)
 *   2. Creates a project entry in ~/.claude/projects/ as a side effect
 *   3. Makes subsequent interactive sessions skip the trust dialog
 *
 * The CLAUDECODE nesting-detection env vars are stripped so this works
 * when called from inside a Claude Code session.
 */
function preTrustWorkspace(repoRoot: string): void {
  const { CLAUDECODE: _1, CLAUDE_CODE_ENTRYPOINT: _2, CLAUDE_CODE_EXECPATH: _3, ...env } = process.env;
  spawnSync('claude', ['-p', 'ok'], {
    cwd: repoRoot,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: 'ignore',
  });
}
