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

/** A broker with one agent terminal whose stream stays open; it records lease releases. */
function fakeBroker(): TerminalBroker {
  const terminal = { terminal_id: 'term-1', kind: 'provider', run_id: null, state: 'running' };
  return {
    providerForAgent: () => terminal,
    acquire: () => ({ lease_id: 'lease-1', expires_at: new Date(Date.now() + 30_000).toISOString() }),
    renew: () => undefined,
    release,
    resize: () => undefined,
    input: () => Promise.resolve(),
    stream: (_id: string, viewer: TerminalViewer) => {
      viewer.send({ type: 'snapshot', screen: 'AGENT SCREEN\n', cursor_x: 0, cursor_y: 1, columns: 100, rows: 30 });
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
