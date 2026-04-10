import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('orch-start-worker-session-cli-test-');
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function setStateDirEnv(value: string | null | undefined) {
  if (value == null) delete process.env.ORC_STATE_DIR;
  else process.env.ORC_STATE_DIR = value;
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

describe('cli/start-worker-session.ts', () => {
  it('fails when no agent id is provided and stdin is not a TTY', () => {
    // spawnSync has no TTY → promptAgentId returns null → exit 1 with usage message
    const result = spawnSync('node', ['cli/start-worker-session.ts'], {
      cwd: repoRoot,
      env: { ...process.env, ORC_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: orc start-worker-session');
  });

  it('fails when missing provider for unregistered worker', () => {
    const result = spawnSync('node', ['cli/start-worker-session.ts', 'worker-01'], {
      cwd: repoRoot,
      env: { ...process.env, ORC_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Worker not found and no provider given');
  });

  it('rejects role=master and directs the operator to orc start-session', async () => {
    const heartbeatProbe = vi.fn().mockResolvedValue(false);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ heartbeatProbe, stop: vi.fn() }),
    }));
    vi.doMock('../lib/binaryCheck.ts', () => ({
      checkAndInstallBinary: vi.fn().mockResolvedValue(true),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = [
      'node',
      'cli/start-worker-session.ts',
      'worker-01',
      '--provider=claude',
      '--role=master',
    ];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__exit__');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setStateDirEnv(dir);
    try {
      await expect(import('./start-worker-session.ts')).rejects.toThrow('__exit__');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("cannot use role=master"));
    expect(readAgents()).toHaveLength(0);
  });

  it('rejects agent id master and directs the operator to orc start-session', () => {
    const result = spawnSync('node', ['cli/start-worker-session.ts', 'master', '--provider=claude'], {
      cwd: repoRoot,
      env: { ...process.env, ORC_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot use agent id 'master'");
    expect(result.stderr).toContain('orc start-session');
  });

  it('does not rebind live session unless --force-rebind', async () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{
        agent_id: 'bob',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'claude:session:bob',
        provider_ref: { session_id: 'old' },
        registered_at: '2026-01-01T00:00:00Z',
      }],
    }));
    const heartbeatProbe = vi.fn().mockResolvedValue(true);
    const stop = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn().mockResolvedValue({ session_handle: 'new', provider_ref: {} });
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ heartbeatProbe, stop, start }),
    }));
    vi.doMock('../lib/binaryCheck.ts', () => ({
      checkAndInstallBinary: vi.fn().mockResolvedValue(true),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/start-worker-session.ts', 'bob'];
    setStateDirEnv(dir);
    try {
      await import('./start-worker-session.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(heartbeatProbe).toHaveBeenCalledWith('claude:session:bob');
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(readAgents().find((a: Record<string, unknown>) => a.agent_id === 'bob').session_handle).toBe('claude:session:bob');
  });

  it('prints debug-oriented guidance when provisioning a session', async () => {
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ heartbeatProbe: vi.fn().mockResolvedValue(false), stop: vi.fn() }),
    }));
    vi.doMock('../lib/binaryCheck.ts', () => ({
      checkAndInstallBinary: vi.fn().mockResolvedValue(true),
    }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/start-worker-session.ts', 'worker-01', '--provider=claude'];
    setStateDirEnv(dir);
    try {
      await import('./start-worker-session.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('debug worker session control');
    expect(output).toContain('debug/recovery workflows');
    expect(output).toContain('launches workers per task automatically');
  });

  it('force-rebind stops old session — coordinator will create new PTY session', async () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{
        agent_id: 'bob',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:bob',
        provider_ref: { pid: 1234, provider: 'claude', binary: 'claude' },
        registered_at: '2026-01-01T00:00:00Z',
      }],
    }));
    const heartbeatProbe = vi.fn().mockResolvedValue(true);
    const stop = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn();
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ heartbeatProbe, stop, start }),
    }));
    vi.doMock('../lib/binaryCheck.ts', () => ({
      checkAndInstallBinary: vi.fn().mockResolvedValue(true),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORC_STATE_DIR;
    process.argv = ['node', 'cli/start-worker-session.ts', 'bob', '--force-rebind'];
    setStateDirEnv(dir);
    try {
      await import('./start-worker-session.ts');
    } finally {
      process.argv = oldArgv;
      setStateDirEnv(oldStateDir);
    }

    expect(stop).toHaveBeenCalledWith('pty:bob');
    // No adapter.start() — coordinator creates the new PTY on its first tick
    expect(start).not.toHaveBeenCalled();
    expect(readAgents().find((a: Record<string, unknown>) => a.agent_id === 'bob').session_handle).toBeNull();
  });

  describe('binary check', () => {
    it('exits 1 when binary unavailable', async () => {
      vi.doMock('../adapters/index.ts', () => ({
        createAdapter: () => ({ heartbeatProbe: vi.fn().mockResolvedValue(false), stop: vi.fn() }),
      }));
      vi.doMock('../lib/binaryCheck.ts', () => ({
        checkAndInstallBinary: vi.fn().mockResolvedValue(false),
      }));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as () => never);

      const oldArgv = process.argv;
      const oldStateDir = process.env.ORC_STATE_DIR;
      process.argv = ['node', 'cli/start-worker-session.ts', 'alice', '--provider=claude'];
      setStateDirEnv(dir);
      try {
        await import('./start-worker-session.ts');
      } finally {
        process.argv = oldArgv;
        setStateDirEnv(oldStateDir);
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('checks binary before registering a missing worker', async () => {
      const checkAndInstallBinary = vi.fn().mockResolvedValue(true);
      vi.doMock('../adapters/index.ts', () => ({
        createAdapter: () => ({ heartbeatProbe: vi.fn().mockResolvedValue(false), stop: vi.fn() }),
      }));
      vi.doMock('../lib/binaryCheck.ts', () => ({
        checkAndInstallBinary,
      }));

      const oldArgv = process.argv;
      const oldStateDir = process.env.ORC_STATE_DIR;
      process.argv = ['node', 'cli/start-worker-session.ts', 'alice', '--provider=claude'];
      setStateDirEnv(dir);
      try {
        await import('./start-worker-session.ts');
      } finally {
        process.argv = oldArgv;
        setStateDirEnv(oldStateDir);
      }

      expect(checkAndInstallBinary).toHaveBeenCalledWith('claude');
      expect(readAgents().find((a: Record<string, unknown>) => a.agent_id === 'alice')).toBeTruthy();
    });
  });
});
