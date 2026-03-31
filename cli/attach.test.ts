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
  dir = createTempStateDir('orch-attach-cli-test-');
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/attach.ts', () => {
  it('fails when agent is missing', () => {
    const result = spawnSync('node', ['--experimental-strip-types', 'cli/attach.ts', 'missing'], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Agent not found: missing');
  });

  it('fails when agent has no session handle', () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'bob', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' }],
    }));

    const result = spawnSync('node', ['--experimental-strip-types', 'cli/attach.ts', 'bob'], {
      cwd: repoRoot,
      env: { ...process.env, ORCH_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('has no active session');
    expect(result.stderr).toContain('orc-worker-start-session bob');
  });

  it('calls adapter.attach for agent with active session', async () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'bob', provider: 'claude', status: 'running', session_handle: 'claude:session:bob', registered_at: '2026-01-01T00:00:00Z' }],
    }));

    const attach = vi.fn();
    const heartbeatProbe = vi.fn().mockResolvedValue(true);
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ attach, heartbeatProbe }),
    }));

    const oldArgv = process.argv;
    const oldStateDir = process.env.ORCH_STATE_DIR;
    process.argv = ['node', 'cli/attach.ts', 'bob'];
    process.env.ORCH_STATE_DIR = dir;

    try {
      await import('./attach.ts');
    } finally {
      process.argv = oldArgv;
      process.env.ORCH_STATE_DIR = oldStateDir;
    }

    expect(attach).toHaveBeenCalledWith('claude:session:bob');
    expect(heartbeatProbe).toHaveBeenCalledWith('claude:session:bob');
  });
});
