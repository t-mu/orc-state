import { existsSync, readFileSync } from 'node:fs';
import { ORCHESTRATOR_CONFIG_FILE } from './paths.ts';

export const PROVIDERS = ['codex', 'claude', 'gemini'] as const;
export type ProviderName = typeof PROVIDERS[number];

export interface WorkerPoolConfig {
  max_workers: number;
  provider: ProviderName;
  model: string | null;
}

export const DEFAULT_WORKER_POOL_CONFIG: Readonly<WorkerPoolConfig> = Object.freeze({
  max_workers: 0,
  provider: 'codex' as ProviderName,
  model: null,
});

export function isSupportedProvider(provider: unknown): provider is ProviderName {
  return PROVIDERS.includes(provider as ProviderName);
}

function parseNonNegativeInteger(rawValue: unknown, fieldName: string): number | null {
  if (rawValue == null || rawValue === '') return null;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

interface ConfigFileResult {
  max_workers?: number | null;
  provider?: string | null;
  model?: string | null;
  default_provider?: string | null;
}

function parseConfigFile(configFile: string = ORCHESTRATOR_CONFIG_FILE): ConfigFileResult {
  if (!existsSync(configFile)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid orchestrator config at ${configFile}: ${(error as Error).message}`);
  }

  const topLevel = parsed as Record<string, unknown>;
  const defaultProvider = typeof topLevel.default_provider === 'string' ? topLevel.default_provider : null;

  if (defaultProvider != null && !isSupportedProvider(defaultProvider)) {
    throw new Error(`Invalid default_provider in ${configFile}: ${defaultProvider}. Must be codex, claude, or gemini.`);
  }

  const workerPool = topLevel.worker_pool;
  if (workerPool == null) return { default_provider: defaultProvider };
  if (typeof workerPool !== 'object' || Array.isArray(workerPool)) {
    throw new Error(`Invalid orchestrator config at ${configFile}: worker_pool must be an object`);
  }

  const wp = workerPool as Record<string, unknown>;
  return {
    max_workers: parseNonNegativeInteger(wp.max_workers, 'worker_pool.max_workers'),
    provider: (wp.provider as string | null) ?? null,
    model: (wp.model as string | null) ?? null,
    default_provider: defaultProvider,
  };
}

export function loadWorkerPoolConfig({
  env = process.env,
  configFile = ORCHESTRATOR_CONFIG_FILE,
}: {
  env?: NodeJS.ProcessEnv;
  configFile?: string;
} = {}): WorkerPoolConfig {
  const fileConfig = parseConfigFile(configFile);
  const maxWorkers = parseNonNegativeInteger(env.ORC_MAX_WORKERS, 'ORC_MAX_WORKERS');
  const provider = (env.ORC_WORKER_PROVIDER ?? fileConfig.provider ?? fileConfig.default_provider ?? DEFAULT_WORKER_POOL_CONFIG.provider);
  const model = env.ORC_WORKER_MODEL ?? fileConfig.model ?? DEFAULT_WORKER_POOL_CONFIG.model;

  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported worker pool provider: ${provider}`);
  }

  return {
    max_workers: maxWorkers ?? fileConfig.max_workers ?? DEFAULT_WORKER_POOL_CONFIG.max_workers,
    provider,
    model: model ?? null,
  };
}
