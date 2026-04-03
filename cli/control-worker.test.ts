import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('orch-control-worker-cli-test-');
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/control-worker.ts', () => {
  it('fails when worker is missing', () => {
    const result = spawnSync('node', ['cli/control-worker.ts', 'missing'], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Worker not found: missing');
    expect(result.stderr).toContain('orc status');
  });

  it('fails when target is a master agent', () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'master', provider: 'claude', role: 'master', status: 'running', session_handle: 'pty:master', registered_at: '2026-01-01T00:00:00Z' }],
    }));

    const result = spawnSync('node', ['cli/control-worker.ts', 'master'], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot be controlled as a worker');
  });

  it('attaches for worker with live session', async () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'bob', provider: 'claude', role: 'worker', status: 'running', session_handle: 'pty:bob', registered_at: '2026-01-01T00:00:00Z' }],
    }));

    const attach = vi.fn();
    const heartbeatProbe = vi.fn().mockResolvedValue(true);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ attach, heartbeatProbe }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/control-worker.ts', 'bob'];
    process.env.ORCH_STATE_DIR = dir;

    try {
      await import('./control-worker.ts');
    } finally {
      process.argv = oldArgv;
      process.env.ORCH_STATE_DIR = oldStateDir;
    }

    expect(heartbeatProbe).toHaveBeenCalledWith('pty:bob');
    expect(attach).toHaveBeenCalledWith('pty:bob');
  });

  it('supports interactive selection when worker id is omitted', async () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [
        { agent_id: 'alice', provider: 'codex', role: 'worker', status: 'running', session_handle: 'pty:alice', registered_at: '2026-01-01T00:00:00Z' },
        { agent_id: 'master', provider: 'claude', role: 'master', status: 'running', session_handle: null, registered_at: '2026-01-01T00:00:00Z' },
      ],
    }));

    const attach = vi.fn();
    const heartbeatProbe = vi.fn().mockResolvedValue(true);
    const select = vi.fn().mockResolvedValue('alice');
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ attach, heartbeatProbe }),
    }));
    vi.doMock('@inquirer/prompts', () => ({ select }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    const stdinTTY = process.stdin.isTTY;
    const stdoutTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.argv = ['node', 'cli/control-worker.ts'];
    process.env.ORCH_STATE_DIR = dir;

    try {
      await import('./control-worker.ts');
    } finally {
      process.argv = oldArgv;
      process.env.ORCH_STATE_DIR = oldStateDir;
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTTY, writable: true, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTTY, writable: true, configurable: true });
    }

    expect(select).toHaveBeenCalledOnce();
    expect(heartbeatProbe).toHaveBeenCalledWith('pty:alice');
    expect(attach).toHaveBeenCalledWith('pty:alice');
  });
});
