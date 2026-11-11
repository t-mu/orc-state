import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases } from '../lib/eventLog.ts';
import { startControlServer, type ControlServer } from '../lib/controlServer.ts';
import type { TerminalBroker } from '../lib/terminalBroker.ts';
import type { TerminalViewer } from '../lib/terminalHost.ts';

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const repoRoot = join(import.meta.dirname, '..');
const socket = `orc-terminal-test-${process.pid}`;

let dir: string;
let server: ControlServer;
const release = vi.fn();
const acquire = vi.fn(() => ({ lease_id: 'lease-1', expires_at: new Date(Date.now() + 30_000).toISOString() }));
const input = vi.fn((..._args: unknown[]) => Promise.resolve());

function tmux(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000, env });
}

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A broker with one agent terminal whose stream stays open; it records lease releases and sends `output` after the snapshot. */
function fakeBroker(output: string[] = []): TerminalBroker {
  const terminal = { terminal_id: 'term-1', kind: 'provider', run_id: null, state: 'running' };
  return {
    providerForAgent: () => terminal,
    acquire,
    renew: () => undefined,
    release,
    resize: () => undefined,
    input,
    stream: (_id: string, viewer: TerminalViewer) => {
      viewer.send({ type: 'snapshot', screen: 'AGENT SCREEN\n', cursor_x: 0, cursor_y: 1, columns: 100, rows: 30 });
      for (const data of output) viewer.send({ type: 'output', data: Buffer.from(data).toString('base64') });
      return () => undefined;
    },
    sessions: () => [],
    reconcile: () => undefined,
    close: () => undefined,
  } as unknown as TerminalBroker;
}

describe.skipIf(!hasTmux)('orc terminal --write in a window that closes', () => {
  beforeEach(async () => {
    dir = createTempStateDir('orch-terminal-hup-');
    seedState(dir);
    release.mockClear();
    server = await startControlServer(dir, { terminals: fakeBroker() });
  });

  afterEach(async () => {
    tmux(['kill-server']);
    await server.close();
    closeAllDatabases();
    cleanupTempStateDir(dir);
  });

  it('releases its lease when the window is closed (hang-up), so the tab can be reopened at once', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ORC_STATE_DIR: dir, ORC_SESSION_ID: '', ORC_SESSION_TOKEN: '' };
    delete env.TMUX;
    const started = tmux(['new-session', '-d', '-s', 'tab', '-x', '100', '-y', '30', '-c', repoRoot,
      process.execPath, join(repoRoot, 'cli', 'orc.ts'), 'terminal', 'w1', '--write'], env);
    expect(started.status, started.stderr).toBe(0);
    await waitFor(() => tmux(['capture-pane', '-p', '-t', '=tab:']).stdout.includes('writer lease acquired'), 15_000);
    expect(release).not.toHaveBeenCalled();

    // Closing the window hangs up the terminal.
    tmux(['kill-session', '-t', '=tab']);
    await waitFor(() => release.mock.calls.length > 0);
    expect(release).toHaveBeenCalledWith('term-1', 'lease-1');
  }, 30_000);
});

describe.skipIf(!hasTmux)('orc terminal --write and the agent\'s mouse tracking', () => {
  beforeEach(async () => {
    dir = createTempStateDir('orch-terminal-mouse-');
    seedState(dir);
    // The agent turns on any-motion SGR mouse tracking, split across frames.
    server = await startControlServer(dir, { terminals: fakeBroker(['AGENT \x1b[?1003', ';1006h\x1b[?1000hOUTPUT\x1b[?2004h']) });
  });

  afterEach(async () => {
    tmux(['kill-server']);
    await server.close();
    closeAllDatabases();
    cleanupTempStateDir(dir);
  });

  it('resets mouse reporting left on and keeps the agent from turning it on', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ORC_STATE_DIR: dir, ORC_SESSION_ID: '', ORC_SESSION_TOKEN: '' };
    delete env.TMUX;
    // An older orc terminal left any-motion tracking on in this pane.
    const command = `printf '\\033[?1003h\\033[?1006h'; exec '${process.execPath}' '${join(repoRoot, 'cli', 'orc.ts')}' terminal w1 --write`;
    const started = tmux(['new-session', '-d', '-s', 'tab', '-x', '100', '-y', '30', '-c', repoRoot, command], env);
    expect(started.status, started.stderr).toBe(0);
    await waitFor(() => tmux(['capture-pane', '-p', '-t', '=tab:']).stdout.includes('AGENT OUTPUT'), 15_000);
    const flags = tmux(['display-message', '-p', '-t', '=tab:', '#{mouse_any_flag} #{mouse_standard_flag} #{mouse_sgr_flag}']).stdout.trim();
    expect(flags).toBe('0 0 0');
  }, 30_000);
});

describe.skipIf(!hasTmux)('orc terminal --view-first (a cockpit agent tab)', () => {
  beforeEach(async () => {
    dir = createTempStateDir('orch-terminal-view-');
    seedState(dir);
    release.mockClear();
    acquire.mockClear();
    input.mockClear();
    server = await startControlServer(dir, { terminals: fakeBroker() });
  });

  afterEach(async () => {
    tmux(['kill-server']);
    await server.close();
    closeAllDatabases();
    cleanupTempStateDir(dir);
  });

  const screen = () => tmux(['capture-pane', '-p', '-t', '=tab:']).stdout;
  const keys = (...args: string[]) => tmux(['send-keys', '-t', '=tab:', ...args]);

  function open() {
    const env: NodeJS.ProcessEnv = { ...process.env, ORC_STATE_DIR: dir, ORC_SESSION_ID: '', ORC_SESSION_TOKEN: '' };
    delete env.TMUX;
    const command = `'${process.execPath}' '${join(repoRoot, 'cli', 'orc.ts')}' terminal w1 --view-first; echo "EXIT=$?"; sleep 30`;
    const started = tmux(['new-session', '-d', '-s', 'tab', '-x', '100', '-y', '30', '-c', repoRoot, command], env);
    expect(started.status, started.stderr).toBe(0);
  }

  it.each([['C-d'], ['C-c'], ['Escape']])('holds no lease and sends nothing in view mode; %s closes it with the closed exit code', async (key) => {
    open();
    await waitFor(() => screen().includes('[view] i: type'), 15_000);
    keys('a', 'Enter');
    await new Promise((r) => setTimeout(r, 300));
    expect(screen()).not.toContain('EXIT=');
    keys(key);
    await waitFor(() => screen().includes('EXIT=10'));
    expect(acquire).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
  }, 30_000);

  it('i takes the lease and forwards keys; Ctrl-] releases it and returns to view mode; q closes', async () => {
    open();
    await waitFor(() => screen().includes('[view] i: type'), 15_000);
    keys('i');
    await waitFor(() => screen().includes('[typing → agent]'));
    expect(acquire).toHaveBeenCalledTimes(1);
    keys('-l', 'q');
    await waitFor(() => input.mock.calls.length > 0);
    expect(input).toHaveBeenCalledWith('term-1', 'lease-1', 'q');
    keys('C-]');
    await waitFor(() => release.mock.calls.length > 0);
    expect(release).toHaveBeenCalledWith('term-1', 'lease-1');
    expect(screen()).not.toContain('EXIT=');
    keys('-l', 'q');
    await waitFor(() => screen().includes('EXIT=10'));
    expect(input).toHaveBeenCalledTimes(1);
  }, 30_000);
});
