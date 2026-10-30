import { delimiter, join } from 'node:path';
import { stripNestedProviderEnv } from '../../lib/providerChildEnv.ts';
import { withoutOrcEnv, type RuntimeRepo } from './runtimeRepo.ts';
import { writeOrcWrapper } from './orcWrapper.ts';

export interface RuntimeEnv {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Configures the temp repo's registered project and returns the env object +
 * cwd that coordinator and worker launches must use: the temp `ORC_DATA_HOME`
 * and the project's `ORC_PROJECT_ID`, with every other orc variable removed.
 *
 * Stores the provider settings as project settings (`orc project config set`),
 * including `worker_pool.max_workers = 1` to prevent coordinator fan-out
 * during real-provider tests.
 *
 * @param provider - Worker provider for the coordinator config (default: 'claude').
 */
export function buildRuntimeEnv(repo: RuntimeRepo, provider = 'claude'): RuntimeEnv {
  // The wrapper lives beside the target repo so nothing orc-specific lands in its working tree.
  const orcWrapperPath = writeOrcWrapper(repo.root);
  const wrapperBinDir = join(repo.root, 'bin');

  const settings: Array<[string, string]> = [
    ['default_provider', provider],
    ['default_execution_mode', 'full-access'],
    ['master.provider', provider],
    ['master.execution_mode', 'full-access'],
    ['worker_pool.max_workers', '1'],
    ['worker_pool.provider', provider],
    ['worker_pool.execution_mode', 'full-access'],
  ];
  for (const [key, value] of settings) repo.orc(['project', 'config', 'set', key, value]);

  // Strip provider session-control env vars so the coordinator and the worker
  // sessions it launches do not inherit the parent agent's CLI sandbox/session.
  const baseEnv = stripNestedProviderEnv(withoutOrcEnv());

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PATH: [wrapperBinDir, baseEnv.PATH ?? process.env.PATH ?? ''].filter(Boolean).join(delimiter),
    ORC_DATA_HOME: repo.dataHome,
    ORC_PROJECT_ID: repo.projectId,
    ORC_WORKER_BOOTSTRAP_PROFILE: 'smoke',
    ORC_WORKER_STARTUP_PROFILE: 'real-provider-smoke',
    ORC_BIN: orcWrapperPath,
  };

  return { env, cwd: repo.repoRoot };
}
