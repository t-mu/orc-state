import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'orch-remove-worker-cli-test-'));
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

describe('cli/remove-worker.ts', () => {
  it('removes worker without session handle', async () => {
    writeAgents([{ agent_id: 'bob', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' }]);

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/remove-worker.ts', 'bob'];
    setStateDirEnv(dir);
    try {
      await import('./remove-worker.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(readAgents()).toEqual([]);
  });

  it('stops session before removing worker unless --keep-session', async () => {
    writeAgents([{ agent_id: 'bob', provider: 'claude', status: 'running', session_handle: 'claude:session:bob', registered_at: '2026-01-01T00:00:00Z' }]);
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ stop }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/remove-worker.ts', 'bob'];
    setStateDirEnv(dir);
    try {
      await import('./remove-worker.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(stop).toHaveBeenCalledWith('claude:session:bob');
    expect(readAgents()).toEqual([]);
  });

  it('does not stop session when --keep-session is set', async () => {
    writeAgents([{ agent_id: 'bob', provider: 'claude', status: 'running', session_handle: 'claude:session:bob', registered_at: '2026-01-01T00:00:00Z' }]);
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ stop }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/remove-worker.ts', 'bob', '--keep-session'];
    setStateDirEnv(dir);
    try {
      await import('./remove-worker.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(stop).not.toHaveBeenCalled();
    expect(readAgents()).toEqual([]);
  });
});
