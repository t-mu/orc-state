import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripNestedProviderEnv } from '../../lib/providerChildEnv.ts';
import type { RuntimeRepo } from './runtimeRepo.ts';

export interface RuntimeEnv {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Pins all orchestrator-managed runtime paths into the given temp repo and
 * returns the env object + cwd that coordinator and worker launches must use.
 *
 * Also writes a minimal orc-state.config.json with `worker_pool.max_workers = 1`
 * to prevent coordinator fan-out during real-provider tests.
 *
 * @param provider - Worker provider for the coordinator config (default: 'claude').
 */
export function buildRuntimeEnv(repo: RuntimeRepo, provider = 'claude'): RuntimeEnv {
  const configPath = join(repo.repoRoot, 'orc-state.config.json');

  const config = {
    default_provider: provider,
    default_execution_mode: 'full-access',
    master: {
      provider,
      model: null,
      execution_mode: 'full-access',
    },
    worker_pool: {
      max_workers: 1,
      provider,
      model: null,
      execution_mode: 'full-access',
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Strip provider session-control env vars so the coordinator and the worker
  // sessions it launches do not inherit the parent agent's CLI sandbox/session.
  const baseEnv = stripNestedProviderEnv(process.env);

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ORC_STATE_DIR: repo.stateDir,
    ORC_REPO_ROOT: repo.repoRoot,
    ORC_WORKTREES_DIR: repo.worktreesDir,
    ORC_BACKLOG_DIR: repo.backlogDir,
    ORC_CONFIG_FILE: configPath,
  };

  return { env, cwd: repo.repoRoot };
}
