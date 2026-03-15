import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'orch-gc-workers-cli-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setStateDirEnv(value: string | undefined) {
  if (value == null) delete process.env.ORCH_STATE_DIR;
  else process.env.ORCH_STATE_DIR = value;
}

function writeAgents(agents: unknown[]) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

describe('cli/gc-workers.ts', () => {
  it('marks unreachable workers offline when not deregistering', async () => {
    writeAgents([
      { agent_id: 'alive', provider: 'claude', status: 'running', session_handle: 'alive-handle', provider_ref: { id: 1 }, registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'stale', provider: 'claude', status: 'running', session_handle: 'stale-handle', provider_ref: { id: 2 }, registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: async (handle: string) => {
          await Promise.resolve();
          return handle === 'alive-handle';
        },
      }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/gc-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./gc-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    const agents = readAgents();
    expect(agents.find((a: Record<string, unknown>) => a.agent_id === 'alive').status).toBe('running');
    const stale = agents.find((a: Record<string, unknown>) => a.agent_id === 'stale');
    expect(stale.status).toBe('offline');
    expect(stale.session_handle).toBeNull();
    expect(stale.provider_ref).toBeNull();
  });

  it('removes unreachable workers with --deregister', async () => {
    writeAgents([
      { agent_id: 'stale', provider: 'claude', status: 'running', session_handle: 'stale-handle', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: async () => {
          await Promise.resolve();
          return false;
        },
      }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/gc-workers.ts', '--deregister'];
    setStateDirEnv(dir);
    try {
      await import('./gc-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(readAgents()).toEqual([]);
  });

  it('ignores adapter errors and leaves workers unchanged', async () => {
    writeAgents([
      { agent_id: 'x', provider: 'claude', status: 'running', session_handle: 'x-handle', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: async () => {
          await Promise.resolve();
          throw new Error('probe failed');
        },
      }),
    }));

    const before = readAgents();
    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/gc-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./gc-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(readAgents()).toEqual(before);
  });
});
