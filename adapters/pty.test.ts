import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'pty-test-'));
  process.env.ORCH_STATE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
});

function makeMockPty(pid = 12345) {
  let dataCallback: ((s: string) => void) | null = null;
  const ptyProcess = {
    pid,
    write:  vi.fn(),
    kill:   vi.fn(),
    onData: vi.fn().mockImplementation((cb: (s: string) => void) => { dataCallback = cb; }),
  };
  return { ptyProcess, triggerData: (s: string) => dataCallback?.(s) };
}

async function makeAdapter({ provider = 'claude', spawnReturn, spawnThrow }: { provider?: string; spawnReturn?: ReturnType<typeof makeMockPty>; spawnThrow?: Error } = {}) {
  const { ptyProcess, triggerData } = spawnReturn ?? makeMockPty();
  const spawnSpy = spawnThrow
    ? vi.fn().mockImplementation(() => { throw spawnThrow; })
    : vi.fn().mockReturnValue(ptyProcess);
  vi.doMock('node-pty', () => ({ default: { spawn: spawnSpy } }));
  const { createPtyAdapter } = await import('./pty.ts');
  return {
    adapter: createPtyAdapter({ provider }),
    spawnSpy,
    ptyProcess,
    triggerData,
  };
}

// ─── start() ───────────────────────────────────────────────────────────────

describe('pty adapter start()', () => {
  it('spawns the CLI binary and returns pty session handle and provider_ref', async () => {
    const { adapter, spawnSpy, ptyProcess } = await makeAdapter({ provider: 'claude' });
    const result = await adapter.start('bob', {});

    expect(result).toMatchObject({
      session_handle: 'pty:bob',
      provider_ref: { pid: ptyProcess.pid, provider: 'claude', binary: 'claude' },
    });
    expect(spawnSpy).toHaveBeenCalledWith('claude', [], expect.objectContaining({
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
    }));
  });

  it('launches the provider inside the requested working directory when provided', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { working_directory: '/tmp/orc-worktree' });

    expect(spawnSpy).toHaveBeenCalledWith('claude', [], expect.objectContaining({
      cwd: '/tmp/orc-worktree',
    }));
  });

  it('merges explicit environment overrides into the spawned provider process', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {
      env: {
        ORCH_STATE_DIR: '/tmp/shared-state',
        ORC_REPO_ROOT: '/tmp/repo-root',
      },
    });

    expect(spawnSpy).toHaveBeenCalledWith('claude', [], expect.objectContaining({
      env: expect.objectContaining({
        ORCH_STATE_DIR: '/tmp/shared-state',
        ORC_REPO_ROOT: '/tmp/repo-root',
      }),
    }));
  });

  it('writes PID file to STATE_DIR/pty-pids/{agentId}.pid', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    const pidPath = join(dir, 'pty-pids', 'bob.pid');
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, 'utf8')).toBe(String(ptyProcess.pid));
  });

  it('delivers bootstrap via ptyProcess.write() when system_prompt provided', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', { system_prompt: 'BOOTSTRAP TEXT' });

    // Two separate writes: text first, then CR to submit paste.
    expect(ptyProcess.write).toHaveBeenNthCalledWith(1, 'BOOTSTRAP TEXT');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(2, '\r');
  });

  it('does not call write() when system_prompt is absent', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    expect(ptyProcess.write).not.toHaveBeenCalled();
  });

  it('streams PTY output to STATE_DIR/pty-logs/{agentId}.log', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('hello from pty\n');

    // Give the write stream a moment to flush
    await new Promise((r) => setTimeout(r, 20));
    const log = readFileSync(join(dir, 'pty-logs', 'bob.log'), 'utf8');
    expect(log).toContain('hello from pty');
  });

  it('uses provider binary mapping for codex and gemini', async () => {
    const codex = await makeAdapter({ provider: 'codex' });
    await codex.adapter.start('c', {});
    expect(codex.spawnSpy).toHaveBeenCalledWith('codex', ['--no-alt-screen', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'], expect.any(Object));

    vi.resetModules();
    const gemini = await makeAdapter({ provider: 'gemini' });
    await gemini.adapter.start('g', {});
    expect(gemini.spawnSpy).toHaveBeenCalledWith('gemini', [], expect.any(Object));
  });

  it('passes codex bootstrap as startup prompt arg instead of PTY write', async () => {
    const { adapter, spawnSpy, ptyProcess } = await makeAdapter({ provider: 'codex' });
    await adapter.start('codex-worker', { system_prompt: 'BOOTSTRAP TEXT' });

    expect(spawnSpy).toHaveBeenCalledWith(
      'codex',
      ['--no-alt-screen', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', 'BOOTSTRAP TEXT'],
      expect.any(Object),
    );
    expect(ptyProcess.write).not.toHaveBeenCalled();
  });

  it('cleans up and does not write pid file when pty.spawn throws', async () => {
    const { adapter } = await makeAdapter({ spawnThrow: new Error('spawn failed') });
    await expect(adapter.start('bob', {})).rejects.toThrow('spawn failed');

    const pidPath = join(dir, 'pty-pids', 'bob.pid');
    expect(existsSync(pidPath)).toBe(false);
  });
});

// ─── send() ────────────────────────────────────────────────────────────────

describe('pty adapter send()', () => {
  // All providers use the same two-phase write: text first, then CR to submit.
  // CR (0x0D) is the universal submit key in PTY raw mode (claude, codex, gemini).
  for (const provider of ['claude', 'codex', 'gemini']) {
    it(`writes text then CR as separate writes for provider=${provider}`, async () => {
      const { adapter, ptyProcess } = await makeAdapter({ provider });
      await adapter.start('bob', {});

      const result = await adapter.send('pty:bob', 'CHECK_WORK');

      expect(result).toBe('');
      expect(ptyProcess.write).toHaveBeenNthCalledWith(1, 'CHECK_WORK');
      expect(ptyProcess.write).toHaveBeenNthCalledWith(2, '\r');
    });
  }

  it('throws when agent is not in sessions Map', async () => {
    const { adapter } = await makeAdapter();
    // Do NOT call start() — agent not in Map.
    await expect(adapter.send('pty:bob', 'text')).rejects.toThrow(/No active pty session/);
  });

  it('reports local PTY ownership separately from heartbeat probing', async () => {
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {});
    expect(adapter.ownsSession('pty:bob')).toBe(true);

    vi.resetModules();
    const fresh = await makeAdapter();
    expect(fresh.adapter.ownsSession('pty:bob')).toBe(false);
  });

  it('detects a blocking confirmation prompt from recent PTY output', async () => {
    const { adapter, triggerData } = await makeAdapter({ provider: 'codex' });
    await adapter.start('bob', {});
    triggerData('Would you like to apply these changes? [y/n]\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(adapter.detectInputBlock('pty:bob')).toBe('Would you like to apply these changes? [y/n]');
  });
  it('throws on malformed session handles', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.send('bad-handle', 'text')).rejects.toThrow(/Invalid pty session handle/);
  });
});

// ─── attach() ──────────────────────────────────────────────────────────────

describe('pty adapter attach()', () => {
  it('prints tail of output log to stdout', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('agent output line\n');
    await new Promise((r) => setTimeout(r, 20));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    adapter.attach('pty:bob');

    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('agent output line');
  });

  it('prints fallback message when no log file exists — does not throw', async () => {
    const { adapter } = await makeAdapter();
    // Do NOT call start() — no log file created.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => adapter.attach('pty:nobody')).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no output log'));
  });
});

// ─── heartbeatProbe() ──────────────────────────────────────────────────────

describe('pty adapter heartbeatProbe()', () => {
  it('returns true when process is alive (in-Map path)', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    // Stub process.kill to not throw (simulates alive process)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await expect(adapter.heartbeatProbe('pty:bob')).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(ptyProcess.pid, 0);
  });

  it('returns false when in-Map process is dead', async () => {
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {});

    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    await expect(adapter.heartbeatProbe('pty:bob')).resolves.toBe(false);
  });

  it('returns true via PID file fallback when agent not in Map (cross-process)', async () => {
    // Write PID file manually — simulate coordinator having created session
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {}); // writes PID file

    // Create fresh adapter (empty sessions Map)
    vi.resetModules();
    const fresh = await makeAdapter();

    vi.spyOn(process, 'kill').mockImplementation(() => true);
    await expect(fresh.adapter.heartbeatProbe('pty:bob')).resolves.toBe(true);
  });

  it('returns false when PID file absent and not in Map', async () => {
    const { adapter } = await makeAdapter();
    // No start() call — no PID file
    await expect(adapter.heartbeatProbe('pty:nobody')).resolves.toBe(false);
  });

  it('never throws — returns false on malformed handle', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.heartbeatProbe('invalid')).resolves.toBe(false);
  });

  it('returns false when PID file contains non-numeric content', async () => {
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {});
    writeFileSync(join(dir, 'pty-pids', 'bob.pid'), 'not-a-number');

    vi.resetModules();
    const fresh = await makeAdapter();
    await expect(fresh.adapter.heartbeatProbe('pty:bob')).resolves.toBe(false);
  });
});

// ─── stop() ────────────────────────────────────────────────────────────────

describe('pty adapter stop()', () => {
  it('kills the PTY process and removes PID file', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    const pidPath = join(dir, 'pty-pids', 'bob.pid');
    expect(existsSync(pidPath)).toBe(true);

    await adapter.stop('pty:bob');

    expect(ptyProcess.kill).toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(false);
  });

  it('is a no-op when agent not found — does not throw', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.stop('pty:nobody')).resolves.toBeUndefined();
  });

  it('is safe to call twice (double-stop)', async () => {
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {});
    await adapter.stop('pty:bob');
    await expect(adapter.stop('pty:bob')).resolves.toBeUndefined();
  });

  it('removes pid file even when PTY kill throws', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});
    ptyProcess.kill.mockImplementation(() => { throw new Error('already gone'); });

    const pidPath = join(dir, 'pty-pids', 'bob.pid');
    expect(existsSync(pidPath)).toBe(true);

    await expect(adapter.stop('pty:bob')).resolves.toBeUndefined();
    expect(existsSync(pidPath)).toBe(false);
  });

  it('kills a live pid-file session even when the PTY is not owned in memory', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});
    const pid = ptyProcess.pid;
    const pidPath = join(dir, 'pty-pids', 'bob.pid');

    vi.resetModules();
    const fresh = await makeAdapter();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    await expect(fresh.adapter.stop('pty:bob')).resolves.toBeUndefined();

    expect(killSpy).toHaveBeenCalledWith(pid, 'SIGTERM');
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe('pty adapter start() replacement', () => {
  it('kills existing in-memory session when starting same agent again', async () => {
    const first = makeMockPty(11111).ptyProcess;
    const second = makeMockPty(22222).ptyProcess;
    const spawnSpy = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    vi.doMock('node-pty', () => ({ default: { spawn: spawnSpy } }));

    const { createPtyAdapter } = await import('./pty.ts');
    const adapter = createPtyAdapter({ provider: 'claude' });
    await adapter.start('bob', {});
    await adapter.start('bob', {});

    expect(first.kill).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Factory and contract ───────────────────────────────────────────────────

describe('adapter factory and contract', () => {
  it('createAdapter returns valid adapters for known providers', async () => {
    vi.doMock('node-pty', () => ({ default: { spawn: vi.fn().mockReturnValue(makeMockPty().ptyProcess) } }));
    const { createAdapter, assertAdapterContract } = await import('./index.ts');

    expect(() => assertAdapterContract(createAdapter('claude'))).not.toThrow();
    expect(() => assertAdapterContract(createAdapter('codex'))).not.toThrow();
    expect(() => assertAdapterContract(createAdapter('gemini'))).not.toThrow();
  });

  it('createAdapter throws for unknown providers', async () => {
    vi.doMock('node-pty', () => ({ default: { spawn: vi.fn() } }));
    const { createAdapter } = await import('./index.ts');
    expect(() => createAdapter('unknown')).toThrow(/Unknown provider/);
  });

  it('assertAdapterContract accepts a pty adapter instance', async () => {
    vi.doMock('node-pty', () => ({ default: { spawn: vi.fn().mockReturnValue(makeMockPty().ptyProcess) } }));
    const { createPtyAdapter } = await import('./pty.ts');
    const { assertAdapterContract } = await import('./interface.ts');
    const adapter = createPtyAdapter({ provider: 'claude' });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });
});
