import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkerPoolConfig } from './providers.ts';

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
});
