import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = createTempStateDir('pty-test-');
  process.env.ORC_STATE_DIR = dir;
});

afterEach(() => {
  cleanupTempStateDir(dir);
  delete process.env.ORC_STATE_DIR;
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

function binaryMatcher(name: string) {
  return expect.stringMatching(new RegExp(`(^|/)${name}$`));
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
    const result = await adapter.start('bob', { execution_mode: 'full-access' });

    expect(result).toMatchObject({
      session_handle: 'pty:bob',
      provider_ref: { pid: ptyProcess.pid, provider: 'claude', binary: 'claude' },
    });
    expect(spawnSpy).toHaveBeenCalledWith(binaryMatcher('claude'), expect.arrayContaining(['--dangerously-skip-permissions', '--settings']), expect.objectContaining({
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
    }));
    // --settings path should point to the per-agent settings file
    const spawnArgs = spawnSpy.mock.calls[0][1] as string[];
    expect(spawnArgs[0]).toBe('--dangerously-skip-permissions');
    expect(spawnArgs[1]).toBe('--settings');
    expect(spawnArgs[2]).toMatch(/pty-settings[/\\]bob\.json$/);
  });

  it('writes a settings file with Notification hook for claude provider', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    const settingsFile = join(dir, 'pty-settings', 'bob.json');
    expect(existsSync(settingsFile)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(settings).toMatchObject({
      hooks: { Notification: [{ hooks: [{ type: 'command', command: expect.stringContaining('permission_prompt') }] }] },
    });
  });

  it('launches the provider inside the requested working directory when provided', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { working_directory: '/tmp/orc-worktree', execution_mode: 'full-access' });

    expect(spawnSpy).toHaveBeenCalledWith(binaryMatcher('claude'), expect.arrayContaining(['--dangerously-skip-permissions']), expect.objectContaining({
      cwd: '/tmp/orc-worktree',
    }));
  });

  it('merges explicit environment overrides into the spawned provider process', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {
      execution_mode: 'full-access',
      env: {
        ORC_STATE_DIR: '/tmp/shared-state',
        ORC_REPO_ROOT: '/tmp/repo-root',
      },
    });

    expect(spawnSpy).toHaveBeenCalledWith(binaryMatcher('claude'), expect.arrayContaining(['--dangerously-skip-permissions']), expect.objectContaining({
      env: expect.objectContaining({
        ORC_STATE_DIR: '/tmp/shared-state',
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
    await adapter.start('bob', { execution_mode: 'full-access', system_prompt: 'BOOTSTRAP TEXT' });

    // Claude: Enter (trust/bypass dismiss) + '2' + Enter (bypass accept),
    // then bootstrap text + CR.
    expect(ptyProcess.write).toHaveBeenNthCalledWith(1, '\r');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(2, '2');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(3, '\r');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(4, 'BOOTSTRAP TEXT');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(5, '\r');
  });

  it('auto-accepts startup dialogs even when system_prompt is absent', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', { execution_mode: 'full-access' });

    // Claude writes CR (trust dismiss) + '2' + CR (bypass accept).
    expect(ptyProcess.write).toHaveBeenCalledTimes(3);
    expect(ptyProcess.write).toHaveBeenNthCalledWith(1, '\r');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(2, '2');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(3, '\r');
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
    await codex.adapter.start('c', { execution_mode: 'full-access' });
    expect(codex.spawnSpy).toHaveBeenCalledWith(binaryMatcher('codex'), ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent'], expect.any(Object));

    vi.resetModules();
    const gemini = await makeAdapter({ provider: 'gemini' });
    await gemini.adapter.start('g', { execution_mode: 'full-access' });
    expect(gemini.spawnSpy).toHaveBeenCalledWith(binaryMatcher('gemini'), [], expect.any(Object));
  });

  it('passes codex bootstrap as startup prompt arg instead of PTY write', async () => {
    const { adapter, spawnSpy, ptyProcess } = await makeAdapter({ provider: 'codex' });
    await adapter.start('codex-worker', { execution_mode: 'full-access', system_prompt: 'BOOTSTRAP TEXT' });

    expect(spawnSpy).toHaveBeenCalledWith(
      binaryMatcher('codex'),
      ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent', 'BOOTSTRAP TEXT'],
      expect.any(Object),
    );
    // Codex gets one Enter press to dismiss the workspace confirmation dialog.
    expect(ptyProcess.write).toHaveBeenCalledTimes(1);
    expect(ptyProcess.write).toHaveBeenNthCalledWith(1, '\r');
  });

  it('uses bypass mode for codex scout sessions too', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('scout-1', { system_prompt: 'SCOUT', read_only: true });

    expect(spawnSpy).toHaveBeenCalledWith(
      binaryMatcher('codex'),
      ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'multi_agent', 'SCOUT'],
      expect.any(Object),
    );
  });

  it('cleans up and does not write pid file when pty.spawn throws', async () => {
    const { adapter } = await makeAdapter({ spawnThrow: new Error('spawn failed') });
    await expect(adapter.start('bob', {})).rejects.toThrow('spawn failed');

    const pidPath = join(dir, 'pty-pids', 'bob.pid');
    expect(existsSync(pidPath)).toBe(false);
  });
});

// ─── buildStartArgs execution mode ─────────────────────────────────────────

describe('buildStartArgs execution mode', () => {
  it('claude full-access: --dangerously-skip-permissions', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'full-access' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
  });

  it('claude sandbox: --permission-mode auto', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--permission-mode');
    expect(args).toContain('auto');
  });

  it('claude sandbox: no --dangerously-skip-permissions', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('claude sandbox: settings file includes sandbox config block', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    const settingsFile = join(dir, 'pty-settings', 'bob.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(settings).toMatchObject({
      sandbox: {
        enabled: true,
        mode: 'auto-allow',
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: ['.'] },
      },
    });
  });

  it('claude sandbox + read_only: settings file has no allowWrite', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox', read_only: true });

    const settingsFile = join(dir, 'pty-settings', 'bob.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(settings.sandbox).toBeDefined();
    expect(settings.sandbox.filesystem).toBeUndefined();
  });

  it('codex full-access: --dangerously-bypass-approvals-and-sandbox', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', { execution_mode: 'full-access' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('codex sandbox: --sandbox workspace-write --ask-for-approval never', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', { execution_mode: 'sandbox' });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('never');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('codex sandbox + read_only: --sandbox read-only --ask-for-approval never', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', { execution_mode: 'sandbox', read_only: true });

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
    expect(args).toContain('--ask-for-approval');
    expect(args).toContain('never');
  });

  it('gemini: no flags in either mode', async () => {
    const gemini1 = await makeAdapter({ provider: 'gemini' });
    await gemini1.adapter.start('g', { execution_mode: 'full-access' });
    expect(gemini1.spawnSpy).toHaveBeenCalledWith(binaryMatcher('gemini'), [], expect.any(Object));

    vi.resetModules();
    const gemini2 = await makeAdapter({ provider: 'gemini' });
    await gemini2.adapter.start('g', { execution_mode: 'sandbox' });
    expect(gemini2.spawnSpy).toHaveBeenCalledWith(binaryMatcher('gemini'), [], expect.any(Object));
  });

  it('undefined execution_mode defaults to full-access behavior (claude)', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('undefined execution_mode defaults to full-access behavior (codex)', async () => {
    const { adapter, spawnSpy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('c', {});

    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});

// ─── claude auto-accept dance ───────────────────────────────────────────────

describe('claude auto-accept dance', () => {
  it('fires in full-access mode', async () => {
    const { adapter, ptyProcess } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'full-access' });

    expect(ptyProcess.write).toHaveBeenCalledWith('2');
    expect(ptyProcess.write).toHaveBeenCalledWith('\r');
  });

  it('does not fire in sandbox mode', async () => {
    const { adapter, ptyProcess } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', { execution_mode: 'sandbox' });

    expect(ptyProcess.write).not.toHaveBeenCalledWith('2');
  });

  it('fires when execution_mode is undefined (backward compat)', async () => {
    const { adapter, ptyProcess } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    expect(ptyProcess.write).toHaveBeenCalledWith('2');
    expect(ptyProcess.write).toHaveBeenCalledWith('\r');
  });
});

// ─── send() ────────────────────────────────────────────────────────────────

describe('pty adapter send()', () => {
  // All providers use the same two-phase write: text first, then CR to submit.
  // CR (0x0D) is the universal submit key in PTY raw mode (claude, codex, gemini).
  it('writes text then CR as separate writes for provider=codex (after workspace dialog)', async () => {
    const { adapter, ptyProcess } = await makeAdapter({ provider: 'codex' });
    await adapter.start('bob', {});

    // Codex start() pre-wrote CR (workspace dialog), so send() at positions 2+3.
    const result = await adapter.send('pty:bob', 'CHECK_WORK');

    expect(result).toBe('');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(2, 'CHECK_WORK');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(3, '\r');
  });

  it('writes text then CR as separate writes for provider=gemini', async () => {
    const { adapter, ptyProcess } = await makeAdapter({ provider: 'gemini' });
    await adapter.start('bob', {});

    const result = await adapter.send('pty:bob', 'CHECK_WORK');

    expect(result).toBe('');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(1, 'CHECK_WORK');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(2, '\r');
  });


  it('writes text then CR as separate writes for provider=claude (after startup dialogs)', async () => {
    const { adapter, ptyProcess } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    // start() pre-wrote CR + '2' + CR to dismiss startup dialogs,
    // so send() writes land at positions 4 and 5.
    const result = await adapter.send('pty:bob', 'CHECK_WORK');

    expect(result).toBe('');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(4, 'CHECK_WORK');
    expect(ptyProcess.write).toHaveBeenNthCalledWith(5, '\r');
  });

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

  it('detects quota and context exhaustion output as a blocking condition', async () => {
    const { adapter, triggerData } = await makeAdapter({ provider: 'codex' });
    await adapter.start('bob', {});
    triggerData('You are running out of session quota. Try again later.\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(adapter.detectInputBlock('pty:bob')).toBe('You are running out of session quota. Try again later.');
  });

  it('detects permission prompt patterns with [y/n] in PTY output', async () => {
    const { adapter, triggerData } = await makeAdapter({ provider: 'gemini' });
    await adapter.start('bob', {});
    triggerData('Allow this tool to execute? [y/n]\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(adapter.detectInputBlock('pty:bob')).toMatch(/allow this tool/i);
  });

  it('does NOT match "permission required" in non-interactive text', async () => {
    const { adapter, triggerData } = await makeAdapter({ provider: 'gemini' });
    await adapter.start('bob', {});
    triggerData('Note: permission required to access /etc/shadow\nDone.\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(adapter.detectInputBlock('pty:bob')).toBeNull();
  });

  it('does NOT match "do you want to allow" in echoed documentation', async () => {
    const { adapter, triggerData } = await makeAdapter({ provider: 'codex' });
    await adapter.start('bob', {});
    triggerData('The dialog asks: "Do you want to allow this extension to run?"\nInstallation complete.\n');
    await new Promise((r) => setTimeout(r, 20));

    expect(adapter.detectInputBlock('pty:bob')).toBeNull();
  });

  it('returns hook events file message as fast-path over PTY scan', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    // Write a fake hook event directly to the hook events file
    const hookFile = join(dir, 'pty-hook-events', 'bob.ndjson');
    writeFileSync(hookFile, JSON.stringify({ type: 'permission', message: 'Approve bash command?', ts: new Date().toISOString() }) + '\n');

    expect(adapter.detectInputBlock('pty:bob')).toBe('Approve bash command?');
    // After atomic consume, the file and .processing file should both be gone
    expect(existsSync(hookFile)).toBe(false);
    expect(existsSync(`${hookFile}.processing`)).toBe(false);
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

  it('removes hook events, .processing, and settings files on stop', async () => {
    const { adapter } = await makeAdapter({ provider: 'claude' });
    await adapter.start('bob', {});

    const hookFile = join(dir, 'pty-hook-events', 'bob.ndjson');
    const processingFile = `${hookFile}.processing`;
    const settingsFile = join(dir, 'pty-settings', 'bob.json');
    // settings file is written by start(); create hook events + .processing to simulate mid-consume
    writeFileSync(hookFile, JSON.stringify({ type: 'permission', message: 'test', ts: '' }) + '\n');
    writeFileSync(processingFile, JSON.stringify({ type: 'permission', message: 'stale', ts: '' }) + '\n');
    expect(existsSync(settingsFile)).toBe(true);

    await adapter.stop('pty:bob');

    expect(existsSync(hookFile)).toBe(false);
    expect(existsSync(processingFile)).toBe(false);
    expect(existsSync(settingsFile)).toBe(false);
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
  it('kills existing in-memory session when starting same agent again', { timeout: 12000 }, async () => {
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

// ─── sanitizePtyChunk (via log file) ────────────────────────────────────────

describe('PTY log sanitization', () => {
  it('strips CSI escape sequences from log output', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('\x1b[38;5;131m✢\x1b[39m hello\n');
    await new Promise((r) => setTimeout(r, 20));

    const log = readFileSync(join(dir, 'pty-logs', 'bob.log'), 'utf8');
    expect(log).toContain('✢ hello');
    expect(log).not.toContain('\x1b[');
  });

  it('strips OSC sequences (window title sets) from log output', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('\x1b]0;window title\x07actual content\n');
    await new Promise((r) => setTimeout(r, 20));

    const log = readFileSync(join(dir, 'pty-logs', 'bob.log'), 'utf8');
    expect(log).toContain('actual content');
    expect(log).not.toContain('window title');
    expect(log).not.toContain('\x1b]');
  });

  it('collapses carriage-return spinner overwrites — keeps last frame only', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('⠋ working\r⠙ working\r⠹ working\rdone\n');
    await new Promise((r) => setTimeout(r, 20));

    const log = readFileSync(join(dir, 'pty-logs', 'bob.log'), 'utf8');
    expect(log).toContain('done');
    expect(log).not.toContain('⠋');
    expect(log).not.toContain('⠙');
    expect(log).not.toContain('⠹');
  });

  it('preserves plain text with no escape codes unchanged', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('line one\nline two\n');
    await new Promise((r) => setTimeout(r, 20));

    const log = readFileSync(join(dir, 'pty-logs', 'bob.log'), 'utf8');
    expect(log).toContain('line one\nline two\n');
  });
});

// ─── getOutputTail() ─────────────────────────────────────────────────────────

describe('pty adapter getOutputTail()', () => {
  it('returns empty string when log file does not exist', async () => {
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {});
    // Remove the log file to simulate missing log
    const logFile = join(dir, 'pty-logs', 'bob.log');
    rmSync(logFile, { force: true });
    expect(adapter.getOutputTail('pty:bob')).toBe('');
  });

  it('returns ANSI-stripped and trimmed log tail', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('\x1b[32mhello world\x1b[0m\n');
    await new Promise((r) => setTimeout(r, 20));
    const tail = adapter.getOutputTail('pty:bob');
    expect(tail).toBe('hello world');
    expect(tail).not.toContain('\x1b[');
  });

  it('returns null on invalid session handle', async () => {
    const { adapter } = await makeAdapter();
    expect(adapter.getOutputTail('invalid-handle')).toBeNull();
  });
});

// ─── detectBlockingPromptFromText() ──────────────────────────────────────────

describe('detectBlockingPromptFromText()', () => {
  let detect: (text: string) => string | null;

  beforeEach(async () => {
    const mod = await import('./pty.ts');
    detect = mod.detectBlockingPromptFromText;
  });

  // -- bracket/paren forms --

  it('matches [y/n] square-bracket form', () => {
    expect(detect('Apply these changes? [y/n]')).toBe('Apply these changes? [y/n]');
  });

  it('matches (y/n) parenthesis form', () => {
    expect(detect('Apply these changes? (y/n)')).toBe('Apply these changes? (y/n)');
  });

  it('matches [yes/no] square-bracket form', () => {
    expect(detect('Continue? [yes/no]')).toBe('Continue? [yes/no]');
  });

  it('matches (yes/no) parenthesis form', () => {
    expect(detect('Continue? (yes/no)')).toBe('Continue? (yes/no)');
  });

  // -- verb-led prompts without a trailing question mark --

  it('matches verb-led prompt without question mark ("Would you like … [y/n]")', () => {
    expect(detect('Would you like to proceed [y/n]')).toBe('Would you like to proceed [y/n]');
  });

  it('matches "grant" verb-led prompt', () => {
    expect(detect('Grant access to this resource? (y/n)')).toBe('Grant access to this resource? (y/n)');
  });

  it('matches "permit" verb-led prompt', () => {
    expect(detect('Permit execution of this script? [y/n]')).toBe('Permit execution of this script? [y/n]');
  });

  // -- ANSI stripping --

  it('strips ANSI escape codes before matching', () => {
    expect(detect('\x1b[32mContinue?\x1b[0m [y/n]')).toBe('Continue? [y/n]');
  });

  // -- multi-line: scan from bottom --

  it('returns the matching line closest to the bottom of multi-line text', () => {
    const text = 'Some earlier output\nApply patch? [y/n]\nInstall package? [y/n]';
    expect(detect(text)).toBe('Install package? [y/n]');
  });

  // -- quota / rate-limit path --

  it('returns matching line for rate limit text', () => {
    expect(detect('API rate limit exceeded. Try again later.')).toBe('API rate limit exceeded. Try again later.');
  });

  it('returns matching line for context window exhaustion', () => {
    expect(detect('Context window limit reached for this session.')).toBe('Context window limit reached for this session.');
  });

  // -- non-matching cases --

  it('returns null for plain text with no prompt indicators', () => {
    expect(detect('Running tests...\nAll tests passed.')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(detect('')).toBeNull();
  });

  it('returns null for "permission required" diagnostic text without [y/n]', () => {
    expect(detect('Note: permission required to access /etc/shadow')).toBeNull();
  });

  it('returns null for quoted dialog text without a real [y/n] indicator', () => {
    expect(detect('The dialog asks: "Do you want to allow this extension to run?"\nInstallation complete.')).toBeNull();
  });

  // -- diff/code context filtering --

  it('returns null when prompt text appears in a diff removed line', () => {
    expect(detect('- Would you like to apply these changes? [y/n]\nDone.')).toBeNull();
  });

  it('returns null when prompt text appears in a diff added line', () => {
    expect(detect('+ Would you like to apply these changes? [y/n]\nDone.')).toBeNull();
  });

  it('returns null when prompt text appears in a diff hunk header context', () => {
    expect(detect('@@ -135,7 +135,7 @@ tool asking "Would you like to apply these changes? [y/n]"')).toBeNull();
  });

  it('returns null when prompt text appears in a numbered diff line', () => {
    expect(detect('135 -tool asking "Would you like to apply these changes? [y/n]"')).toBeNull();
  });

  it('still matches a real prompt even when diff lines precede it', () => {
    const text = '- old prompt line [y/n]\n+ new prompt line [y/n]\nApply patch? [y/n]';
    expect(detect(text)).toBe('Apply patch? [y/n]');
  });

  // -- recency window --

  it('returns null when prompt is buried beyond the recency window', () => {
    const lines = [
      'Would you like to proceed? [y/n]',
      'Line 2 after prompt',
      'Line 3 after prompt',
      'Line 4 after prompt',
      'Line 5 after prompt',
      'Line 6 after prompt',
      'All done.',
    ];
    expect(detect(lines.join('\n'))).toBeNull();
  });

  it('matches a prompt within the recency window', () => {
    const lines = [
      'Some earlier output',
      'More output',
      'Continue? [y/n]',
      'Line after prompt',
    ];
    expect(detect(lines.join('\n'))).toBe('Continue? [y/n]');
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
