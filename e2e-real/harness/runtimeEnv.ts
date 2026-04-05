import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeRepo } from './runtimeRepo.ts';

export interface RuntimeEnv {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Pins all orchestrator-managed runtime paths into the given temp repo and
 * returns the env object + cwd that coordinator and worker launches must use.
 *
 * Also writes a minimal orchestrator.config.json with `worker_pool.max_workers = 1`
 * to prevent coordinator fan-out during real-provider tests.
 */
export function buildRuntimeEnv(repo: RuntimeRepo): RuntimeEnv {
  const configPath = join(repo.repoRoot, 'orchestrator.config.json');

  const config = {
    default_provider: 'claude',
    default_execution_mode: 'full-access',
    master: {
      provider: 'claude',
      model: null,
      execution_mode: 'full-access',
    },
    worker_pool: {
      max_workers: 1,
      provider: 'claude',
      model: null,
      execution_mode: 'full-access',
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORCH_STATE_DIR: repo.stateDir,
    ORC_REPO_ROOT: repo.repoRoot,
    ORC_WORKTREES_DIR: repo.worktreesDir,
    ORC_BACKLOG_DIR: repo.backlogDir,
    ORC_CONFIG_FILE: configPath,
  };

  return { env, cwd: repo.repoRoot };
}
