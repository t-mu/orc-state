import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkerPoolConfig, loadMasterConfig, loadCoordinatorConfig, loadLeaseConfig, resolveWorkerModel, isSupportedExecutionMode } from './providers.ts';
import type { WorkerPoolConfig } from './providers.ts';

let settings: Record<string, unknown>;

beforeEach(() => {
  settings = {};
});

describe('loadWorkerPoolConfig', () => {
  it('reads worker pool settings from orchestrator settings', () => {
    settings = {
      worker_pool: {
        max_workers: 3,
        provider: 'gemini',
        model: 'gemini-2.5-pro',
      },
    };

    expect(loadWorkerPoolConfig({ env: {}, settings })).toEqual({
      max_workers: 3,
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      provider_models: {},
      execution_mode: 'full-access',
      runtime: 'cli',
      sandbox_network: 'restricted',
    });
  });

  it('lets env overrides win over settings values', () => {
    settings = {
      worker_pool: {
        max_workers: 1,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
      },
    };

    expect(loadWorkerPoolConfig({
      env: {
        ORC_MAX_WORKERS: '2',
        ORC_WORKER_PROVIDER: 'codex',
        ORC_WORKER_MODEL: 'o4-mini',
      },
      settings,
    })).toEqual({
      max_workers: 2,
      provider: 'codex',
      model: 'o4-mini',
      provider_models: {},
      execution_mode: 'full-access',
      runtime: 'cli',
      sandbox_network: 'restricted',
    });
  });

  it('reads execution_mode from worker_pool config', () => {
    settings = {
      worker_pool: { provider: 'codex', execution_mode: 'sandbox' },
    };

    expect(loadWorkerPoolConfig({ env: {}, settings })).toMatchObject({
      execution_mode: 'sandbox',
    });
  });

  it('ORC_WORKER_EXECUTION_MODE env var overrides config execution_mode', () => {
    settings = {
      worker_pool: { provider: 'codex', execution_mode: 'sandbox' },
    };

    expect(loadWorkerPoolConfig({
      env: { ORC_WORKER_EXECUTION_MODE: 'full-access' },
      settings,
    })).toMatchObject({
      execution_mode: 'full-access',
      runtime: 'cli',
      sandbox_network: 'restricted',
    });
  });

  it('reads runtime from worker_pool config; env wins; default is cli (task 203)', () => {
    settings = { worker_pool: { provider: 'codex', runtime: 'structured' } };
    expect(loadWorkerPoolConfig({ env: {}, settings }).runtime).toBe('structured');
    expect(loadWorkerPoolConfig({ env: { ORC_WORKER_RUNTIME: 'cli' }, settings }).runtime).toBe('cli');
    settings = { worker_pool: { provider: 'codex' } };
    expect(loadWorkerPoolConfig({ env: {}, settings }).runtime).toBe('cli');
  });

  it('rejects an unknown worker runtime instead of guessing', () => {
    settings = { worker_pool: { provider: 'codex', runtime: 'api' } };
    expect(() => loadWorkerPoolConfig({ env: {}, settings })).toThrow('Invalid worker runtime "api"');
  });

  it('reads the sandbox network opt-in; env wins; default is restricted; unknown values are refused (task 230)', () => {
    settings = { worker_pool: { provider: 'codex', sandbox_network: 'open' } };
    expect(loadWorkerPoolConfig({ env: {}, settings }).sandbox_network).toBe('open');
    expect(loadWorkerPoolConfig({ env: { ORC_WORKER_SANDBOX_NETWORK: 'restricted' }, settings }).sandbox_network).toBe('restricted');
    settings = { worker_pool: { provider: 'codex' } };
    expect(loadWorkerPoolConfig({ env: {}, settings }).sandbox_network).toBe('restricted');
    settings = { worker_pool: { provider: 'codex', sandbox_network: 'wide' } };
    expect(() => loadWorkerPoolConfig({ env: {}, settings })).toThrow('Invalid worker sandbox network "wide"');
  });

  it('defaults execution_mode to full-access when absent from config', () => {
    settings = { worker_pool: { provider: 'codex' } };

    expect(loadWorkerPoolConfig({ env: {}, settings })).toMatchObject({
      execution_mode: 'full-access',
      runtime: 'cli',
      sandbox_network: 'restricted',
    });
  });

  it('falls back to default_provider when worker_pool.provider is absent', () => {
    settings = {
      default_provider: 'claude',
      worker_pool: {
        max_workers: 2,
      },
    };

    const result = loadWorkerPoolConfig({ env: {}, settings });
    expect(result.provider).toBe('claude');
  });

  it('throws on invalid default_provider', () => {
    settings = {
      default_provider: 'notaprovider',
    };

    expect(() => loadWorkerPoolConfig({ env: {}, settings })).toThrow(/invalid default_provider/i);
  });

  it('prefers worker_pool.provider over default_provider', () => {
    settings = {
      default_provider: 'gemini',
      worker_pool: {
        provider: 'claude',
      },
    };

    const result = loadWorkerPoolConfig({ env: {}, settings });
    expect(result.provider).toBe('claude');
  });

  it('parses provider_models from config', () => {
    settings = {
      worker_pool: {
        provider: 'claude',
        model: 'default-model',
        provider_models: {
          claude: 'claude-sonnet-4-6',
          codex: 'gpt-5.4',
        },
      },
    };

    const result = loadWorkerPoolConfig({ env: {}, settings });
    expect(result.provider_models).toEqual({ claude: 'claude-sonnet-4-6', codex: 'gpt-5.4' });
    expect(result.model).toBe('default-model');
  });
});

describe('resolveWorkerModel', () => {
  it('returns provider_models entry over generic model', () => {
    const config: WorkerPoolConfig = {
      max_workers: 1,
      provider: 'claude',
      model: 'generic-model',
      provider_models: { claude: 'claude-sonnet-4-6', codex: 'gpt-5.4' },
      execution_mode: 'full-access',
      runtime: 'cli', sandbox_network: 'restricted',
    };
    expect(resolveWorkerModel(config)).toBe('claude-sonnet-4-6');
    expect(resolveWorkerModel(config, 'codex')).toBe('gpt-5.4');
  });

  it('falls back to generic model when no provider_models entry', () => {
    const config: WorkerPoolConfig = {
      max_workers: 1,
      provider: 'gemini',
      model: 'generic-model',
      provider_models: {},
      execution_mode: 'full-access',
      runtime: 'cli', sandbox_network: 'restricted',
    };
    expect(resolveWorkerModel(config)).toBe('generic-model');
  });

  it('returns null when no model configured', () => {
    const config: WorkerPoolConfig = {
      max_workers: 1,
      provider: 'claude',
      model: null,
      provider_models: {},
      execution_mode: 'full-access',
      runtime: 'cli',
      sandbox_network: 'restricted',
    };
    expect(resolveWorkerModel(config)).toBeNull();
  });
});

describe('loadMasterConfig', () => {
  it('reads master section from config', () => {
    settings = {
      master: { provider: 'claude', model: 'claude-opus-4-6' },
    };

    const result = loadMasterConfig({ env: {}, settings });
    expect(result).toEqual({ provider: 'claude', model: 'claude-opus-4-6', execution_mode: 'full-access' });
  });

  it('falls back to default_provider when master.provider absent', () => {
    settings = {
      default_provider: 'gemini',
    };

    const result = loadMasterConfig({ env: {}, settings });
    expect(result.provider).toBe('gemini');
  });

  it('env vars override settings', () => {
    settings = {
      master: { provider: 'claude', model: 'claude-opus-4-6' },
    };

    const result = loadMasterConfig({
      env: { ORC_MASTER_PROVIDER: 'codex', ORC_MASTER_MODEL: 'o4-mini' },
      settings,
    });
    expect(result).toEqual({ provider: 'codex', model: 'o4-mini', execution_mode: 'full-access' });
  });
});

describe('loadCoordinatorConfig', () => {
  it('reads coordinator section from config', () => {
    settings = {
      coordinator: {
        mode: 'monitor',
        tick_interval_ms: 10000,
        concurrency_limit: 4,
      },
    };

    const result = loadCoordinatorConfig({ settings });
    expect(result.mode).toBe('monitor');
    expect(result.tick_interval_ms).toBe(10000);
    expect(result.concurrency_limit).toBe(4);
    // Non-specified values fall back to defaults
    expect(result.run_start_timeout_ms).toBe(600000);
  });

  it('returns all defaults when config is absent', () => {
    const result = loadCoordinatorConfig({ settings: {} });
    expect(result.mode).toBe('autonomous');
    expect(result.tick_interval_ms).toBe(30000);
    expect(result.concurrency_limit).toBe(8);
  });

  it('parses memory_prune_interval_ms from config', () => {
    settings = { coordinator: { memory_prune_interval_ms: 7200000 } };
    const result = loadCoordinatorConfig({ settings });
    expect(result.memory_prune_interval_ms).toBe(7200000);
  });

  it('parses memory_prune_interval_ms of 0 (disable periodic pruning)', () => {
    settings = { coordinator: { memory_prune_interval_ms: 0 } };
    const result = loadCoordinatorConfig({ settings });
    expect(result.memory_prune_interval_ms).toBe(0);
  });

  it('defaults memory_prune_interval_ms to 3600000', () => {
    const result = loadCoordinatorConfig({ settings: {} });
    expect(result.memory_prune_interval_ms).toBe(3600000);
  });

  it('defaults merge_strategy to direct', () => {
    const result = loadCoordinatorConfig({ settings: {} });
    expect(result.merge_strategy).toBe('direct');
  });

  it('parses merge_strategy from config', () => {
    settings = { coordinator: { merge_strategy: 'pr' } };
    const result = loadCoordinatorConfig({ settings });
    expect(result.merge_strategy).toBe('pr');
  });

  it('defaults merge_strategy to direct for unknown value', () => {
    settings = { coordinator: { merge_strategy: 'squash' } };
    const result = loadCoordinatorConfig({ settings });
    expect(result.merge_strategy).toBe('direct');
  });

  it('parses pr_provider, pr_push_remote, pr_finalize_lease_ms', () => {
    settings = {
      coordinator: {
        pr_provider: 'github',
        pr_push_remote: 'upstream',
        pr_finalize_lease_ms: 3600000,
      },
    };
    const result = loadCoordinatorConfig({ settings });
    expect(result.pr_provider).toBe('github');
    expect(result.pr_push_remote).toBe('upstream');
    expect(result.pr_finalize_lease_ms).toBe(3600000);
  });

  it('defaults pr_provider to null, pr_push_remote to origin, pr_finalize_lease_ms to 86400000', () => {
    const result = loadCoordinatorConfig({ settings: {} });
    expect(result.pr_provider).toBeNull();
    expect(result.pr_push_remote).toBe('origin');
    expect(result.pr_finalize_lease_ms).toBe(86400000);
  });
});

describe('loadLeaseConfig', () => {
  it('reads lease section from config', () => {
    settings = {
      leases: { default_ms: 900000, finalize_ms: 1800000 },
    };

    const result = loadLeaseConfig({ settings });
    expect(result).toEqual({ default_ms: 900000, finalize_ms: 1800000 });
  });

  it('returns defaults when config is absent', () => {
    const result = loadLeaseConfig({ settings: {} });
    expect(result.default_ms).toBe(1800000);
    expect(result.finalize_ms).toBe(3600000);
  });
});

describe('execution mode', () => {
  it('isSupportedExecutionMode accepts valid modes', () => {
    expect(isSupportedExecutionMode('full-access')).toBe(true);
    expect(isSupportedExecutionMode('sandbox')).toBe(true);
  });

  it('isSupportedExecutionMode rejects invalid modes', () => {
    expect(isSupportedExecutionMode('admin')).toBe(false);
    expect(isSupportedExecutionMode('')).toBe(false);
    expect(isSupportedExecutionMode('FULL-ACCESS')).toBe(false);
  });
});

describe('loadMasterConfig execution_mode', () => {
  it('defaults to full-access when absent', () => {
    const result = loadMasterConfig({ env: {}, settings: {} });
    expect(result.execution_mode).toBe('full-access');
  });

  it('reads from master.execution_mode in config', () => {
    settings = {
      master: { provider: 'claude', execution_mode: 'sandbox' },
    };
    const result = loadMasterConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('sandbox');
  });

  it('falls back to default_execution_mode', () => {
    settings = {
      default_execution_mode: 'sandbox',
    };
    const result = loadMasterConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('sandbox');
  });

  it('master.execution_mode takes priority over default_execution_mode', () => {
    settings = {
      default_execution_mode: 'sandbox',
      master: { execution_mode: 'full-access' },
    };
    const result = loadMasterConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('full-access');
  });

  it('env var ORC_MASTER_EXECUTION_MODE overrides config', () => {
    settings = {
      master: { execution_mode: 'full-access' },
    };
    const result = loadMasterConfig({ env: { ORC_MASTER_EXECUTION_MODE: 'sandbox' }, settings });
    expect(result.execution_mode).toBe('sandbox');
  });

  it('warns and defaults on invalid execution_mode', () => {
    settings = {
      master: { execution_mode: 'invalid-mode' },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadMasterConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('full-access');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid-mode'));
    warnSpy.mockRestore();
  });
});

describe('loadWorkerPoolConfig execution_mode', () => {
  it('defaults to full-access when absent', () => {
    const result = loadWorkerPoolConfig({ env: {}, settings: {} });
    expect(result.execution_mode).toBe('full-access');
  });

  it('reads from worker_pool.execution_mode in config', () => {
    settings = {
      worker_pool: { execution_mode: 'sandbox' },
    };
    const result = loadWorkerPoolConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('sandbox');
  });

  it('falls back to default_execution_mode', () => {
    settings = {
      default_execution_mode: 'sandbox',
    };
    const result = loadWorkerPoolConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('sandbox');
  });

  it('worker_pool.execution_mode takes priority over default_execution_mode', () => {
    settings = {
      default_execution_mode: 'sandbox',
      worker_pool: { execution_mode: 'full-access' },
    };
    const result = loadWorkerPoolConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('full-access');
  });

  it('env var ORC_WORKER_EXECUTION_MODE overrides config', () => {
    settings = {
      worker_pool: { execution_mode: 'full-access' },
    };
    const result = loadWorkerPoolConfig({ env: { ORC_WORKER_EXECUTION_MODE: 'sandbox' }, settings });
    expect(result.execution_mode).toBe('sandbox');
  });

  it('warns and defaults on invalid execution_mode', () => {
    settings = {
      worker_pool: { execution_mode: 'bad-value' },
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadWorkerPoolConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('full-access');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bad-value'));
    warnSpy.mockRestore();
  });
});

describe('parseRawConfigFile default_execution_mode', () => {
  it('throws on invalid default_execution_mode in settings', () => {
    settings = {
      default_execution_mode: 'not-a-mode',
    };
    expect(() => loadMasterConfig({ env: {}, settings })).toThrow(/invalid default_execution_mode/i);
  });

  it('accepts valid default_execution_mode in settings', () => {
    settings = {
      default_execution_mode: 'sandbox',
    };
    const result = loadMasterConfig({ env: {}, settings });
    expect(result.execution_mode).toBe('sandbox');
  });
});
