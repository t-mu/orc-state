import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('orch-gc-workers-cli-test-');
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

describe('cli/gc-workers.ts', () => {
  it('removes offline workers immediately', async () => {
    writeAgents([
      { agent_id: 'offline', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'dead', provider: 'claude', status: 'dead', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'running', provider: 'claude', status: 'running', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'scout-1', provider: 'claude', role: 'scout', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
    ]);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ heartbeatProbe: () => Promise.resolve(true) }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/gc-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./gc-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    const ids = readAgents().map((a: Record<string, unknown>) => a.agent_id);
    expect(ids).toEqual(['running', 'master', 'scout-1']);
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
    process.argv = ['node', 'cli/gc-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./gc-workers.ts');
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

  it('keeps an offline or dead worker that still holds an active claim', async () => {
    writeAgents([
      { agent_id: 'claimed', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
      { agent_id: 'idle', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
    ]);
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [
      { run_id: 'run-1', task_ref: 'proj/task-1', agent_id: 'claimed', state: 'claimed', claimed_at: '2026-01-01T00:00:00Z', lease_expires_at: '2099-01-01T00:00:00Z' },
    ] }));
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ heartbeatProbe: () => Promise.resolve(false) }) }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/gc-workers.ts'];
    setStateDirEnv(dir);
    try {
      await import('./gc-workers.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(readAgents().map((a: Record<string, unknown>) => a.agent_id)).toEqual(['claimed']);
  });

});
