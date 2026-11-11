import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type ProjectWatchState } from '../../client.ts';
import { MASTER_TAB, closeTab, openAgent, selectTab } from '../cockpitTabs.ts';
import { DEFAULT_COCKPIT_KEYS } from '../cockpitKeys.ts';
import { runApp } from './app.ts';
import { tmuxExplorerHost, type ExplorerHost } from './explorer.ts';
import { EDGE_ROW } from './frame.ts';
import { FakeTerminal, FakeWatcher, F12, MemoryStore, apps, projectState, shown, slotRows, waitFor, waitForSlotLine, waitForTabBar } from '../../test-fixtures/cockpitAppFakes.ts';

// ── the app against a private tmux server ────────────────────────────────────

afterEach(() => { for (const app of apps.splice(0)) app.quit(); });

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasTmux)('runApp (private tmux server)', () => {
  const socket = `orc-cockpit-app-test-${process.pid}-${Date.now()}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  /** The explorer's private server, standing in for `orc-explorer`. */
  const explorerSocket = `${socket}-explorer`;
  const explorerTmux = (...args: string[]) => spawnSync('tmux', ['-L', explorerSocket, ...args], { encoding: 'utf8' });
  afterAll(() => { tmux('kill-server'); explorerTmux('kill-server'); });
  const windowSize = (session: string) => tmux('display-message', '-p', '-t', `=${session}:`, '#{window_width}x#{window_height}').stdout.trim();

  function startReal(projects: ProjectWatchState[], explorer?: ExplorerHost) {
    const terminal = new FakeTerminal();
    const app = runApp({
      terminal, keys: DEFAULT_COCKPIT_KEYS, tmuxBinary: 'tmux', store: new MemoryStore(),
      projects: new FakeWatcher(projects), projectId: 'fake', explorer,
    });
    apps.push(app);
    return { terminal, app };
  }

  it('shows the master\'s shell, types into it, follows a resize and leaves the session running on quit', async () => {
    const session = 'orc-master-fake';
    const created = tmux('new-session', '-d', '-s', session, '-x', '100', '-y', '30',
      'env -i TERM=tmux-256color PS1="$ " LANG=C.UTF-8 sh');
    expect(created.status, created.stderr).toBe(0);
    const { terminal, app } = startReal([projectState('fake', { master: { socket, session } })]);
    await waitFor(() => windowSize(session) === '46x19');

    // Typed bytes arrive and the output appears in the slot.
    await waitForSlotLine(terminal, '$');
    terminal.type('echo cockpit-$((6*7))\r');
    await waitForSlotLine(terminal, 'cockpit-42');

    // A resize re-lays out: the window follows the slot and the shell sees the new size.
    terminal.resizeTo(120, 40);
    await waitFor(() => windowSize(session) === '86x35');
    // tmux applies the pane's new tty size a moment after the window's: ask again until the shell sees it.
    await waitFor(() => tmux('display-message', '-p', '-t', `=${session}:`, '#{pane_width}x#{pane_height}').stdout.trim() === '86x35');
    for (let attempt = 0; ; attempt++) {
      terminal.type('clear; stty size\r');
      try { await waitForSlotLine(terminal, '35 86', 1_000); break; } catch (error) { if (attempt === 4) throw error; }
    }
    expect((await shown(terminal)).row(0).length).toBe(120);

    terminal.type('\x11');
    await app.done;
    expect(terminal.restored).toBe(1);
    expect(tmux('has-session', '-t', `=${session}`).status).toBe(0);
  }, 20_000);

  it('quits on the prefix then d and leaves the master\'s session running', async () => {
    const session = 'orc-master-prefix';
    const created = tmux('new-session', '-d', '-s', session, '-x', '100', '-y', '30', 'env -i PS1="$ " sh');
    expect(created.status, created.stderr).toBe(0);
    const { terminal, app } = startReal([projectState('fake', { master: { socket, session } })]);
    await waitForSlotLine(terminal, '$');
    terminal.type(`${F12}d`);
    await app.done;
    expect(terminal.restored).toBe(1);
    expect(tmux('has-session', '-t', `=${session}`).status).toBe(0);
  }, 20_000);

  it('switches between master and worker tabs without resizing the worker, and shows output written while a tab was hidden', async () => {
    const master = 'orc-master-tabs';
    const worker = 'orc-w1-tabs';
    for (const [session, size] of [[master, ['100', '30']], [worker, ['70', '15']]] as const) {
      const created = tmux('new-session', '-d', '-s', session, '-x', size[0], '-y', size[1], 'env -i TERM=tmux-256color PS1="$ " LANG=C.UTF-8 sh');
      expect(created.status, created.stderr).toBe(0);
    }
    const before = windowSize(worker);
    expect(before).toBe('70x15');
    const { terminal, app } = startReal([projectState('fake', { master: { socket, session: master }, workers: [{ agent_id: 'w1', socket, session: worker }] })]);
    await waitFor(() => windowSize(master) === '46x19');
    await waitForSlotLine(terminal, '$');

    // The worker's tab: its screen keeps the worker's size inside the slot, the window is untouched.
    tmux('send-keys', '-t', `=${worker}:`, 'echo worker-$((6*7))', 'Enter');
    app.apply((state) => openAgent(state, 'fake', 'w1'));
    await waitForSlotLine(terminal, 'worker-42');
    expect(windowSize(worker)).toBe(before);
    const workerRows = await slotRows(terminal);
    expect(workerRows[0].length).toBeLessThanOrEqual(46);
    expect(workerRows[15]).toBe(EDGE_ROW.repeat(46)); // the edge marker row under the 15-row screen

    // Output written to the master while its tab is hidden is shown after switching back, as capture-pane has it.
    tmux('send-keys', '-t', `=${master}:`, 'clear; for i in 1 2 3; do echo hidden-$i; done', 'Enter');
    await waitFor(() => tmux('capture-pane', '-p', '-t', `=${master}:`).stdout.includes('hidden-3'));
    app.apply((state) => selectTab(state, MASTER_TAB));
    await waitForSlotLine(terminal, 'hidden-3');
    const captured = tmux('capture-pane', '-p', '-t', `=${master}:`).stdout.split('\n').slice(0, 19).map((line) => line.trimEnd());
    expect(await slotRows(terminal)).toEqual(captured);

    // Back to the worker and once more: its window still has its own size.
    app.apply((state) => selectTab(state, 'w1'));
    await waitForSlotLine(terminal, 'worker-42');
    expect(windowSize(worker)).toBe(before);
    app.apply((state) => closeTab(state));
    await waitForSlotLine(terminal, 'hidden-3');
    expect(tmux('has-session', '-t', `=${worker}`).status).toBe(0);
    expect(windowSize(worker)).toBe(before);
  }, 30_000);

  it('opens the task explorer as a tab on its private server, sized to the slot, and closes it back to the master', async () => {
    const master = 'orc-master-explorer';
    const created = tmux('new-session', '-d', '-s', master, '-x', '100', '-y', '30', 'env -i TERM=tmux-256color PS1="$ " LANG=C.UTF-8 sh');
    expect(created.status, created.stderr).toBe(0);
    // A stand-in for `orc cockpit explorer`: it shows its project, echoes each read in brackets and quits on q, as the explorer's list does.
    const reader = "process.stdin.setRawMode(true); process.stdin.on('data', (d) => { const s = d.toString(); if (s === 'q') process.exit(0); process.stdout.write('[' + s + ']'); });".replace(/'/g, '"');
    const host = tmuxExplorerHost({
      tmuxBinary: 'tmux', socket: explorerSocket,
      command: (projectId) => `echo explorer-for-$(printf %s ${projectId}); exec ${process.execPath} -e '${reader}'`,
    });
    const { terminal, app } = startReal([projectState('fake', { master: { socket, session: master } })], host);
    await waitForSlotLine(terminal, '$');
    const before = app.tabs();

    terminal.type(`${F12}t`);
    await waitForSlotLine(terminal, 'explorer-for-fake');
    expect(explorerTmux('display-message', '-p', '-t', '=explorer-fake:', '#{window_width}x#{window_height} #{status}').stdout.trim()).toBe('46x19 off');
    await waitForTabBar(terminal, 1, '2 tasks ×');
    // Its keys reach it one read each, also when they arrive in one read (j and k navigate the real explorer); the master gets none.
    terminal.type('jjk');
    await waitForSlotLine(terminal, '[j][j][k]');

    // q makes it quit: its session ends, the cockpit closes the tab and shows the master again with the keys.
    terminal.type('q');
    await waitFor(() => explorerTmux('has-session', '-t', '=explorer-fake').status !== 0);
    await waitForSlotLine(terminal, '$');
    expect(app.tabs()).toEqual(before);
    expect(tmux('capture-pane', '-p', '-t', `=${master}:`).stdout).not.toContain('jjk');
    await waitForTabBar(terminal, 1, 'tasks Ctrl-q: quit');

    // Opened again, it closes with the cockpit.
    terminal.type(`${F12}t`);
    await waitForSlotLine(terminal, 'explorer-for-fake');
    terminal.type('\x11');
    await app.done;
    await waitFor(() => explorerTmux('has-session', '-t', '=explorer-fake').status !== 0);
    expect(tmux('has-session', '-t', `=${master}`).status).toBe(0);
  }, 30_000);
});
