import { existsSync, readFileSync } from 'node:fs';
import { ORCHESTRATOR_CONFIG_FILE } from './paths.ts';
import { logger } from './logger.ts';
import { DEFAULT_LEASE_MS, FINALIZE_LEASE_MS } from './constants.ts';

export const PROVIDERS = ['codex', 'claude', 'gemini'] as const;
export type ProviderName = typeof PROVIDERS[number];

export type ExecutionMode = 'full-access' | 'sandbox';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['full-access', 'sandbox'] as const;

export function isSupportedExecutionMode(value: string): value is ExecutionMode {
  return EXECUTION_MODES.includes(value as ExecutionMode);
}

export interface WorkerPoolConfig {
  max_workers: number;
  provider: ProviderName;
  model: string | null;
  provider_models: Partial<Record<ProviderName, string>>;
  execution_mode: ExecutionMode;
}

export interface MasterConfig {
  provider: ProviderName;
  model: string | null;
  execution_mode: ExecutionMode;
}

export interface CoordinatorConfig {
  mode: string;
  tick_interval_ms: number;
  concurrency_limit: number;
  run_start_timeout_ms: number;
  session_ready_timeout_ms: number;
  session_ready_nudge_ms: number;
  session_ready_nudge_interval_ms: number;
  run_inactive_timeout_ms: number;
  run_inactive_nudge_ms: number;
  run_inactive_escalate_ms: number;
  run_inactive_nudge_interval_ms: number;
  session_start_max_attempts: number;
  session_start_retry_delay_ms: number;
  memory_prune_interval_ms: number;
  // Staleness detection thresholds (ms)
  worker_stale_soft_ms: number;
  worker_stale_nudge_ms: number;
  worker_stale_force_fail_ms: number;
}

export interface LeaseConfig {
  default_ms: number;
  finalize_ms: number;
}

export const DEFAULT_WORKER_POOL_CONFIG: Readonly<WorkerPoolConfig> = Object.freeze({
  max_workers: 0,
  provider: 'codex' as ProviderName,
  model: null,
  provider_models: Object.freeze({}),
  execution_mode: 'full-access' as ExecutionMode,
});

export const DEFAULT_MASTER_CONFIG: Readonly<MasterConfig> = Object.freeze({
  provider: 'claude' as ProviderName,
  model: null,
  execution_mode: 'full-access' as ExecutionMode,
});

export const DEFAULT_COORDINATOR_CONFIG: Readonly<CoordinatorConfig> = Object.freeze({
  mode: 'autonomous',
  tick_interval_ms: 30_000,
  concurrency_limit: 8,
  run_start_timeout_ms: 600_000,
  session_ready_timeout_ms: 120_000,
  session_ready_nudge_ms: 15_000,
  session_ready_nudge_interval_ms: 30_000,
  run_inactive_timeout_ms: 1_800_000,
  run_inactive_nudge_ms: 600_000,
  run_inactive_escalate_ms: 900_000,
  run_inactive_nudge_interval_ms: 300_000,
  session_start_max_attempts: 3,
  session_start_retry_delay_ms: 30_000,
  memory_prune_interval_ms: 3_600_000,
  worker_stale_soft_ms: 1_800_000,
  worker_stale_nudge_ms: 3_600_000,
  worker_stale_force_fail_ms: 7_200_000,
});

export const DEFAULT_LEASE_CONFIG: Readonly<LeaseConfig> = Object.freeze({
  default_ms: DEFAULT_LEASE_MS,
  finalize_ms: FINALIZE_LEASE_MS,
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

function parsePositiveInteger(rawValue: unknown, fieldName: string): number | null {
  if (rawValue == null || rawValue === '') return null;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

interface RawConfigFile {
  default_provider?: string | null;
  default_execution_mode?: string | null;
  master?: Record<string, unknown> | null;
  worker_pool?: Record<string, unknown> | null;
  coordinator?: Record<string, unknown> | null;
  leases?: Record<string, unknown> | null;
}

function parseRawConfigFile(configFile: string = ORCHESTRATOR_CONFIG_FILE): RawConfigFile {
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

  const defaultExecutionMode = typeof topLevel.default_execution_mode === 'string' ? topLevel.default_execution_mode : null;

  if (defaultExecutionMode != null && !isSupportedExecutionMode(defaultExecutionMode)) {
    throw new Error(`Invalid default_execution_mode in ${configFile}: ${defaultExecutionMode}. Must be full-access or sandbox.`);
  }

  const result: RawConfigFile = { default_provider: defaultProvider, default_execution_mode: defaultExecutionMode };

  if (topLevel.master != null) {
    if (typeof topLevel.master !== 'object' || Array.isArray(topLevel.master)) {
      throw new Error(`Invalid orchestrator config at ${configFile}: master must be an object`);
    }
    result.master = topLevel.master as Record<string, unknown>;
  }

  if (topLevel.worker_pool != null) {
    if (typeof topLevel.worker_pool !== 'object' || Array.isArray(topLevel.worker_pool)) {
      throw new Error(`Invalid orchestrator config at ${configFile}: worker_pool must be an object`);
    }
    result.worker_pool = topLevel.worker_pool as Record<string, unknown>;
  }

  if (topLevel.coordinator != null) {
    if (typeof topLevel.coordinator !== 'object' || Array.isArray(topLevel.coordinator)) {
      throw new Error(`Invalid orchestrator config at ${configFile}: coordinator must be an object`);
    }
    result.coordinator = topLevel.coordinator as Record<string, unknown>;
  }

  if (topLevel.leases != null) {
    if (typeof topLevel.leases !== 'object' || Array.isArray(topLevel.leases)) {
      throw new Error(`Invalid orchestrator config at ${configFile}: leases must be an object`);
    }
    result.leases = topLevel.leases as Record<string, unknown>;
  }

  return result;
}

function parseProviderModels(raw: unknown): Partial<Record<ProviderName, string>> {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Partial<Record<ProviderName, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isSupportedProvider(key) && typeof value === 'string' && value) {
      result[key] = value;
    }
  }
  return result;
}

/** Resolve the effective model for a worker given pool config and provider. */
export function resolveWorkerModel(config: WorkerPoolConfig, provider?: ProviderName): string | null {
  const p = provider ?? config.provider;
  return config.provider_models[p] ?? config.model;
}

export function loadWorkerPoolConfig({
  env = process.env,
  configFile = ORCHESTRATOR_CONFIG_FILE,
}: {
  env?: NodeJS.ProcessEnv;
  configFile?: string;
} = {}): WorkerPoolConfig {
  const raw = parseRawConfigFile(configFile);
  const wp = raw.worker_pool ?? {};
  const maxWorkers = parseNonNegativeInteger(env.ORC_MAX_WORKERS, 'ORC_MAX_WORKERS');
  const provider = (env.ORC_WORKER_PROVIDER ?? (wp.provider as string | null) ?? raw.default_provider ?? DEFAULT_WORKER_POOL_CONFIG.provider);
  const model = env.ORC_WORKER_MODEL ?? (wp.model as string | null) ?? DEFAULT_WORKER_POOL_CONFIG.model;

  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported worker pool provider: ${provider}`);
  }

  const executionModeRaw = env.ORC_WORKER_EXECUTION_MODE ?? (wp.execution_mode as string | null) ?? raw.default_execution_mode ?? null;
  let execution_mode: ExecutionMode = 'full-access';
  if (executionModeRaw != null) {
    if (isSupportedExecutionMode(executionModeRaw)) {
      execution_mode = executionModeRaw;
    } else {
      logger.warn(`Invalid execution_mode "${executionModeRaw}" for worker_pool — falling back to 'full-access'`);
    }
  }

  return {
    max_workers: maxWorkers ?? parseNonNegativeInteger(wp.max_workers, 'worker_pool.max_workers') ?? DEFAULT_WORKER_POOL_CONFIG.max_workers,
    provider,
    model: model ?? null,
    provider_models: parseProviderModels(wp.provider_models),
    execution_mode,
  };
}

export function loadMasterConfig({
  env = process.env,
  configFile = ORCHESTRATOR_CONFIG_FILE,
}: {
  env?: NodeJS.ProcessEnv;
  configFile?: string;
} = {}): MasterConfig {
  const raw = parseRawConfigFile(configFile);
  const mc = raw.master ?? {};
  const provider = env.ORC_MASTER_PROVIDER ?? (mc.provider as string | null) ?? raw.default_provider ?? DEFAULT_MASTER_CONFIG.provider;
  const model = env.ORC_MASTER_MODEL ?? (mc.model as string | null) ?? DEFAULT_MASTER_CONFIG.model;

  if (!isSupportedProvider(provider)) {
    throw new Error(`Unsupported master provider: ${provider}`);
  }

  const executionModeRaw = env.ORC_MASTER_EXECUTION_MODE ?? (mc.execution_mode as string | null) ?? raw.default_execution_mode ?? null;
  let execution_mode: ExecutionMode = 'full-access';
  if (executionModeRaw != null) {
    if (isSupportedExecutionMode(executionModeRaw)) {
      execution_mode = executionModeRaw;
    } else {
      logger.warn(`Invalid execution_mode "${executionModeRaw}" for master — falling back to 'full-access'`);
    }
  }

  return { provider, model: model ?? null, execution_mode };
}

export function loadCoordinatorConfig({
  configFile = ORCHESTRATOR_CONFIG_FILE,
}: {
  configFile?: string;
} = {}): CoordinatorConfig {
  const raw = parseRawConfigFile(configFile);
  const cc = raw.coordinator ?? {};

  const mode = typeof cc.mode === 'string' ? cc.mode : DEFAULT_COORDINATOR_CONFIG.mode;

  return {
    mode,
    tick_interval_ms: parsePositiveInteger(cc.tick_interval_ms, 'coordinator.tick_interval_ms') ?? DEFAULT_COORDINATOR_CONFIG.tick_interval_ms,
    concurrency_limit: parsePositiveInteger(cc.concurrency_limit, 'coordinator.concurrency_limit') ?? DEFAULT_COORDINATOR_CONFIG.concurrency_limit,
    run_start_timeout_ms: parsePositiveInteger(cc.run_start_timeout_ms, 'coordinator.run_start_timeout_ms') ?? DEFAULT_COORDINATOR_CONFIG.run_start_timeout_ms,
    session_ready_timeout_ms: parsePositiveInteger(cc.session_ready_timeout_ms, 'coordinator.session_ready_timeout_ms') ?? DEFAULT_COORDINATOR_CONFIG.session_ready_timeout_ms,
    session_ready_nudge_ms: parsePositiveInteger(cc.session_ready_nudge_ms, 'coordinator.session_ready_nudge_ms') ?? DEFAULT_COORDINATOR_CONFIG.session_ready_nudge_ms,
    session_ready_nudge_interval_ms: parsePositiveInteger(cc.session_ready_nudge_interval_ms, 'coordinator.session_ready_nudge_interval_ms') ?? DEFAULT_COORDINATOR_CONFIG.session_ready_nudge_interval_ms,
    run_inactive_timeout_ms: parsePositiveInteger(cc.run_inactive_timeout_ms, 'coordinator.run_inactive_timeout_ms') ?? DEFAULT_COORDINATOR_CONFIG.run_inactive_timeout_ms,
    run_inactive_nudge_ms: parsePositiveInteger(cc.run_inactive_nudge_ms, 'coordinator.run_inactive_nudge_ms') ?? DEFAULT_COORDINATOR_CONFIG.run_inactive_nudge_ms,
    run_inactive_escalate_ms: parsePositiveInteger(cc.run_inactive_escalate_ms, 'coordinator.run_inactive_escalate_ms') ?? DEFAULT_COORDINATOR_CONFIG.run_inactive_escalate_ms,
    run_inactive_nudge_interval_ms: parsePositiveInteger(cc.run_inactive_nudge_interval_ms, 'coordinator.run_inactive_nudge_interval_ms') ?? DEFAULT_COORDINATOR_CONFIG.run_inactive_nudge_interval_ms,
    session_start_max_attempts: parsePositiveInteger(cc.session_start_max_attempts, 'coordinator.session_start_max_attempts') ?? DEFAULT_COORDINATOR_CONFIG.session_start_max_attempts,
    session_start_retry_delay_ms: parsePositiveInteger(cc.session_start_retry_delay_ms, 'coordinator.session_start_retry_delay_ms') ?? DEFAULT_COORDINATOR_CONFIG.session_start_retry_delay_ms,
    memory_prune_interval_ms: parseNonNegativeInteger(cc.memory_prune_interval_ms, 'coordinator.memory_prune_interval_ms') ?? DEFAULT_COORDINATOR_CONFIG.memory_prune_interval_ms,
    worker_stale_soft_ms: parsePositiveInteger(cc.worker_stale_soft_ms, 'coordinator.worker_stale_soft_ms') ?? DEFAULT_COORDINATOR_CONFIG.worker_stale_soft_ms,
    worker_stale_nudge_ms: parsePositiveInteger(cc.worker_stale_nudge_ms, 'coordinator.worker_stale_nudge_ms') ?? DEFAULT_COORDINATOR_CONFIG.worker_stale_nudge_ms,
    worker_stale_force_fail_ms: parsePositiveInteger(cc.worker_stale_force_fail_ms, 'coordinator.worker_stale_force_fail_ms') ?? DEFAULT_COORDINATOR_CONFIG.worker_stale_force_fail_ms,
  };
}

export function loadLeaseConfig({
  configFile = ORCHESTRATOR_CONFIG_FILE,
}: {
  configFile?: string;
} = {}): LeaseConfig {
  const raw = parseRawConfigFile(configFile);
  const lc = raw.leases ?? {};

  return {
    default_ms: parsePositiveInteger(lc.default_ms, 'leases.default_ms') ?? DEFAULT_LEASE_CONFIG.default_ms,
    finalize_ms: parsePositiveInteger(lc.finalize_ms, 'leases.finalize_ms') ?? DEFAULT_LEASE_CONFIG.finalize_ms,
  };
}
