import { ACTIVE_PROJECT } from './paths.ts';
import { projectConfigObject } from './projectContext.ts';
import { logger } from './logger.ts';
import { DEFAULT_LEASE_MS, FINALIZE_LEASE_MS } from './constants.ts';

export const PROVIDERS = ['codex', 'claude', 'gemini'] as const;
export type ProviderName = typeof PROVIDERS[number];

export type ExecutionMode = 'full-access' | 'sandbox';
export const EXECUTION_MODES: readonly ExecutionMode[] = ['full-access', 'sandbox'] as const;

export function isSupportedExecutionMode(value: string): value is ExecutionMode {
  return EXECUTION_MODES.includes(value as ExecutionMode);
}

/**
 * Worker runtime (task 203). `cli` drives the provider's interactive CLI in a
 * terminal (PTY/tmux). `structured` drives a provider's structured local
 * protocol where one is proven (Codex app-server); providers without one keep
 * the CLI runtime as an explicit fallback.
 */
export type WorkerRuntime = 'cli' | 'structured';
export const WORKER_RUNTIMES: readonly WorkerRuntime[] = ['cli', 'structured'] as const;

/**
 * Network a sandboxed project worker gets for its control socket (task 230).
 * `restricted` allows only that socket's path, which only Claude's macOS
 * sandbox honours; `open` lets Claude on Linux reach every Unix socket and
 * gives Codex workers network access, so their lifecycle commands work.
 */
export type SandboxNetwork = 'restricted' | 'open';
export const SANDBOX_NETWORKS: readonly SandboxNetwork[] = ['restricted', 'open'] as const;

export interface WorkerPoolConfig {
  max_workers: number;
  provider: ProviderName;
  model: string | null;
  provider_models: Partial<Record<ProviderName, string>>;
  execution_mode: ExecutionMode;
  runtime: WorkerRuntime;
  sandbox_network: SandboxNetwork;
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
  // PR merge strategy
  merge_strategy: 'direct' | 'pr';
  pr_provider: 'github' | null;
  pr_push_remote: string;
  pr_finalize_lease_ms: number;
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
  runtime: 'cli' as WorkerRuntime,
  sandbox_network: 'restricted' as SandboxNetwork,
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
  merge_strategy: 'direct' as const,
  pr_provider: null,
  pr_push_remote: 'origin',
  pr_finalize_lease_ms: 86_400_000,
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

/**
 * Settings shaped as nested objects (`worker_pool.max_workers` →
 * `{ worker_pool: { max_workers } }`), as `projectConfigObject` builds them
 * from the global registry. Loaders take it as a parameter so tests can inject
 * settings; by default they read the registry.
 */
export type OrcSettings = Record<string, unknown>;

interface RawSettings {
  default_provider?: string | null;
  default_execution_mode?: string | null;
  master?: Record<string, unknown> | null;
  worker_pool?: Record<string, unknown> | null;
  coordinator?: Record<string, unknown> | null;
  leases?: Record<string, unknown> | null;
}

/** Registry settings: the active project's over the global ones, or the global ones when no project is active. */
export function storedSettings(): OrcSettings {
  return projectConfigObject(ACTIVE_PROJECT);
}

function parseSettings(settings: OrcSettings): RawSettings {
  const defaultProvider = typeof settings.default_provider === 'string' ? settings.default_provider : null;

  if (defaultProvider != null && !isSupportedProvider(defaultProvider)) {
    throw new Error(`Invalid default_provider setting: ${defaultProvider}. Must be codex, claude, or gemini.`);
  }

  const defaultExecutionMode = typeof settings.default_execution_mode === 'string' ? settings.default_execution_mode : null;

  if (defaultExecutionMode != null && !isSupportedExecutionMode(defaultExecutionMode)) {
    throw new Error(`Invalid default_execution_mode setting: ${defaultExecutionMode}. Must be full-access or sandbox.`);
  }

  const result: RawSettings = { default_provider: defaultProvider, default_execution_mode: defaultExecutionMode };

  for (const section of ['master', 'worker_pool', 'coordinator', 'leases'] as const) {
    const value = settings[section];
    if (value == null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid orchestrator settings: ${section} must be an object`);
    }
    result[section] = value as Record<string, unknown>;
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

/**
 * Resolve the provider for a task-scoped worker at dispatch time.
 * Uses the task's required_provider when set; falls back to the pool default.
 * This is a per-task decision — it does not imply a homogeneous pool of
 * pre-registered workers.
 */
export function resolveWorkerProvider(
  requiredProvider: ProviderName | null | undefined,
  defaults: Pick<WorkerPoolConfig, 'provider'>,
): ProviderName {
  return requiredProvider ?? defaults.provider;
}

/** Resolve the effective model for a worker given pool config and provider. */
export function resolveWorkerModel(config: WorkerPoolConfig, provider?: ProviderName): string | null {
  const p = provider ?? config.provider;
  return config.provider_models[p] ?? config.model;
}

export function loadWorkerPoolConfig({
  env = process.env,
  settings = storedSettings(),
}: {
  env?: NodeJS.ProcessEnv;
  settings?: OrcSettings | undefined;
} = {}): WorkerPoolConfig {
  const raw = parseSettings(settings);
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

  const runtimeRaw = env.ORC_WORKER_RUNTIME ?? (wp.runtime as string | null) ?? null;
  if (runtimeRaw != null && !WORKER_RUNTIMES.includes(runtimeRaw as WorkerRuntime)) {
    throw new Error(`Invalid worker runtime "${runtimeRaw}". Must be cli or structured.`);
  }

  const sandboxNetworkRaw = env.ORC_WORKER_SANDBOX_NETWORK ?? (wp.sandbox_network as string | null) ?? null;
  if (sandboxNetworkRaw != null && !SANDBOX_NETWORKS.includes(sandboxNetworkRaw as SandboxNetwork)) {
    throw new Error(`Invalid worker sandbox network "${sandboxNetworkRaw}". Must be restricted or open.`);
  }

  return {
    max_workers: maxWorkers ?? parseNonNegativeInteger(wp.max_workers, 'worker_pool.max_workers') ?? DEFAULT_WORKER_POOL_CONFIG.max_workers,
    provider,
    model: model ?? null,
    provider_models: parseProviderModels(wp.provider_models),
    execution_mode,
    runtime: (runtimeRaw as WorkerRuntime | null) ?? DEFAULT_WORKER_POOL_CONFIG.runtime,
    sandbox_network: (sandboxNetworkRaw as SandboxNetwork | null) ?? DEFAULT_WORKER_POOL_CONFIG.sandbox_network,
  };
}

export function loadMasterConfig({
  env = process.env,
  settings = storedSettings(),
}: {
  env?: NodeJS.ProcessEnv;
  settings?: OrcSettings | undefined;
} = {}): MasterConfig {
  const raw = parseSettings(settings);
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
  settings = storedSettings(),
}: {
  settings?: OrcSettings | undefined;
} = {}): CoordinatorConfig {
  const raw = parseSettings(settings);
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
    merge_strategy: (cc.merge_strategy === 'pr' ? 'pr' : DEFAULT_COORDINATOR_CONFIG.merge_strategy),
    pr_provider: (cc.pr_provider === 'github' ? 'github' : DEFAULT_COORDINATOR_CONFIG.pr_provider),
    pr_push_remote: (typeof cc.pr_push_remote === 'string' && cc.pr_push_remote ? cc.pr_push_remote : DEFAULT_COORDINATOR_CONFIG.pr_push_remote),
    pr_finalize_lease_ms: parsePositiveInteger(cc.pr_finalize_lease_ms, 'coordinator.pr_finalize_lease_ms') ?? DEFAULT_COORDINATOR_CONFIG.pr_finalize_lease_ms,
  };
}

export function loadLeaseConfig({
  settings = storedSettings(),
}: {
  settings?: OrcSettings | undefined;
} = {}): LeaseConfig {
  const raw = parseSettings(settings);
  const lc = raw.leases ?? {};

  return {
    default_ms: parsePositiveInteger(lc.default_ms, 'leases.default_ms') ?? DEFAULT_LEASE_CONFIG.default_ms,
    finalize_ms: parsePositiveInteger(lc.finalize_ms, 'leases.finalize_ms') ?? DEFAULT_LEASE_CONFIG.finalize_ms,
  };
}
