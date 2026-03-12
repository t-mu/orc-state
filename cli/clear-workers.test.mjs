import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'orch-clear-workers-cli-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setStateDirEnv(value) {
  if (value == null) delete process.env.ORCH_STATE_DIR;
  else process.env.ORCH_STATE_DIR = value;
}

function writeAgents(agents) {
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
      createAdapter: () => ({ heartbeatProbe: async () => true }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/clear-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./clear-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    const ids = readAgents().map((a) => a.agent_id);
    expect(ids).toEqual(['running']);
  });

  it('removes running workers with dead session probes', async () => {
    writeAgents([
      { agent_id: 'stale', provider: 'claude', status: 'running', session_handle: 'stale-handle', registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'alive', provider: 'claude', status: 'running', session_handle: 'alive-handle', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: async (handle) => handle === 'alive-handle',
      }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/clear-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./clear-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    const ids = readAgents().map((a) => a.agent_id);
    expect(ids).toEqual(['alive']);
  });

  it('does not remove workers when probe throws', async () => {
    writeAgents([
      { agent_id: 'x', provider: 'claude', status: 'running', session_handle: 'x-handle', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: async () => {
          throw new Error('pty unavailable');
        },
      }),
    }));

    const before = readAgents();
    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
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
