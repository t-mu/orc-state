import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('orch-clear-workers-cli-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function setStateDirEnv(value: string | undefined) {
  if (value == null) delete process.env.ORC_STATE_DIR;
  else process.env.ORC_STATE_DIR = value;
}

function writeAgents(agents: unknown[]) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

describe('cli/clear-workers.ts', () => {
  it('removes offline workers immediately', async () => {
    writeAgents([
      { agent_id: 'offline', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'running', provider: 'claude', status: 'running', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ heartbeatProbe: () => Promise.resolve(true) }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/clear-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./clear-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    const ids = readAgents().map((a: Record<string, unknown>) => a.agent_id);
    expect(ids).toEqual(['running']);
  });

  it('removes running workers with dead session probes', async () => {
    writeAgents([
      { agent_id: 'stale', provider: 'claude', status: 'running', session_handle: 'stale-handle', registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'alive', provider: 'claude', status: 'running', session_handle: 'alive-handle', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: (handle: string) => Promise.resolve(handle === 'alive-handle'),
      }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/clear-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./clear-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    const ids = readAgents().map((a: Record<string, unknown>) => a.agent_id);
    expect(ids).toEqual(['alive']);
  });

  it('does not remove workers when probe throws', async () => {
    writeAgents([
      { agent_id: 'x', provider: 'claude', status: 'running', session_handle: 'x-handle', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: () => { throw new Error('pty unavailable'); },
      }),
    }));

    const before = readAgents();
    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/clear-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./clear-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(readAgents()).toEqual(before);
  });
});
