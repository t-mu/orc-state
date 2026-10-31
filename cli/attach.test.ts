import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync as realSpawnSync } from 'node:child_process';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;
const savedTty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };

function setTty(stdin: boolean, stdout = stdin) {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true, writable: true });
}

function writeAgents(agents: unknown[]) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
}

const tmuxAgent = {
  agent_id: 'bob', provider: 'claude', status: 'running', session_handle: 'tmux:bob',
  provider_ref: { tmux_socket: 'orc-sock', tmux_session: 'orc-bob-1234' }, registered_at: '2026-01-01T00:00:00Z',
};

class ExitError extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

/** Import cli/attach.ts with spawnSync and claims mocked; returns the exit code and stderr. */
async function runAttach(args: string[], { claims = [] as unknown[], status = 0 } = {}) {
  const spawnSync = vi.fn(() => ({ status, error: undefined }));
  vi.doMock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), spawnSync }));
  vi.doMock('../lib/stateReader.ts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    readClaims: () => ({ version: '1', claims }),
  }));
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { stderr.push(parts.join(' ')); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new ExitError(code ?? 0); }) as never);

  const oldArgv = process.argv;
  const oldStateDir = process.env.ORC_STATE_DIR;
  const oldProjectId = process.env.ORC_PROJECT_ID;
  process.argv = ['node', 'cli/attach.ts', ...args];
  process.env.ORC_STATE_DIR = dir;
  process.env.ORC_PROJECT_ID = '';
  let code: number | null = null;
  try {
    await import('./attach.ts');
  } catch (error) {
    if (!(error instanceof ExitError)) throw error;
    code = error.code;
  } finally {
    process.argv = oldArgv;
    if (oldStateDir == null) delete process.env.ORC_STATE_DIR; else process.env.ORC_STATE_DIR = oldStateDir;
    if (oldProjectId == null) delete process.env.ORC_PROJECT_ID; else process.env.ORC_PROJECT_ID = oldProjectId;
  }
  return { code, stderr: stderr.join('\n'), spawnSync };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('orch-attach-cli-test-');
  writeAgents([]);
  setTty(true);
});

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.doUnmock('../lib/stateReader.ts');
  Object.defineProperty(process.stdin, 'isTTY', { value: savedTty.stdin, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: savedTty.stdout, configurable: true, writable: true });
  cleanupTempStateDir(dir);
});

describe('cli/attach.ts', () => {
  it('fails when neither an agent nor a run matches', () => {
    const result = realSpawnSync('node', ['cli/attach.ts', 'missing'], {
      cwd: repoRoot,
      env: { ...process.env, ORC_STATE_DIR: dir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No agent or run found: missing');
  });

  it('fails when the agent has no session handle', async () => {
    writeAgents([{ agent_id: 'bob', provider: 'claude', status: 'offline', session_handle: null, registered_at: '2026-01-01T00:00:00Z' }]);
    const { code, stderr, spawnSync } = await runAttach(['bob']);
    expect(code).toBe(1);
    expect(stderr).toContain('has no active session');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('attaches read-only by default with the recorded socket and session', async () => {
    writeAgents([tmuxAgent]);
    const { code, stderr, spawnSync } = await runAttach(['bob'], {
      claims: [{ run_id: 'run-1', agent_id: 'bob', state: 'in_progress' }],
    });
    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith('tmux', ['-L', 'orc-sock', 'attach-session', '-r', '-t', '=orc-bob-1234'],
      expect.objectContaining({ stdio: 'inherit' }));
    expect(stderr).toContain('Attaching to bob (run-1) read-only — Ctrl-b d to detach');
    expect(stderr).not.toContain('Log file:');
  });

  it('attaches with input enabled under --write', async () => {
    writeAgents([tmuxAgent]);
    const { code, stderr, spawnSync } = await runAttach(['bob', '--write']);
    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledWith('tmux', ['-L', 'orc-sock', 'attach-session', '-t', '=orc-bob-1234'], expect.anything());
    expect(stderr).toContain('with write access');
  });

  it('resolves a run id to the claim agent', async () => {
    writeAgents([tmuxAgent]);
    const { code, stderr, spawnSync } = await runAttach(['run-7'], {
      claims: [{ run_id: 'run-7', agent_id: 'bob', state: 'claimed' }],
    });
    expect(code).toBe(0);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(stderr).toContain('Attaching to bob (run-7) read-only');
  });

  it.each(['done', 'failed'])('refuses a %s run instead of attaching to a reused agent name', async (state) => {
    writeAgents([tmuxAgent]);
    const { code, stderr, spawnSync } = await runAttach(['run-old'], {
      claims: [{ run_id: 'run-old', agent_id: 'bob', state }],
    });
    expect(code).toBe(1);
    expect(stderr).toContain(`Run run-old is not active (state: ${state})`);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('strips TMUX from the child environment so attaching works inside tmux', async () => {
    writeAgents([tmuxAgent]);
    const oldTmux = process.env.TMUX;
    process.env.TMUX = '/tmp/tmux-1000/default,1,0';
    try {
      const { spawnSync } = await runAttach(['bob']);
      const options = (spawnSync.mock.calls[0] as unknown[])[2] as { env: NodeJS.ProcessEnv };
      expect(options.env.TMUX).toBeUndefined();
      expect(options.env.PATH).toBe(process.env.PATH);
    } finally {
      if (oldTmux == null) delete process.env.TMUX; else process.env.TMUX = oldTmux;
    }
  });

  it('exits with the tmux status', async () => {
    writeAgents([tmuxAgent]);
    const { code } = await runAttach(['bob'], { status: 1 });
    expect(code).toBe(1);
  });

  it('refuses without a TTY and suggests a snapshot', async () => {
    writeAgents([tmuxAgent]);
    setTty(true, false);
    const { code, stderr, spawnSync } = await runAttach(['bob'], {
      claims: [{ run_id: 'run-1', agent_id: 'bob', state: 'in_progress' }],
    });
    expect(code).toBe(1);
    expect(stderr).toContain('needs an interactive terminal');
    expect(stderr).toContain('orc terminal provider run-1 --once');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each(['pty:bob', 'app:thread-1'])('points a %s session at orc terminal', async (handle) => {
    writeAgents([{ ...tmuxAgent, session_handle: handle }]);
    const { code, stderr, spawnSync } = await runAttach(['bob'], {
      claims: [{ run_id: 'run-1', agent_id: 'bob', state: 'in_progress' }],
    });
    expect(code).toBe(1);
    expect(stderr).toContain('has no tmux terminal');
    expect(stderr).toContain('orc terminal provider run-1 [--write]');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
