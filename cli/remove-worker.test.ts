import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('orch-remove-worker-cli-test-');
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

describe('cli/remove-worker.ts', () => {
  it('removes worker without session handle', async () => {
    writeAgents([{ agent_id: 'bob', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' }]);

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
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
    const oldStateDir = process.env.ORC_STATE_DIR;
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
    const oldStateDir = process.env.ORC_STATE_DIR;
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

  it('refuses a worker that holds an active claim', async () => {
    writeAgents([{ agent_id: 'bob', provider: 'claude', status: 'running', session_handle: 'claude:session:bob', registered_at: '2026-01-01T00:00:00Z' }]);
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [
      { run_id: 'run-1', task_ref: 'proj/task-1', agent_id: 'bob', state: 'in_progress', claimed_at: '2026-01-01T00:00:00Z', lease_expires_at: '2099-01-01T00:00:00Z' },
    ] }));
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => ({ stop }) }));
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`__exit__${code}`); }) as never);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/remove-worker.ts', 'bob'];
    setStateDirEnv(dir);
    try {
      await expect(import('./remove-worker.ts')).rejects.toThrow('__exit__1');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(stderr.mock.calls.flat().join(' ')).toContain('Cannot remove bob: active claim exists (run_id=run-1');
    expect(stop).not.toHaveBeenCalled();
    expect(readAgents().map((a: Record<string, unknown>) => a.agent_id)).toEqual(['bob']);
    exit.mockRestore();
  });

});
