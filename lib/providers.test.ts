import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkerPoolConfig, loadMasterConfig, loadCoordinatorConfig, loadLeaseConfig, resolveWorkerModel } from './providers.ts';
import type { WorkerPoolConfig } from './providers.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-providers-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadWorkerPoolConfig', () => {
  it('reads worker pool settings from orchestrator config file', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      worker_pool: {
        max_workers: 3,
        provider: 'gemini',
        model: 'gemini-2.5-pro',
      },
    }));

    expect(loadWorkerPoolConfig({ env: {}, configFile: configPath })).toEqual({
      max_workers: 3,
      provider: 'gemini',
      model: 'gemini-2.5-pro',
      provider_models: {},
    });
  });

  it('lets env overrides win over config file values', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      worker_pool: {
        max_workers: 1,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
      },
    }));

    expect(loadWorkerPoolConfig({
      env: {
        ORC_MAX_WORKERS: '2',
        ORC_WORKER_PROVIDER: 'codex',
        ORC_WORKER_MODEL: 'o4-mini',
      },
      configFile: configPath,
    })).toEqual({
      max_workers: 2,
      provider: 'codex',
      model: 'o4-mini',
      provider_models: {},
    });
  });

  it('falls back to default_provider when worker_pool.provider is absent', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      default_provider: 'claude',
      worker_pool: {
        max_workers: 2,
      },
    }));

    const result = loadWorkerPoolConfig({ env: {}, configFile: configPath });
    expect(result.provider).toBe('claude');
  });

  it('throws on invalid default_provider', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      default_provider: 'notaprovider',
    }));

    expect(() => loadWorkerPoolConfig({ env: {}, configFile: configPath })).toThrow(/invalid default_provider/i);
  });

  it('prefers worker_pool.provider over default_provider', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      default_provider: 'gemini',
      worker_pool: {
        provider: 'claude',
      },
    }));

    const result = loadWorkerPoolConfig({ env: {}, configFile: configPath });
    expect(result.provider).toBe('claude');
  });

  it('parses provider_models from config', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      worker_pool: {
        provider: 'claude',
        model: 'default-model',
        provider_models: {
          claude: 'claude-sonnet-4-6',
          codex: 'gpt-5.4',
        },
      },
    }));

    const result = loadWorkerPoolConfig({ env: {}, configFile: configPath });
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
    };
    expect(resolveWorkerModel(config)).toBe('generic-model');
  });

  it('returns null when no model configured', () => {
    const config: WorkerPoolConfig = {
      max_workers: 1,
      provider: 'claude',
      model: null,
      provider_models: {},
    };
    expect(resolveWorkerModel(config)).toBeNull();
  });
});

describe('loadMasterConfig', () => {
  it('reads master section from config', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      master: { provider: 'claude', model: 'claude-opus-4-6' },
    }));

    const result = loadMasterConfig({ env: {}, configFile: configPath });
    expect(result).toEqual({ provider: 'claude', model: 'claude-opus-4-6' });
  });

  it('falls back to default_provider when master.provider absent', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      default_provider: 'gemini',
    }));

    const result = loadMasterConfig({ env: {}, configFile: configPath });
    expect(result.provider).toBe('gemini');
  });

  it('env vars override config file', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      master: { provider: 'claude', model: 'claude-opus-4-6' },
    }));

    const result = loadMasterConfig({
      env: { ORC_MASTER_PROVIDER: 'codex', ORC_MASTER_MODEL: 'o4-mini' },
      configFile: configPath,
    });
    expect(result).toEqual({ provider: 'codex', model: 'o4-mini' });
  });
});

describe('loadCoordinatorConfig', () => {
  it('reads coordinator section from config', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      coordinator: {
        mode: 'monitor',
        tick_interval_ms: 10000,
        concurrency_limit: 4,
      },
    }));

    const result = loadCoordinatorConfig({ configFile: configPath });
    expect(result.mode).toBe('monitor');
    expect(result.tick_interval_ms).toBe(10000);
    expect(result.concurrency_limit).toBe(4);
    // Non-specified values fall back to defaults
    expect(result.run_start_timeout_ms).toBe(600000);
  });

  it('returns all defaults when config is absent', () => {
    const result = loadCoordinatorConfig({ configFile: join(dir, 'nonexistent.json') });
    expect(result.mode).toBe('autonomous');
    expect(result.tick_interval_ms).toBe(30000);
    expect(result.concurrency_limit).toBe(8);
  });
});

describe('loadLeaseConfig', () => {
  it('reads lease section from config', () => {
    const configPath = join(dir, 'orchestrator.config.json');
    writeFileSync(configPath, JSON.stringify({
      leases: { default_ms: 900000, finalize_ms: 1800000 },
    }));

    const result = loadLeaseConfig({ configFile: configPath });
    expect(result).toEqual({ default_ms: 900000, finalize_ms: 1800000 });
  });

  it('returns defaults when config is absent', () => {
    const result = loadLeaseConfig({ configFile: join(dir, 'nonexistent.json') });
    expect(result.default_ms).toBe(1800000);
    expect(result.finalize_ms).toBe(3600000);
  });
});
