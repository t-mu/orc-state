import { existsSync, readFileSync } from 'node:fs';
import { ORCHESTRATOR_CONFIG_FILE } from './paths.mjs';

export const PROVIDERS = ['codex', 'claude', 'gemini'];
export const DEFAULT_WORKER_POOL_CONFIG = Object.freeze({
  max_workers: 0,
  provider: 'codex',
  model: null,
});

export function isSupportedProvider(provider) {
  return PROVIDERS.includes(provider);
}

function parseNonNegativeInteger(rawValue, fieldName) {
  if (rawValue == null || rawValue === '') return null;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function parseConfigFile(configFile = ORCHESTRATOR_CONFIG_FILE) {
  if (!existsSync(configFile)) return {};

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid orchestrator config at ${configFile}: ${error.message}`);
  }

  const workerPool = parsed?.worker_pool;
  if (workerPool == null) return {};
  if (typeof workerPool !== 'object' || Array.isArray(workerPool)) {
    throw new Error(`Invalid orchestrator config at ${configFile}: worker_pool must be an object`);
  }

  return {
    max_workers: parseNonNegativeInteger(workerPool.max_workers, 'worker_pool.max_workers'),
    provider: workerPool.provider ?? null,
    model: workerPool.model ?? null,
  };
}

export function loadWorkerPoolConfig({
  env = process.env,
  configFile = ORCHESTRATOR_CONFIG_FILE,
} = {}) {
  const fileConfig = parseConfigFile(configFile);
  const maxWorkers = parseNonNegativeInteger(env.ORC_MAX_WORKERS, 'ORC_MAX_WORKERS');
  const provider = env.ORC_WORKER_PROVIDER ?? fileConfig.provider ?? DEFAULT_WORKER_POOL_CONFIG.provider;
  const model = env.ORC_WORKER_MODEL ?? fileConfig.model ?? DEFAULT_WORKER_POOL_CONFIG.model;

  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported worker pool provider: ${provider}`);
  }

  return {
    max_workers: maxWorkers ?? fileConfig.max_workers ?? DEFAULT_WORKER_POOL_CONFIG.max_workers,
    provider,
    model,
  };
}
