import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Absolute path to the real source checkout's CLI entrypoint. */
const REAL_ORC_ENTRYPOINT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli', 'orc.ts');

export interface RuntimeRepo {
  /** Temp root holding the target repo, the data home and harness artifacts. */
  root: string;
  /** The registered target Git repository (no orc files in it). */
  repoRoot: string;
  /** Temp `ORC_DATA_HOME` holding the project registry and state. */
  dataHome: string;
  /** Id of the registered project. */
  projectId: string;
  /** The project's state directory (`<dataHome>/projects/<id>`). */
  stateDir: string;
  /** Run worktrees directory inside the project state directory. */
  worktreesDir: string;
  artifactsDir: string;
  /** Run an `orc` CLI command against this project; throws on non-zero exit. */
  orc(args: string[]): string;
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
 * The ambient environment with every orc selection removed, so an inherited
 * `ORC_PROJECT_ID`, `ORC_STATE_DIR`, control socket or session secret (for
 * example from the worker session running this suite) cannot reach the real
 * project. Callers add the temp data home and project id on top.
 */
export function withoutOrcEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('ORC_')));
}

/** Run the source `orc` CLI with `env`; throws with its output on non-zero exit. */
export function runOrc(args: string[], env: NodeJS.ProcessEnv, cwd: string): string {
  const result = spawnSync(process.execPath, [REAL_ORC_ENTRYPOINT, ...args], { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`orc ${args.join(' ')} failed (${result.status}): ${(result.stderr + result.stdout).trim()}`);
  }
  return result.stdout;
}

/**
 * Creates a disposable git-backed target repo in a system temp directory and
 * registers it as a project in a temp `ORC_DATA_HOME` beside it.
 *
 * The repo is a functional project that supports the full worker phased
 * workflow: npm test works (Node built-in test runner) and git operations work.
 * Nothing orc-specific is written into it: state, run worktrees and settings
 * live in the project state directory under the temp data home.
 */
export function createRuntimeRepo(): RuntimeRepo {
  // realpath so the registered canonical Git root matches on systems where tmpdir is a symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orc-real-provider-')));

  const repoRoot = join(root, 'repo');
  const dataHome = join(root, 'data');
  const artifactsDir = join(root, 'artifacts');
  const libDir = join(repoRoot, 'lib');

  for (const dir of [repoRoot, dataHome, artifactsDir, libDir]) {
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

  writeFileSync(join(repoRoot, '.gitignore'), 'node_modules/\n');

  // ── Git initialization ───────────────────────────────────────────────
  git(['init', '--initial-branch=main'], repoRoot);
  git(['config', 'user.email', 'test@orc-real-provider.local'], repoRoot);
  git(['config', 'user.name', 'ORC Real Provider Test'], repoRoot);

  git(['add', '.'], repoRoot);
  git(['commit', '-m', 'chore: initial project scaffold'], repoRoot);

  // ── Project registration ─────────────────────────────────────────────
  const baseEnv: NodeJS.ProcessEnv = { ...withoutOrcEnv(), ORC_DATA_HOME: dataHome };
  const project = JSON.parse(runOrc(['project', 'add', repoRoot, '--name=orc-smoke-test'], baseEnv, root)) as {
    id: string;
    stateDir: string;
  };
  const projectEnv: NodeJS.ProcessEnv = { ...baseEnv, ORC_PROJECT_ID: project.id };

  // ── Claude Code workspace trust ────────────────────────────────────
  // Claude Code shows a workspace trust dialog for unknown directories.
  // Pre-trust the temp root by running `claude -p` in print mode (which
  // skips the trust dialog and creates the project entry in ~/.claude/projects/).
  // The root covers both the repo and the run worktrees under the data home,
  // so subsequent interactive worker sessions skip the trust dialog.
  preTrustWorkspace(root);

  return {
    root,
    repoRoot,
    dataHome,
    projectId: project.id,
    stateDir: project.stateDir,
    worktreesDir: join(project.stateDir, 'worktrees'),
    artifactsDir,
    orc(args: string[]) {
      return runOrc(args, projectEnv, root);
    },
    commitAll(message: string) {
      git(['add', '.'], repoRoot);
      git(['commit', '-m', message], repoRoot);
    },
    cleanup() {
      // Clean up the trust entry so ~/.claude/projects/ doesn't accumulate stale entries.
      const encoded = root.replace(/\//g, '-');
      const projectDir = join(homedir(), '.claude', 'projects', encoded);
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
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
function preTrustWorkspace(dir: string): void {
  const { CLAUDECODE: _1, CLAUDE_CODE_ENTRYPOINT: _2, CLAUDE_CODE_EXECPATH: _3, ...env } = process.env;
  spawnSync('claude', ['-p', 'ok'], {
    cwd: dir,
    env: env as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 15_000,
    stdio: 'ignore',
  });
}
