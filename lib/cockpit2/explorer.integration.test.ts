import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tmuxExplorerHost } from './explorer.ts';
import { SOCKET_PATH_MAX_BYTES, tmuxSocketPathBytes } from '../../vitest.tmuxTmpdir.mjs';

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasTmux)('tmuxExplorerHost (private tmux server)', () => {
  const socket = `orc-cockpit-explorer-test-${process.pid}-${Date.now()}`;
  it('keeps its tmux socket paths under the 104-byte limit', () => {
    for (const name of [socket]) expect(tmuxSocketPathBytes(name), name).toBeLessThanOrEqual(SOCKET_PATH_MAX_BYTES);
  });
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
  afterAll(() => { tmux('kill-server'); });

  it('starts the explorer in a sized session without a status line, replaces a leftover one, and stops it', async () => {
    const host = tmuxExplorerHost({ tmuxBinary: 'tmux', socket, command: (projectId) => `unset ORC_PROJECT_ID; echo explorer-${projectId}; exec cat` });
    // The server takes its default shell from $SHELL; a non-POSIX one must not break the POSIX script.
    const shell = process.env.SHELL;
    process.env.SHELL = '/bin/false';
    let target;
    try {
      target = await host.start('demo', { cols: 50, rows: 12 });
    } finally {
      if (shell === undefined) delete process.env.SHELL;
      else process.env.SHELL = shell;
    }
    expect(target).toEqual({ socket, session: 'explorer-demo' });
    expect(tmux('display-message', '-p', '-t', '=explorer-demo:', '#{pane_width}x#{pane_height} #{status}').stdout.trim()).toBe('50x12 off');
    const until = Date.now() + 5_000;
    while (!tmux('capture-pane', '-p', '-t', '=explorer-demo:').stdout.includes('explorer-demo')) {
      if (Date.now() > until) throw new Error('the explorer command did not run');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pane = tmux('display-message', '-p', '-t', '=explorer-demo:', '#{pane_pid}').stdout.trim();
    // A second start (a cockpit that crashed left the first) replaces the session.
    await host.start('demo', { cols: 40, rows: 10 });
    expect(tmux('display-message', '-p', '-t', '=explorer-demo:', '#{pane_pid}').stdout.trim()).not.toBe(pane);
    await host.stop(target);
    expect(tmux('has-session', '-t', '=explorer-demo').status).not.toBe(0);
    // Stopping a session that is gone resolves too.
    await host.stop(target);
  }, 20_000);

  it('kills the session new-session made when a command chained after it fails', async () => {
    // A tmux that names an option no tmux has in place of `status`, so the set-option after new-session fails.
    const dir = mkdtempSync(join(tmpdir(), 'orc-explorer-tmux-'));
    const wrapper = join(dir, 'tmux');
    writeFileSync(wrapper, '#!/bin/sh\nfor a; do shift; [ "$a" = status ] && a=no-such-option; set -- "$@" "$a"; done\nexec tmux "$@"\n');
    chmodSync(wrapper, 0o755);
    try {
      const host = tmuxExplorerHost({ tmuxBinary: wrapper, socket, command: () => 'exec cat' });
      await expect(host.start('broken', { cols: 40, rows: 10 })).rejects.toThrow(/no-such-option/);
      expect(tmux('has-session', '-t', '=explorer-broken').status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
