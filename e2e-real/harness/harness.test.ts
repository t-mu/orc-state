import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRuntimeRepo } from './runtimeRepo.ts';
import { buildRuntimeEnv } from './runtimeEnv.ts';
import { writeOrcWrapper } from './orcWrapper.ts';
import type { RuntimeRepo } from './runtimeRepo.ts';

let repo: RuntimeRepo | null = null;

afterEach(() => {
  if (repo) {
    repo.cleanup();
    repo = null;
  }
});

describe('runtimeRepo', () => {
  it('creates an isolated git repo on main', () => {
    repo = createRuntimeRepo();

    // Repo root is outside the real checkout (in a temp dir).
    expect(repo.repoRoot).toMatch(/orc-real-provider-/);

    // Required directories exist.
    expect(existsSync(repo.stateDir)).toBe(true);
    expect(existsSync(repo.backlogDir)).toBe(true);
    expect(existsSync(repo.worktreesDir)).toBe(true);
    expect(existsSync(repo.artifactsDir)).toBe(true);

    // Git repo is initialized and on the `main` branch.
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo.repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('main');

    // At least one commit exists so worktree operations work.
    const logResult = spawnSync('git', ['log', '--oneline'], {
      cwd: repo.repoRoot,
      encoding: 'utf8',
    });
    expect(logResult.status).toBe(0);
    expect(logResult.stdout.trim().length).toBeGreaterThan(0);
  });
});

describe('runtimeEnv', () => {
  it('pins all runtime env paths into the temp repo', () => {
    repo = createRuntimeRepo();
    const { env, cwd } = buildRuntimeEnv(repo);

    expect(env.ORCH_STATE_DIR).toBe(repo.stateDir);
    expect(env.ORC_REPO_ROOT).toBe(repo.repoRoot);
    expect(env.ORC_WORKTREES_DIR).toBe(repo.worktreesDir);
    expect(env.ORC_BACKLOG_DIR).toBe(repo.backlogDir);
    expect(env.ORC_CONFIG_FILE).toBe(join(repo.repoRoot, 'orchestrator.config.json'));
    expect(cwd).toBe(repo.repoRoot);
  });

  it('writes a temp config with worker_pool.max_workers = 1', () => {
    repo = createRuntimeRepo();
    buildRuntimeEnv(repo);

    const configPath = join(repo.repoRoot, 'orchestrator.config.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { worker_pool: { max_workers: number } };
    expect(config.worker_pool.max_workers).toBe(1);
  });
});

describe('orcWrapper', () => {
  it('exposes a runnable orc wrapper for worker PTYs', () => {
    repo = createRuntimeRepo();
    const wrapperPath = writeOrcWrapper(repo.repoRoot);

    // Wrapper file exists and is executable.
    expect(existsSync(wrapperPath)).toBe(true);

    // Running the wrapper with --help succeeds (exit 0) and prints usage.
    const result = spawnSync(wrapperPath, ['--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('orc');
  });
});

describe('real-provider suite config', () => {
  it('configures the real-provider suite for serial execution', () => {
    // The config file must exist in the repo root.
    const configPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..',
      'vitest.real-providers.config.mjs',
    );
    expect(existsSync(configPath)).toBe(true);

    // Read it and verify serial-execution settings.
    const source = readFileSync(configPath, 'utf8');
    expect(source).toContain('fileParallelism: false');
    expect(source).toContain('singleFork: true');
  });
});
