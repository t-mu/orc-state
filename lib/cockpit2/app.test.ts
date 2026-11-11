import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { tmuxSessionTarget, type ProjectWatchState } from '../../client.ts';
import { MASTER_TAB, closeTab, openAgent, selectTab, showProject } from '../cockpitTabs.ts';
import { DEFAULT_COCKPIT_KEYS, resolveCockpitKeys, type CockpitKeys } from '../cockpitKeys.ts';
import {
  FOOTER_ROWS, HEADER_ROWS, SIDEBAR_COLS, TAB_BAR_ROWS, agentTarget, computeLayout, dispatchMouse, footerHints, hitTest, masterTarget, quitHint, runApp, shortQuitHint, slotMessage,
} from './app.ts';
import type { ColorDepth } from './color.ts';
import { BUILT_IN_THEMES, resolveTheme, type Theme } from './theme.ts';
import type { ExplorerHost } from './explorer.ts';
import type { MouseEvent } from './mouse.ts';
import { EDGE_COLUMN, EDGE_ROW } from './frame.ts';
import type { PaneClient } from './sessions.ts';
import type { PaneReport } from './tmuxControl.ts';
import { DEFAULT_VIEW_STATE, addProject, type TmuxTarget } from './viewState.ts';
import {
  ESC, F12, FakeTerminal, FakeWatcher, MASTER_TARGET, MemoryStore, W1_TARGET, apps, projectState, shown, sidebarRows, sleep, slotRows, text,
  waitFor, waitForSidebar, waitForSlotLine, waitForSlotText, waitForTabBar,
} from '../../test-fixtures/cockpitAppFakes.ts';

// ── layout ────────────────────────────────────────────────────────────────────

describe('computeLayout', () => {
  it('lays out 80x24: a header row, a 34-column sidebar, a 3-row tab bar over a 46x19 slot, a footer row', () => {
    expect(computeLayout(80, 24)).toEqual({
      cols: 80, rows: 24,
      header: { x: 0, y: 0, cols: 80, rows: HEADER_ROWS },
      sidebar: { x: 0, y: 1, cols: SIDEBAR_COLS, rows: 22 },
      tabBar: { x: 34, y: 1, cols: 46, rows: TAB_BAR_ROWS },
      slot: { x: 34, y: 4, cols: 46, rows: 19 },
      footer: { x: 0, y: 23, cols: 80, rows: FOOTER_ROWS },
    });
  });

  it('keeps the sidebar width, the tab bar height and both full-width rows at 200x60 and 120x40', () => {
    const layout = computeLayout(200, 60);
    expect(layout.header).toEqual({ x: 0, y: 0, cols: 200, rows: 1 });
    expect(layout.sidebar).toEqual({ x: 0, y: 1, cols: 34, rows: 58 });
    expect(layout.tabBar).toEqual({ x: 34, y: 1, cols: 166, rows: 3 });
    expect(layout.slot).toEqual({ x: 34, y: 4, cols: 166, rows: 55 });
    expect(layout.footer).toEqual({ x: 0, y: 59, cols: 200, rows: 1 });
    const mid = computeLayout(120, 40);
    expect(mid.slot).toEqual({ x: 34, y: 4, cols: 86, rows: 35 });
    expect(mid.sidebar.rows).toBe(38);
    expect(mid.footer).toEqual({ x: 0, y: 39, cols: 120, rows: 1 });
  });

  it('drops the footer, then the header, then shrinks the tab bar before the slot falls below 20x3', () => {
    // 30x8: room for everything.
    expect(computeLayout(30, 8)).toMatchObject({ header: { rows: 1 }, footer: { y: 7, rows: 1 }, slot: { x: 10, y: 4, cols: 20, rows: 3 } });
    // 30x7: the footer goes first.
    const seven = computeLayout(30, 7);
    expect(seven.header.rows).toBe(1);
    expect(seven.footer).toEqual({ x: 0, y: 7, cols: 30, rows: 0 });
    expect(seven.slot).toEqual({ x: 10, y: 4, cols: 20, rows: 3 });
    expect(seven.sidebar).toEqual({ x: 0, y: 1, cols: 10, rows: 6 });
    // 30x6: then the header; the tab bar keeps its three rows.
    const six = computeLayout(30, 6);
    expect(six.header.rows).toBe(0);
    expect(six.footer.rows).toBe(0);
    expect(six.tabBar).toEqual({ x: 10, y: 0, cols: 20, rows: 3 });
    expect(six.slot).toEqual({ x: 10, y: 3, cols: 20, rows: 3 });
    expect(six.sidebar).toEqual({ x: 0, y: 0, cols: 10, rows: 6 });
    // 30x4: the tab bar shrinks; the slot keeps its minimum.
    const four = computeLayout(30, 4);
    expect(four.sidebar.cols).toBe(10);
    expect(four.tabBar.rows).toBe(1);
    expect(four.slot).toEqual({ x: 10, y: 1, cols: 20, rows: 3 });
    expect(four.header.rows + four.footer.rows).toBe(0);
  });
});

describe('hitTest and dispatchMouse', () => {
  const layout = computeLayout(80, 24);
  const click = (x: number, y: number): MouseEvent => ({ button: 'left', shift: false, alt: false, ctrl: false, motion: false, release: false, x, y });

  it('finds the region under a cell and the cell relative to it', () => {
    expect(hitTest(layout, 0, 0)).toEqual({ region: 'header', x: 0, y: 0 });
    expect(hitTest(layout, 79, 0)).toEqual({ region: 'header', x: 79, y: 0 });
    expect(hitTest(layout, 0, 1)).toEqual({ region: 'sidebar', x: 0, y: 0 });
    expect(hitTest(layout, 33, 22)).toEqual({ region: 'sidebar', x: 33, y: 21 });
    expect(hitTest(layout, 34, 1)).toEqual({ region: 'tabBar', x: 0, y: 0 });
    expect(hitTest(layout, 79, 3)).toEqual({ region: 'tabBar', x: 45, y: 2 });
    expect(hitTest(layout, 34, 4)).toEqual({ region: 'slot', x: 0, y: 0 });
    expect(hitTest(layout, 79, 22)).toEqual({ region: 'slot', x: 45, y: 18 });
    expect(hitTest(layout, 0, 23)).toEqual({ region: 'footer', x: 0, y: 0 });
    expect(hitTest(layout, 79, 23)).toEqual({ region: 'footer', x: 79, y: 0 });
    expect(hitTest(layout, 80, 1)).toBeNull();
    expect(hitTest(layout, 0, 24)).toBeNull();
    // A dropped header or footer is never hit.
    expect(hitTest(computeLayout(30, 6), 0, 0)?.region).toBe('sidebar');
    expect(hitTest(computeLayout(30, 6), 15, 5)?.region).toBe('slot');
  });

  it('hands an event to its region\'s handler with region-relative coordinates', () => {
    const seen: Array<[string, number, number]> = [];
    const handlers = { slot: (_: MouseEvent, at: { x: number; y: number }) => seen.push(['slot', at.x, at.y]) };
    expect(dispatchMouse(layout, click(40, 6), handlers)).toBe('slot');
    expect(dispatchMouse(layout, click(1, 2), handlers)).toBe('sidebar'); // no handler yet: nothing happens
    expect(dispatchMouse(layout, click(40, 0), handlers)).toBe('header'); // nothing happens there yet
    expect(dispatchMouse(layout, click(40, 23), handlers)).toBe('footer');
    expect(dispatchMouse(layout, click(90, 2), handlers)).toBeNull();
    expect(seen).toEqual([['slot', 6, 2]]);
  });
});

// ── tmux targets ──────────────────────────────────────────────────────────────

describe('masterTarget', () => {
  const stateDir = '/data/projects/p1';
  const status = (master: object | null) => ({ master, worker_capacity: { slots: [] }, scouts: [] }) as never;
  const recorded = status({ agent_id: 'master', tmux_socket: 'orc-abc', tmux_session: 'orc-master-1' });
  const stored = { socket: 'orc-stored', session: 'orc-master-stored' };

  it('uses the status view\'s recorded target while the coordinator runs', () => {
    expect(masterTarget({ stateDir, running: true, status: recorded }, stored)).toEqual({ socket: 'orc-abc', session: 'orc-master-1' });
  });

  it('uses the stored target while the coordinator is down, even with a stale status view', () => {
    expect(masterTarget({ stateDir, running: false, status: recorded }, stored)).toEqual(stored);
    expect(masterTarget({ stateDir: null, running: false, status: null }, stored)).toEqual(stored);
  });

  it('computes it from the state directory as a last resort, or gives null when nothing is known', () => {
    expect(masterTarget({ stateDir, running: false, status: null }, null)).toEqual(tmuxSessionTarget(stateDir, 'master'));
    const custom = status({ agent_id: 'boss', tmux_socket: null, tmux_session: null });
    expect(masterTarget({ stateDir, running: true, status: custom }, null)).toEqual(tmuxSessionTarget(stateDir, 'boss'));
    expect(masterTarget({ stateDir: null, running: false, status: null }, null)).toBeNull();
  });
});

describe('agentTarget', () => {
  const stateDir = '/data/projects/p1';
  const status = {
    master: null,
    worker_capacity: { slots: [
      { agent_id: 'w1', tmux_socket: 'orc-abc', tmux_session: 'orc-w1-x', session_handle: 'tmux:orc-abc:orc-w1-x' },
      { agent_id: 'w2', tmux_socket: null, tmux_session: null, session_handle: 'app:codex-1' },
    ] },
    scouts: [{ agent_id: 's1', tmux_socket: 'orc-abc', tmux_session: 'orc-s1-x', session_handle: 'tmux:orc-abc:orc-s1-x' }],
  } as never;

  it('uses the status view\'s target of a worker or scout, else computes it', () => {
    expect(agentTarget({ stateDir, running: true, status }, 'w1')).toEqual({ socket: 'orc-abc', session: 'orc-w1-x' });
    expect(agentTarget({ stateDir, running: true, status }, 's1')).toEqual({ socket: 'orc-abc', session: 'orc-s1-x' });
    expect(agentTarget({ stateDir, running: false, status: null }, 'w9')).toEqual(tmuxSessionTarget(stateDir, 'w9'));
  });

  it('gives null for a session that is not on tmux, or a project with no state directory', () => {
    expect(agentTarget({ stateDir, running: true, status }, 'w2')).toBeNull();
    expect(agentTarget({ stateDir: null, running: false, status: null }, 'w1')).toBeNull();
  });
});

describe('slotMessage', () => {
  const keys = DEFAULT_COCKPIT_KEYS;
  const target = { socket: 'orc-sock', session: 'orc-master' };
  const master = { projectId: 'p1', agentId: null };
  const ended = { state: { kind: 'ended' as const, reason: 'can\'t find session: orc-master' }, error: null, screen: null };

  it('shows a stopped project\'s message with its start command when its master session is gone', () => {
    expect(slotMessage({ tab: master, keys, target, session: ended, project: { name: 'demo', repoRoot: '/repo/demo', connection: 'stopped' } })).toEqual([
      'Project demo is not running.', 'Start it with: cd /repo/demo && orc start-session', 'tmux: can\'t find session: orc-master', quitHint(keys),
    ]);
  });

  it('gives no start command while the coordinator is up, connecting or unreachable', () => {
    for (const connection of ['running', 'connecting', 'unreachable'] as const) {
      const lines = slotMessage({ tab: master, keys, target, session: ended, project: { name: 'demo', repoRoot: '/repo/demo', connection } });
      expect(lines).toEqual(['The master\'s tmux session is not running.', 'tmux: can\'t find session: orc-master', `Coordinator: ${connection}.`, quitHint(keys)]);
    }
  });

  it('says why an agent tab or a missing project shows nothing, and that a tab is attaching', () => {
    const worker = { projectId: 'p1', agentId: 'w1' };
    const project = { name: 'demo', repoRoot: '/repo/demo', connection: 'running' as const };
    expect(slotMessage({ tab: worker, keys, target, session: ended, project })?.[0]).toBe('w1\'s tmux session is not running.');
    expect(slotMessage({ tab: worker, keys, target: null, session: null, project })?.[0]).toBe('w1 does not run in tmux, so the cockpit cannot show it.');
    expect(slotMessage({ tab: master, keys, target: null, session: null, project: null })?.[0]).toBe('Project p1 is not registered.');
    expect(slotMessage({ tab: null, keys, target: null, session: null, project: null })?.[0]).toBe('No project is open.');
    expect(slotMessage({ tab: master, keys, target, session: null, project })?.[0]).toContain('Attaching to the master (tmux -L orc-sock');
    expect(slotMessage({ tab: master, keys, target, session: { state: { kind: 'live' }, error: 'capture failed', screen: null }, project }))
      .toEqual(['The master is not shown.', 'capture failed', quitHint(keys)]);
  });
});

describe('footerHints', () => {
  it('names quit, dashboard and attention by the resolved keys', () => {
    expect(footerHints(DEFAULT_COCKPIT_KEYS)).toEqual([
      { key: 'Ctrl-q', action: 'quit' }, { key: 'F10', action: 'dashboard' }, { key: 'F11', action: 'attention' },
    ]);
    const { keys } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'C-a', ORC_COCKPIT_KEYS: 'quit=M-x,dashboard=C-F5,attention=none' });
    expect(footerHints(keys)).toEqual([{ key: 'Alt-x', action: 'quit' }, { key: 'Ctrl-F5', action: 'dashboard' }]);
    // Without direct keys: the prefix then d, the prefix then o.
    expect(footerHints({ ...keys, quit: null, direct: { ...keys.direct, dashboard: null } })).toEqual([{ key: 'Ctrl-a d', action: 'quit' }, { key: 'Ctrl-a o', action: 'dashboard' }]);
  });
});

describe('quitHint', () => {
  it('names the quit key and the prefix then d, spelled out', () => {
    expect(quitHint(DEFAULT_COCKPIT_KEYS)).toBe('Ctrl-q: quit · F12 d: quit');
    expect(quitHint({ ...DEFAULT_COCKPIT_KEYS, prefix: 'C-a', quit: null })).toBe('Ctrl-a d: quit');
    expect(shortQuitHint(DEFAULT_COCKPIT_KEYS)).toBe('Ctrl-q: quit');
    expect(shortQuitHint({ ...DEFAULT_COCKPIT_KEYS, prefix: 'C-a', quit: null })).toBe('Ctrl-a d: quit');
  });
});

// ── the app with fake tmux clients ───────────────────────────────────────────

const MODES: PaneReport = {
  paneId: '%1', cols: 46, rows: 21, cursorX: 2, cursorY: 0, alternateOn: false, mouseAny: false, mouseButton: false,
  mouseStandard: false, mouseSgr: false, mouseUtf8: false, keypadCursor: false, cursorVisible: true,
};

class FakeClient extends EventEmitter {
  resizes: string[] = [];
  sent: string[] = [];
  pastes: string[] = [];
  paused: string[] = [];
  resumed: string[] = [];
  closed = 0;
  modeQueries = 0;
  lines = ['$ hello'];
  /** Set to hold the next capture until the test releases it. */
  gate: Promise<void> | null = null;
  size = { cols: MODES.cols, rows: MODES.rows };
  /** Pane modes the next mode query reports, as tmux would for modes the pane's program set. */
  modes: Partial<PaneReport> = {};
  constructor(readonly target: TmuxTarget, readonly ignoreSize: boolean, readonly paneId = '%1') { super(); }
  resize(cols: number, rows: number) { this.resizes.push(`${cols}x${rows}`); this.size = { cols, rows }; return Promise.resolve(); }
  paneModes() { this.modeQueries++; return Promise.resolve({ ...MODES, ...this.modes, paneId: this.paneId, ...this.size }); }
  async capture() { if (this.gate) await this.gate; return this.lines; }
  sendBytes(pane: string, bytes: Buffer) { this.sent.push(`${pane} ${bytes.toString('latin1')}`); return Promise.resolve(); }
  paste(pane: string, text: string) { this.pastes.push(`${pane} ${text}`); return Promise.resolve(); }
  pause(pane: string) { this.paused.push(pane); return Promise.resolve(); }
  resume(pane: string) { this.resumed.push(pane); return Promise.resolve(); }
  close() { this.closed++; }
}

afterEach(() => { for (const app of apps.splice(0)) app.quit(); });

interface StartOptions {
  keys?: CockpitKeys; projects?: ProjectWatchState[]; store?: MemoryStore; projectId?: string;
  /** Adjusts each fake client as it is created (before its first mode query). */
  setup?: (fake: FakeClient) => void;
  explorer?: ExplorerHost;
  colorDepth?: ColorDepth;
  theme?: Theme;
}

function start({ keys = DEFAULT_COCKPIT_KEYS, projects = [projectState('demo')], store = new MemoryStore(), projectId = 'demo', setup, explorer, colorDepth, theme }: StartOptions = {}) {
  const terminal = new FakeTerminal();
  const watcher = new FakeWatcher(projects);
  const clients: FakeClient[] = [];
  const app = runApp({
    terminal, keys, tmuxBinary: 'tmux', store, projects: watcher, projectId,
    connect: (target, { ignoreSize }) => {
      const fake = new FakeClient(target, ignoreSize, `%${clients.length + 1}`);
      fake.lines = [`$ hello from ${target.session}`];
      setup?.(fake);
      clients.push(fake);
      return fake as unknown as PaneClient;
    },
    resyncDelayMs: 5,
    explorer,
    colorDepth,
    theme,
  });
  apps.push(app);
  const client = () => clients[0];
  return { terminal, clients, client, app, store, watcher };
}

/** Waits until a session's capture is shown in the slot. */
async function attached(terminal: FakeTerminal, session = 'orc-master'): Promise<void> {
  await waitForSlotLine(terminal, `$ hello from ${session}`);
}

describe('runApp (fake tmux client)', () => {
  it('draws a pane\'s RGB colours as is by default and as xterm-256 indices with colorDepth 256', async () => {
    const rgbLine = (fake: FakeClient) => { fake.lines = [`${ESC}[38;2;255;0;0;48;2;0;0;255m$ hello from ${fake.target.session}${ESC}[0m`]; };
    const truecolor = start({ setup: rgbLine });
    await attached(truecolor.terminal);
    expect(truecolor.terminal.writes.join('')).toContain('38;2;255;0;0;48;2;0;0;255m');
    const reduced = start({ setup: rgbLine, colorDepth: '256' });
    await attached(reduced.terminal);
    const out = reduced.terminal.writes.join('');
    expect(out).toContain('38;5;196;48;5;21m');
    expect(out).not.toMatch(/[34]8;2;/);
  });

  it('draws its chrome in amber by default and in the theme it is given', async () => {
    const AMBER_BORDER = '38;2;255;176;0m';
    const VIOLET = '38;2;124;58;237m';
    const amber = start();
    await attached(amber.terminal);
    expect(amber.terminal.writes.join('')).toContain(AMBER_BORDER);
    expect(amber.terminal.writes.join('')).not.toContain(VIOLET);

    const violet = resolveTheme(BUILT_IN_THEMES.amber, { 'chrome.border': { fg: '#7c3aed' } }).theme;
    const themed = start({ theme: violet });
    await attached(themed.terminal);
    expect(themed.terminal.writes.join('')).toContain(VIOLET);

    const mono = start({ theme: BUILT_IN_THEMES.mono });
    await attached(mono.terminal);
    // The pane's own text has no colour either, so nothing the cockpit draws sets an RGB foreground.
    expect(mono.terminal.writes.join('')).not.toMatch(/38;2;/);
  });

  it('shows the master in the slot next to the sidebar and tab bar, its window sized to the slot', async () => {
    const { terminal, clients } = start();
    await attached(terminal);
    expect(clients.map((fake) => [fake.target, fake.ignoreSize])).toEqual([[MASTER_TARGET, false]]);
    expect(clients[0].resizes).toEqual(['46x19']);
    const screen = await shown(terminal);
    expect(text(screen, 4, 34)).toBe('$ hello from orc-master');
    expect((await sidebarRows(terminal)).some((row) => row.includes('▸ demo-project'))).toBe(true);
    expect(text(screen, 2, 34)).toContain('master');
    expect(text(screen, 2, 34).endsWith('Ctrl-q: quit')).toBe(true);
    // The cursor is where the pane has it, in frame coordinates.
    expect(screen.cursor()).toEqual({ x: 36, y: 4, visible: true });
    // The footer, full width on the last row: the mode, project › tab, the keys; the header row is blank for now.
    expect(text(screen, 23)).toBe('[master] keys go to the master · demo-project › master · Ctrl-q: quit');
    expect(text(screen, 0)).toBe('');
  });

  it('names the resolved keys in the footer', async () => {
    const { terminal } = start({ keys: resolveCockpitKeys({ ORC_COCKPIT_KEYS: 'quit=C-x,dashboard=M-d,attention=M-a' }).keys });
    await attached(terminal);
    terminal.resizeTo(140, 30);
    await waitFor(async () => text(await shown(terminal), 29).includes('Alt-a: attention'));
    expect(text(await shown(terminal), 29)).toBe('[master] keys go to the master · demo-project › master · Ctrl-x: quit · Alt-d: dashboard · Alt-a: attention');
  });

  it('writes nothing while idle and coalesces a burst of output into few frames', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    await sleep(30);
    const settled = terminal.writes.length;
    await sleep(150);
    expect(terminal.writes.length).toBe(settled);
    for (let i = 0; i < 50; i++) client().emit('output', '%1', Buffer.from(`x${i} `));
    await waitFor(() => terminal.writes.join('').includes('x49'));
    await sleep(50);
    expect(terminal.writes.length - settled).toBeLessThanOrEqual(3);
    const afterBurst = terminal.writes.length;
    await sleep(100);
    expect(terminal.writes.length).toBe(afterBurst);
  });

  it('ignores output from other panes', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    await sleep(30);
    const settled = terminal.writes.length;
    client().emit('output', '%9', Buffer.from('elsewhere'));
    await sleep(60);
    expect(terminal.writes.length).toBe(settled);
  });

  it('drops output the capture already shows and keeps what arrives after it', async () => {
    const { terminal, client } = start();
    let release!: () => void;
    client().gate = new Promise((resolve) => { release = resolve; });
    await waitFor(() => client().modeQueries === 1);
    await sleep(5);
    client().emit('output', '%1', Buffer.from('BEFORE')); // in the capture already
    release();
    client().gate = null;
    await attached(terminal);
    client().emit('output', '%1', Buffer.from('AFTER'));
    await waitFor(() => terminal.writes.join('').includes('AFTER'));
    expect(terminal.writes.join('')).not.toContain('BEFORE');
  });

  it('forwards typed bytes to the master pane and pastes through paste()', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    terminal.type('ls -l\r');
    terminal.type(`${ESC}[A`);
    terminal.type(`${ESC}[200~one\ntwo${ESC}[201~`);
    expect(client().sent).toEqual(['%1 l', '%1 s', '%1  ', '%1 -', '%1 l', '%1 \r', `%1 ${ESC}[A`]);
    expect(client().pastes).toEqual(['%1 one\ntwo']);
  });

  it('quits on Ctrl-q: the terminal is restored and the control client closed, nothing sent to the master', async () => {
    const { terminal, client, app } = start();
    await attached(terminal);
    terminal.type('\x11');
    expect(await app.done).toBe('quit');
    expect(terminal.restored).toBe(1);
    expect(client().closed).toBe(1);
    expect(client().sent).toEqual([]);
    const writes = terminal.writes.length;
    client().emit('output', '%1', Buffer.from('more'));
    await sleep(40);
    expect(terminal.writes.length).toBe(writes);
  });

  it('quits on the prefix then d; the prefix twice reaches the pane', async () => {
    const { terminal, client, app } = start();
    await attached(terminal);
    terminal.type(`${F12}${F12}`);
    terminal.type(`${F12}x`); // not in the prefix table: dropped
    expect(client().sent).toEqual([`%1 ${F12}`]);
    terminal.type(`${F12}d`);
    await app.done;
    expect(client().closed).toBe(1);
  });

  it('takes the quit key from the keys setting', async () => {
    const { terminal, client, app } = start({ keys: { ...DEFAULT_COCKPIT_KEYS, prefix: 'C-a', quit: 'C-x' } });
    await attached(terminal);
    terminal.type('\x11');
    expect(client().sent).toEqual(['%1 \x11']);
    terminal.type('\x18');
    await app.done;
    expect(terminal.restored).toBe(1);
  });

  it('re-lays out on resize: the window follows the slot and the frame is redrawn at the new size', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    terminal.resizeTo(200, 60);
    await waitFor(() => client().resizes.includes('166x55'));
    client().lines = ['$ resized'];
    client().emit('resize', 166, 55);
    await waitForSlotLine(terminal, '$ resized');
    const screen = await shown(terminal);
    expect(text(screen, 4, 34)).toBe('$ resized');
    expect(text(screen, 2, 34)).toContain('Ctrl-q: quit');
  });

  it('keeps showing the master and taking input after a keystroke or paste fails', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    const fake = client();
    const sendBytes = fake.sendBytes.bind(fake);
    const paste = fake.paste.bind(fake);
    fake.sendBytes = () => { fake.sendBytes = sendBytes; return Promise.reject(new Error('send-keys failed')); };
    fake.paste = () => { fake.paste = paste; return Promise.reject(new Error('set-buffer failed')); };
    terminal.type('a');
    terminal.type(`${ESC}[200~big${ESC}[201~`);
    await sleep(30);
    terminal.type('b');
    terminal.type(`${ESC}[200~next${ESC}[201~`);
    expect(fake.sent).toEqual(['%1 b']);
    expect(fake.pastes).toEqual(['%1 next']);
    const screen = await shown(terminal);
    expect(text(screen, 4, 34)).toBe('$ hello from orc-master');
  });

  it('says so when the master\'s session ends and stops typing into it', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    client().emit('exit', 'session closed');
    await waitFor(() => terminal.writes.join('').includes('not running'));
    terminal.type('x');
    expect(client().sent).toEqual([]);
  });

  it('keeps a restore failure shown instead of a half-restored screen', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    client().capture = () => Promise.reject(new Error('capture-pane failed'));
    client().emit('resize', 46, 21);
    await waitForSlotText(terminal, 'capture-pane failed');
    // Nothing is typed into a pane the slot does not show.
    terminal.type('x');
    terminal.type(`${ESC}[200~text${ESC}[201~`);
    expect(client().sent).toEqual([]);
    expect(client().pastes).toEqual([]);
  });
});

describe('runApp tabs and projects (fake tmux clients)', () => {
  const twoTabs = () => start({ projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] })] });

  it('opens a worker tab as an ignore-size view and switches between tabs, each shown correctly', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    expect(app.apply((state) => openAgent(state, 'demo', 'w1')).ok).toBe(true);
    await attached(terminal, 'orc-w1');
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    const [master, worker] = clients;
    expect([worker.target, worker.ignoreSize]).toEqual([W1_TARGET, true]);
    expect(worker.resizes).toEqual([]); // a view never sizes the worker's window
    expect(text(await shown(terminal), 2, 34)).toContain('w1');

    expect(app.apply((state) => selectTab(state, 1)).ok).toBe(true);
    await waitForSlotLine(terminal, '$ hello from orc-master');
    expect(clients).toHaveLength(2); // the master's client was kept
    expect(master.closed).toBe(0);
    terminal.type('x');
    expect(master.sent).toEqual(['%1 x']);
    expect(worker.sent).toEqual([]);
  });

  it('pauses a hidden tab\'s output and restores it from a fresh capture when shown again', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    const master = clients[0];
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    expect(master.paused).toEqual(['%1']);
    const queries = master.modeQueries;

    // Output arriving while hidden (in flight before the pause) is not applied; the capture on return shows the pane.
    master.emit('output', '%1', Buffer.from('\r\nHIDDEN-STALE'));
    master.lines = ['$ hello from orc-master', '$ written while hidden'];
    app.apply((state) => selectTab(state, MASTER_TAB));
    await waitForSlotLine(terminal, '$ written while hidden');
    expect(master.resumed).toEqual(['%1']);
    expect(master.modeQueries).toBe(queries + 1);
    expect(clients[1].paused).toEqual(['%2']);
    expect((await slotRows(terminal)).join('\n')).not.toContain('HIDDEN-STALE');

    master.emit('output', '%1', Buffer.from('\x1b[5;1Hlive again'));
    await waitForSlotLine(terminal, 'live again');
  });

  it('pads a smaller worker screen into the slot with the edge marker, and crops a larger one', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    const worker = clients[1];
    worker.size = { cols: 20, rows: 5 };
    worker.emit('resize', 20, 5); // the worker's window changed size (not through the cockpit)
    await waitForSlotLine(terminal, `$ hello from orc-w1 ${EDGE_COLUMN}`);
    const rows = await slotRows(terminal);
    expect(rows[5]).toBe(EDGE_ROW.repeat(20));
    expect(rows[6]).toBe('');

    worker.size = { cols: 60, rows: 30 };
    worker.lines = [`$ ${'x'.repeat(58)}`];
    worker.emit('resize', 60, 30);
    await waitForSlotLine(terminal, `$ ${'x'.repeat(44)}`);
    expect(worker.resizes).toEqual([]);
  });

  it('closing a tab only detaches its view', async () => {
    const { terminal, clients, app, store } = twoTabs();
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    const result = app.apply((state) => closeTab(state));
    expect(result.ok).toBe(true);
    expect(clients[1].closed).toBe(1);
    expect(clients[1].sent).toEqual([]);
    await waitForSlotLine(terminal, '$ hello from orc-master');
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: [], active: null });
    await sleep(5);
    expect(store.state.tabs.projects[0]).toEqual({ projectId: 'demo', tabs: [], active: null });
  });

  it('opens a worker tab view-only: no key or paste reaches the worker until i; the mode and its keys are shown', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    const worker = clients[1];
    terminal.type(`hello\r${ESC}[A`);
    terminal.type(`${ESC}[200~pasted${ESC}[201~`);
    terminal.type(`${F12}${F12}`);
    await sleep(40);
    expect(worker.sent).toEqual([]);
    expect(worker.pastes).toEqual([]);
    expect(clients[0].sent).toEqual([]);
    await waitForSidebar(terminal, '[view] i: type · q/Esc: close');
    await waitForTabBar(terminal, 1, '○ w1');

    terminal.type('i');
    await waitForSidebar(terminal, '[typing] Ctrl-]: stop typing');
    await waitForTabBar(terminal, 1, '✎ w1');
    expect(worker.sent).toEqual([]); // i itself only starts typing
    terminal.type(`q\x04\x03${ESC}[A`);
    terminal.type(`${ESC}[200~pasted${ESC}[201~`);
    expect(worker.sent).toEqual(['%2 q', '%2 \x04', '%2 \x03', `%2 ${ESC}[A`]);
    expect(worker.pastes).toEqual(['%2 pasted']);

    terminal.type('\x1d'); // Ctrl-] back to view mode
    await waitForSidebar(terminal, '[view]');
    terminal.type('x');
    expect(worker.sent).toHaveLength(4);
    expect(app.tabs().projects[0].tabs).toEqual(['w1']);
  });

  it('forwards a lone Esc to a typing worker after the Esc timeout', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type('i');
    terminal.type(ESC);
    await waitFor(() => clients[1].sent.length === 1);
    expect(clients[1].sent).toEqual([`%2 ${ESC}`]);
    expect(app.tabs().projects[0].tabs).toEqual(['w1']);
  });

  for (const [name, key] of [['q', 'q'], ['Esc', ESC], ['Ctrl-D', '\x04'], ['Ctrl-C', '\x03'], ['Ctrl-]', '\x1d']] as const) {
    it(`closes a view-mode worker tab on ${name} in one keypress, the worker untouched`, async () => {
      const { terminal, clients, app } = twoTabs();
      await attached(terminal);
      app.apply((state) => openAgent(state, 'demo', 'w1'));
      await waitForSlotLine(terminal, '$ hello from orc-w1');
      terminal.type(key);
      await waitFor(() => app.tabs().projects[0].tabs.length === 0);
      await waitForSlotLine(terminal, '$ hello from orc-master');
      expect(clients[1].sent).toEqual([]);
      expect(clients[1].closed).toBe(1);
      expect(clients[0].sent).toEqual([]);
    });
  }

  it('reopens a closed worker tab view-only again, and returns a tab left in typing mode to view mode', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type('i');
    terminal.type(`${F12}1`); // the master tab through the prefix table
    await waitForSlotLine(terminal, '$ hello from orc-master');
    terminal.type(`${F12}2`);
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type('a'); // view mode again: dropped
    expect(clients[1].sent).toEqual([]);
    terminal.type('ia');
    expect(clients[1].sent).toEqual(['%2 a']);
    terminal.type('\x1dq'); // stop typing, close
    await waitForSlotLine(terminal, '$ hello from orc-master');
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type('b');
    await sleep(20);
    expect(clients.at(-1)!.sent).toEqual([]);
  });

  it('runs the prefix table and direct keys: tabs, closing and projects', async () => {
    const { terminal, app } = start({ projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] }), projectState('other')] });
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type(`${F12}n`);
    expect(app.tabs().projects[0].active).toBe(null);
    terminal.type(`${F12}p`);
    expect(app.tabs().projects[0].active).toBe('w1');
    terminal.type(`${ESC}OP`); // F1: the master tab
    expect(app.tabs().projects[0].active).toBe(null);
    terminal.type(`${F12}&`); // the master tab stays open
    expect(app.tabs().projects[0].tabs).toEqual(['w1']);
    terminal.type(`${ESC}OQ${F12}&`); // F2, then close it
    expect(app.tabs().projects[0].tabs).toEqual([]);
    app.apply((state) => showProject(state, 'other'));
    terminal.type(`${F12}N`);
    expect(app.tabs().activeProject).toBe('demo');
    terminal.type(`${F12}P`);
    expect(app.tabs().activeProject).toBe('other');
  });

  it('mirrors the shown pane\'s application cursor key mode to the real terminal on tab switch and mode change', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    const modeWrites = () => terminal.writes.join('').match(/\x1b\[\?1[hl]/g) ?? [];
    const lastMode = () => modeWrites().at(-1) ?? 'none';
    expect(modeWrites()).toEqual([]);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    const worker = clients[1];
    worker.modes = { keypadCursor: true }; // what tmux reports once the program set the mode
    worker.emit('output', '%2', Buffer.from(`${ESC}[?1h`));
    await waitFor(() => lastMode() === `${ESC}[?1h`);
    app.apply((state) => selectTab(state, MASTER_TAB));
    await waitFor(() => lastMode() === `${ESC}[?1l`);
    app.apply((state) => selectTab(state, 'w1'));
    await waitFor(() => lastMode() === `${ESC}[?1h`);
    worker.modes = {};
    worker.emit('output', '%2', Buffer.from(`${ESC}[?1l`));
    await waitFor(() => lastMode() === `${ESC}[?1l`);
    // Each write is a change: the mode never repeats.
    expect(modeWrites().every((mode, index, all) => index === 0 || mode !== all[index - 1])).toBe(true);
  });

  it('saves the tabs and the running master\'s target to the view state, and reopens them on start', async () => {
    const store = new MemoryStore();
    const first = start({ store, projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] })] });
    await attached(first.terminal);
    first.app.apply((state) => openAgent(state, 'demo', 'w1'));
    first.app.quit();
    await first.app.done;
    expect(store.state).toEqual({
      tabs: { activeProject: 'demo', projects: [{ projectId: 'demo', tabs: ['w1'], active: 'w1' }] },
      masterTargets: { demo: MASTER_TARGET },
    });

    const second = start({ store, projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] })] });
    await attached(second.terminal, 'orc-w1');
    expect(second.clients.map((fake) => fake.target)).toEqual([W1_TARGET]); // only the shown tab attaches
  });

  it('ends with takeover when another cockpit asked it to exit, restored and saved as on a quit', async () => {
    const store = new MemoryStore();
    const { terminal, client, app } = start({ store });
    await attached(terminal);
    app.quit('takeover');
    expect(await app.done).toBe('takeover');
    expect(terminal.restored).toBe(1);
    expect(client().closed).toBe(1);
    expect(store.state.tabs.activeProject).toBe('demo');
  });

  it('keeps a project another process added while it saves, and reloadViewState shows the project that process made active', async () => {
    const store = new MemoryStore();
    const projects = [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] }), projectState('other', { master: { socket: 'orc-other', session: 'orc-master-other' } })];
    const { terminal, app } = start({ store, projects });
    await attached(terminal);
    // Another checkout's start-session adds its project (viewState.ts addProject) before this cockpit's next save.
    await addProject(store, 'other');
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitFor(() => store.state.tabs.projects.some((project) => project.projectId === 'demo' && project.active === 'w1'));
    // The save kept the added project; this cockpit took it in, and (another writer having made it active) shows it.
    expect(store.state.tabs.projects.map((project) => project.projectId)).toEqual(['demo', 'other']);
    await waitFor(() => app.tabs().activeProject === 'other');
    await attached(terminal, 'orc-master-other');

    // A wake-up after another add: the project is taken in and shown at once.
    await addProject(store, 'third');
    app.reloadViewState();
    expect(app.tabs().activeProject).toBe('third');
    expect(app.tabs().projects.map((project) => project.projectId)).toEqual(['demo', 'other', 'third']);
    await waitFor(() => store.state.tabs.activeProject === 'third');
    // A reload with nothing new changes nothing.
    app.apply((state) => showProject(state, 'demo'));
    await waitFor(() => store.state.tabs.activeProject === 'demo');
    app.reloadViewState();
    expect(app.tabs().activeProject).toBe('demo');
  });

  it('shows the master from the stored target while the coordinator is down', async () => {
    const stored = { socket: 'orc-old', session: 'orc-master-stored' };
    const store = new MemoryStore({ tabs: { activeProject: 'demo', projects: [{ projectId: 'demo', tabs: [], active: null }] }, masterTargets: { demo: stored } });
    // A stale status view still names another target; the coordinator is down, so the stored one wins.
    const { terminal, clients } = start({ store, projects: [projectState('demo', { running: false, master: MASTER_TARGET })] });
    await attached(terminal, 'orc-master-stored');
    expect(clients.map((fake) => [fake.target, fake.ignoreSize])).toEqual([[stored, false]]);
    expect(store.state.masterTargets).toEqual({ demo: stored });
  });

  it('follows a running coordinator\'s master target and stores it', async () => {
    const stored = { socket: 'orc-old', session: 'orc-master-stored' };
    const store = new MemoryStore({ tabs: { activeProject: 'demo', projects: [{ projectId: 'demo', tabs: [], active: null }] }, masterTargets: { demo: stored } });
    const { terminal, clients, watcher } = start({ store, projects: [projectState('demo', { running: false })] });
    await attached(terminal, 'orc-master-stored');
    watcher.emit({ type: 'connection', project_id: 'demo', connection: 'running', error: null });
    await attached(terminal, 'orc-master');
    expect(clients.map((fake) => fake.target)).toEqual([stored, MASTER_TARGET]);
    expect(clients[0].closed).toBe(1);
    await sleep(5);
    expect(store.state.masterTargets).toEqual({ demo: MASTER_TARGET });
  });

  it('keeps master targets another writer stored, and shows a failed save in the tab bar until a save succeeds', async () => {
    const store = new MemoryStore({ ...DEFAULT_VIEW_STATE, masterTargets: { other: { socket: 'orc-o', session: 'orc-master-o' } } });
    const { terminal, app } = start({ store });
    await attached(terminal);
    expect(store.state.masterTargets).toEqual({ other: { socket: 'orc-o', session: 'orc-master-o' }, demo: MASTER_TARGET });

    store.failWith = new Error('EACCES: permission denied');
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitFor(() => app.saveError() === 'EACCES: permission denied');
    await waitForTabBar(terminal, 2, 'view state not saved: EACCES');
    store.failWith = null;
    app.apply((state) => selectTab(state, MASTER_TAB));
    await waitFor(() => app.saveError() === null);
    expect(store.state.tabs.projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: null });
  });

  it('shows a stopped project\'s message and start command when its master is gone too', async () => {
    // No stored target and the coordinator down: the computed one is tried.
    const { terminal, client } = start({ projects: [projectState('demo', { running: false })] });
    await attached(terminal, tmuxSessionTarget('/state/demo', 'master').session);
    terminal.resizeTo(120, 30);
    client().emit('exit', 'can\'t find session: orc-master');
    await waitForSlotText(terminal, 'Project demo-project is not running.');
    await waitForSlotText(terminal, 'Start it with: cd /repo/demo && orc start-session');
  });

  it('switches projects: each keeps its own tabs and master', async () => {
    const other = { socket: 'orc-other', session: 'orc-master-other' };
    const { terminal, clients, app } = start({ projects: [projectState('demo'), projectState('other', { master: other })] });
    await attached(terminal);
    app.apply((state) => showProject(state, 'other'));
    await attached(terminal, 'orc-master-other');
    expect(clients.map((fake) => fake.target)).toEqual([MASTER_TARGET, other]);
    expect(clients[0].paused).toEqual(['%1']);
    await waitForSidebar(terminal, '▸ other-project');
    app.apply((state) => showProject(state, 'demo'));
    await waitForSlotLine(terminal, '$ hello from orc-master');
    expect(clients[0].resumed).toEqual(['%1']);
    expect(app.tabs().projects.map((project) => project.projectId)).toEqual(['demo', 'other']);
  });
});

// ── sidebar and tab bar widgets ───────────────────────────────────────────────

const F10 = `${ESC}[21~`;
const WIDE_TARGET = { socket: 'orc-sock', session: 'orc-wide' };
const WIDE_AGENT = '作業者-🚀';
/** An SGR left-button press (or release) at frame cell (x, y). */
const click = (x: number, y: number, release = false) => `${ESC}[<0;${x + 1};${y + 1}${release ? 'm' : 'M'}`;
/** The frame column of the first cell on row `y` whose grapheme is `grapheme` (a wide one takes two columns), or -1. */
async function columnOf(terminal: FakeTerminal, y: number, grapheme: string, from = 0): Promise<number> {
  const row = (await shown(terminal)).row(y);
  return row.findIndex((cell, x) => x >= from && cell.text === grapheme);
}
async function sidebarRow(terminal: FakeTerminal, part: string): Promise<number> {
  await waitForSidebar(terminal, part);
  return (await sidebarRows(terminal)).findIndex((row) => row.includes(part));
}

describe('runApp sidebar and tab bar (fake tmux clients)', () => {
  const withWorkers = () => start({
    projects: [
      projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }, { agent_id: WIDE_AGENT, ...WIDE_TARGET, attention: { kind: 'question', detail: 'Which one?' } }] }),
      projectState('other', { master: { socket: 'orc-other', session: 'orc-master-other' }, name: '日本語' }),
    ],
  });

  it('draws the sidebar from the watched projects and agents, wide names included, and badges an agent needing attention', async () => {
    const { terminal } = withWorkers();
    await attached(terminal);
    await waitForSidebar(terminal, '▸ demo-project');
    await waitForSidebar(terminal, '日本語');
    await waitForSidebar(terminal, `${WIDE_AGENT}`);
    const rows = await sidebarRows(terminal);
    // The agent needing attention sorts first and shows its badge in its phase's place.
    const wide = rows.findIndex((row) => row.includes(WIDE_AGENT));
    expect(rows[wide]).toContain('QUESTION');
    expect(wide).toBeLessThan(rows.findIndex((row) => row.includes('w1 ')));
    expect(rows[1].endsWith('╮')).toBe(true); // row 0 is the header
    // Every box row ends on the sidebar's right border, wide names or not.
    const screen = await shown(terminal);
    for (let y = 1; y < 15; y++) expect(screen.row(y)[SIDEBAR_COLS - 1].text).toMatch(/[╮│╯]/);
    expect(rows[23]).toContain('[master] keys go to the master');
  });

  it('opens an agent on a click on its row, shows a tab on a click and closes it on its close marker, the worker untouched', async () => {
    const { terminal, clients, app } = withWorkers();
    terminal.resizeTo(120, 30); // room for all three tabs
    await waitForSlotText(terminal, '$ hello from orc-master');
    terminal.type(click(3, await sidebarRow(terminal, 'w1 ')));
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: 'w1' });
    // The opened tab takes the keys, as after a tab click: its view mode's keys work at once.
    await waitForSidebar(terminal, '[view] i: type');
    await waitForSlotText(terminal, '$ hello from orc-w1');
    // The second row of an agent opens it too; a wide name's tab lays out by display width.
    terminal.type(click(3, (await sidebarRow(terminal, WIDE_AGENT)) + 1));
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1', WIDE_AGENT], active: WIDE_AGENT });
    await waitForSlotText(terminal, '$ hello from orc-wide');
    await waitForTabBar(terminal, 1, `○ ${WIDE_AGENT} QUESTION ×`);

    // A release, motion or a right click does nothing; a press on the master tab shows it.
    const masterX = (await columnOf(terminal, 2, 'm', SIDEBAR_COLS));
    terminal.type(click(masterX, 2, true));
    terminal.type(`${ESC}[<32;${masterX + 1};3M${ESC}[<2;${masterX + 1};3M`);
    expect(app.tabs().projects[0].active).toBe(WIDE_AGENT);
    terminal.type(click(masterX, 2));
    expect(app.tabs().projects[0].active).toBe(null);
    await waitForSlotText(terminal, '$ hello from orc-master');

    // The close marker of the wide-named tab, found by its column on the real terminal.
    const firstClose = await columnOf(terminal, 2, '×', SIDEBAR_COLS);
    const wideClose = await columnOf(terminal, 2, '×', firstClose + 1);
    terminal.type(click(wideClose, 2));
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: null });
    const wideClient = clients.find((fake) => fake.target.session === 'orc-wide')!;
    expect(wideClient.closed).toBe(1);
    expect(wideClient.sent).toEqual([]);
    expect(wideClient.pastes).toEqual([]);
    for (let until = Date.now() + 2_000; text(await shown(terminal), 2, SIDEBAR_COLS).includes(WIDE_AGENT); await sleep(25)) {
      if (Date.now() > until) throw new Error('the closed tab is still drawn');
    }
    // A click on the master tab's text never closes it.
    terminal.type(click(masterX + 7, 2));
    expect(app.tabs().projects[0].tabs).toEqual(['w1']);
  });

  it('switches projects on a click on a project row, its master taking the keys', async () => {
    const { terminal, clients, app } = withWorkers();
    await attached(terminal);
    terminal.type(click(5, await sidebarRow(terminal, '日本語')));
    expect(app.tabs().activeProject).toBe('other');
    await attached(terminal, 'orc-master-other');
    await waitForSidebar(terminal, '▸ 日本語');
    // Its master takes the keys right away.
    const other = clients.find((fake) => fake.target.session === 'orc-master-other')!;
    terminal.type('z');
    expect(other.sent).toEqual([`${other.paneId} z`]);
  });

  it('navigates the sidebar by keyboard: F10 focuses it, arrows move, Enter opens and gives the opened tab the keys, Tab switches box, Esc returns to the pane', async () => {
    const { terminal, clients, app } = withWorkers();
    await attached(terminal);
    const master = clients[0];
    terminal.type(F10);
    await waitForSidebar(terminal, '↑↓ Tab · Enter: open · Esc: pane');
    // The cursor starts on the first agent (the one needing attention); down moves to w1, Enter opens it.
    terminal.type(`${ESC}[B\r`);
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: 'w1' });
    // The opened tab has the keys, as after a click: view mode, so i then a key reach the worker, and nothing the master.
    await waitForSidebar(terminal, '[view] i: type · q/Esc: close');
    await attached(terminal, 'orc-w1');
    const worker = clients.find((fake) => fake.target.session === 'orc-w1')!;
    terminal.type('ix');
    expect(worker.sent).toEqual([`${worker.paneId} x`]);
    expect(master.sent).toEqual([]);

    // Back in the sidebar (its cursor kept on w1): k moves up, Enter opens the wide-named agent.
    terminal.type(F10);
    await waitForSidebar(terminal, 'Enter: open');
    terminal.type('k\r');
    expect(app.tabs().projects[0].active).toBe(WIDE_AGENT);
    await waitForSidebar(terminal, '[view] i: type');

    // Tab to the projects box: down and Enter switch project, and its master takes the keys.
    terminal.type(F10);
    await waitForSidebar(terminal, 'Enter: open');
    terminal.type('\tj\r');
    expect(app.tabs().activeProject).toBe('other');
    await waitForSidebar(terminal, '▸ 日本語');
    await waitForSidebar(terminal, '[master] keys go to the master');
    await attached(terminal, 'orc-master-other');
    const other = clients.find((fake) => fake.target.session === 'orc-master-other')!;
    terminal.type('y');
    expect(other.sent).toEqual([`${other.paneId} y`]);

    // Esc returns from the sidebar to the pane without opening anything.
    terminal.type(F10);
    await waitForSidebar(terminal, 'Enter: open');
    terminal.type(ESC);
    await waitForSidebar(terminal, '[master] keys go to the master');
    terminal.type('z');
    expect(other.sent).toEqual([`${other.paneId} y`, `${other.paneId} z`]);
  });

  it('toggles the focus with the prefix then o, and a click in the slot gives it the keys', async () => {
    const { terminal, client } = withWorkers();
    await attached(terminal);
    terminal.type(`${F12}o`);
    await waitForSidebar(terminal, 'Enter: open');
    let screen = await shown(terminal);
    expect(screen.cursor().visible).toBe(false); // the pane's cursor is not shown while the sidebar has the keys
    terminal.type(`${F12}o`);
    await waitForSidebar(terminal, '[master]');
    terminal.type('a');
    expect(client().sent).toEqual(['%1 a']);
    terminal.type(F10);
    await waitForSidebar(terminal, 'Enter: open');
    terminal.type(click(50, 10));
    await waitForSidebar(terminal, '[master]');
    screen = await shown(terminal);
    expect(screen.cursor().visible).toBe(true);
  });

  it('shows why a tab transition was refused until the next key', async () => {
    const { terminal, app } = withWorkers();
    await attached(terminal);
    terminal.type(`${F12}&`);
    await waitForTabBar(terminal, 2, 'The master tab stays open');
    terminal.type('x');
    for (let until = Date.now() + 2_000; text(await shown(terminal), 3, SIDEBAR_COLS).includes('stays open'); await sleep(25)) {
      if (Date.now() > until) throw new Error('the refusal is still shown');
    }
    expect(app.tabs().projects[0].tabs).toEqual([]);
  });

  it('keeps the sidebar width and the tab bar height on every resize, usable at 80x24', async () => {
    const { terminal } = withWorkers();
    await attached(terminal);
    for (const [cols, rows] of [[200, 60], [80, 24], [120, 40]] as const) {
      terminal.resizeTo(cols, rows);
      await waitForSidebar(terminal, '▸ demo-project');
      for (let until = Date.now() + 2_000; ; await sleep(25)) {
        const screen = await shown(terminal);
        const footer = text(screen, rows - 1, 0, SIDEBAR_COLS);
        if (screen.row(1)[SIDEBAR_COLS - 1].text === '╮' && footer.includes('[master]') && text(screen, 3, SIDEBAR_COLS).startsWith('╯')) break;
        if (Date.now() > until) throw new Error(`layout not redrawn at ${cols}x${rows}`);
      }
      const { slot } = computeLayout(cols, rows);
      expect(slot).toEqual({ x: SIDEBAR_COLS, y: HEADER_ROWS + TAB_BAR_ROWS, cols: cols - SIDEBAR_COLS, rows: rows - HEADER_ROWS - TAB_BAR_ROWS - FOOTER_ROWS });
    }
  });
});

// ── pane mouse routing, scrollback and selection ─────────────────────────────

/** An SGR report with button code `code` at frame cell (x, y). */
const sgr = (code: number, x: number, y: number, release = false) => `${ESC}[<${code};${x + 1};${y + 1}${release ? 'm' : 'M'}`;
const SGR_ANY: Partial<PaneReport> = { mouseAny: true, mouseSgr: true };
/** The clipboard texts the cockpit sent with OSC 52. */
const copied = (terminal: FakeTerminal) => [...terminal.writes.join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)]
  .map((match) => Buffer.from(match[1], 'base64').toString('utf8'));

// ── task explorer and attention ───────────────────────────────────────────────

const F11 = `${ESC}[23~`;

/** An explorer host that records its sessions instead of starting tmux. */
class FakeExplorerHost implements ExplorerHost {
  started: string[] = [];
  stopped: TmuxTarget[] = [];
  failWith: Error | null = null;
  /** Set to hold starts until the test resolves it. */
  hold: Promise<void> | null = null;
  async start(projectId: string, size: { cols: number; rows: number }) {
    this.started.push(`${projectId} ${size.cols}x${size.rows}`);
    if (this.hold) await this.hold;
    if (this.failWith) throw this.failWith;
    return { socket: 'orc-explorer', session: `explorer-${projectId}` };
  }
  stop(target: TmuxTarget) { this.stopped.push(target); return Promise.resolve(); }
}

/** Makes `fake`'s sends wait until the test calls the returned function, which releases the oldest waiting one. */
function holdSends(fake: FakeClient): () => void {
  const waiting: Array<() => void> = [];
  const record = fake.sendBytes.bind(fake);
  fake.sendBytes = (pane: string, bytes: Buffer) => {
    void record(pane, bytes);
    return new Promise<void>((resolve) => { waiting.push(resolve); });
  };
  return () => waiting.shift()?.();
}

describe('runApp task explorer and attention jump (fake tmux clients)', () => {
  const explorerClient = (clients: FakeClient[]) => clients.find((fake) => fake.target.session.startsWith('explorer-'));

  it('opens the explorer as a tab on the prefix then t, forwards its keys, and closes it on q back to the active tab', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients, app } = start({ explorer: host });
    await attached(terminal);
    await waitForTabBar(terminal, 1, 'tasks Ctrl-q: quit');
    const before = app.tabs();
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    expect(host.started).toEqual(['demo 46x19']);
    const fake = explorerClient(clients)!;
    // The explorer's window is the cockpit's own: sized to the slot, not an ignore-size view.
    expect(fake.ignoreSize).toBe(false);
    await waitForTabBar(terminal, 1, '2 tasks ×');
    await waitForSidebar(terminal, '[tasks] Ctrl-] or ×: close');
    expect(text(await shown(terminal), 2, SIDEBAR_COLS)).not.toContain('tasks Ctrl-q'); // no entry while it is shown
    // Its own keys reach it; i is not the typing key here.
    terminal.type(`j${ESC}[Bi\r`);
    await waitFor(() => fake.sent.length === 4);
    expect(fake.sent).toEqual([`${fake.paneId} j`, `${fake.paneId} ${ESC}[B`, `${fake.paneId} i`, `${fake.paneId} \r`]);
    // The prefix then t again keeps it.
    terminal.type(`${F12}t`);
    expect(host.started).toHaveLength(1);
    // Ctrl-] closes it: its session is killed and the master shown again, the tabs as they were.
    terminal.type('\x1d');
    await attached(terminal);
    expect(host.stopped).toEqual([{ socket: 'orc-explorer', session: 'explorer-demo' }]);
    expect(fake.closed).toBe(1);
    expect(app.tabs()).toEqual(before);
    expect(clients[0].sent).toEqual([]); // nothing typed reached the master
    await waitForSidebar(terminal, '[master] keys go to the master');
  });

  it('opens on a click on the tasks entry, closes on its close marker, and gives way to any tab change', async () => {
    const host = new FakeExplorerHost();
    const { terminal, app } = start({ explorer: host, projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] })] });
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await attached(terminal, 'orc-w1');
    await waitForTabBar(terminal, 1, 'tasks');
    terminal.type(click(await columnOf(terminal, 2, 't', SIDEBAR_COLS + 20), 2));
    await attached(terminal, 'explorer-demo');
    const close = await columnOf(terminal, 2, '×', (await columnOf(terminal, 2, '×', SIDEBAR_COLS)) + 1);
    terminal.type(click(close, 2));
    await attached(terminal, 'orc-w1'); // back to the active tab
    expect(host.stopped).toHaveLength(1);

    // A tab change while the explorer is shown shows that tab and ends the explorer.
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    terminal.type(`${F12}1`);
    await attached(terminal);
    expect(app.tabs().projects[0].active).toBeNull();
    expect(host.stopped).toHaveLength(2);
    // Its own number keeps it shown.
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    terminal.type(`${F12}3`);
    expect(host.stopped).toHaveLength(2);
  });

  it('shows why the explorer did not start, closes when it quits on its own, and stops it when the cockpit quits', async () => {
    const host = new FakeExplorerHost();
    host.failWith = new Error('no server running on /tmp/tmux-1000/orc-explorer');
    const { terminal, clients, app } = start({ explorer: host });
    await attached(terminal);
    terminal.type(`${F12}t`);
    await waitForSlotText(terminal, 'The task explorer did not start.');
    await waitForSlotText(terminal, 'no server running');
    terminal.type('q');
    await attached(terminal);
    expect(host.stopped).toEqual([]); // no session was started

    host.failWith = null;
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    explorerClient(clients)!.emit('exit', 'session closed');
    await attached(terminal);
    expect(host.stopped).toHaveLength(1);

    terminal.type(`${F12}t`);
    await waitFor(() => clients.filter((fake) => fake.target.session === 'explorer-demo').length === 2);
    await attached(terminal, 'explorer-demo');
    app.quit();
    expect(host.stopped).toHaveLength(2);
  });

  it('lets the explorer own Esc and q: Esc goes back in its detail, q in its list ends it and the cockpit closes the tab', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients, app } = start({ explorer: host });
    await attached(terminal);
    const before = app.tabs();
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    const fake = explorerClient(clients)!;
    // Enter opens a task's detail; Esc (back to the list) reaches the explorer and the tab stays.
    terminal.type('\r');
    terminal.type(ESC);
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent).toEqual([`${fake.paneId} \r`, `${fake.paneId} ${ESC}`]);
    await sleep(30);
    expect(host.stopped).toEqual([]);
    await waitForTabBar(terminal, 1, '2 tasks ×');
    // q in its list: the explorer quits on its own, its session ends, the cockpit closes the tab.
    terminal.type('q');
    await waitFor(() => fake.sent.length === 3);
    expect(fake.sent[2]).toBe(`${fake.paneId} q`);
    fake.emit('exit', 'session closed');
    await attached(terminal);
    expect(app.tabs()).toEqual(before);
    expect(clients[0].sent).toEqual([]); // nothing reached the master
    await waitForSidebar(terminal, '[master] keys go to the master');
  });

  it('sends keys that arrive in one read to the explorer one at a time, each after the one before reached it', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients } = start({ explorer: host });
    await attached(terminal);
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    const fake = explorerClient(clients)!;
    const release = holdSends(fake);
    terminal.type('jj');
    await waitFor(() => fake.sent.length === 1);
    await sleep(30);
    expect(fake.sent).toEqual([`${fake.paneId} j`]);
    release();
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent).toEqual([`${fake.paneId} j`, `${fake.paneId} j`]);
    release();
  });

  it('sends no key queued for the explorer once it closed, to it or to the tab shown next', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients } = start({ explorer: host });
    await attached(terminal);
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    const fake = explorerClient(clients)!;
    const release = holdSends(fake);
    terminal.type('ab');
    await waitFor(() => fake.sent.length === 1);
    terminal.type('\x1d');
    await attached(terminal);
    release();
    await sleep(30);
    expect(fake.sent).toEqual([`${fake.paneId} a`]);
    expect(clients[0].sent).toEqual([]);
  });

  it('kills an explorer that was still starting when the cockpit quit before it is done', async () => {
    const host = new FakeExplorerHost();
    let started!: () => void;
    host.hold = new Promise((resolve) => { started = resolve; });
    const { terminal, app } = start({ explorer: host });
    await attached(terminal);
    terminal.type(`${F12}t`);
    await waitFor(() => host.started.length === 1);
    app.quit();
    let done = false;
    void app.done.then(() => { done = true; });
    await sleep(30);
    expect(done).toBe(false);
    started();
    await app.done;
    expect(host.stopped).toEqual([{ socket: 'orc-explorer', session: 'explorer-demo' }]);
  });

  it('returns a typing tab to view mode when another tab, the explorer or an attention jump is shown', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients, app } = start({
      explorer: host,
      projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }, { agent_id: 'w2', socket: 'orc-sock', session: 'orc-w2', attention: { kind: 'question', detail: null } }] })],
    });
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await attached(terminal, 'orc-w1');
    const worker = clients[1];
    // i, F1 (the master), F2 (back to w1): view mode again, so Ctrl-D closes the tab and reaches no agent.
    terminal.type('i');
    await waitForSidebar(terminal, '[typing]');
    terminal.type(`${ESC}OP`);
    await attached(terminal);
    terminal.type(`${ESC}OQ`);
    await attached(terminal, 'orc-w1');
    await waitForSidebar(terminal, '[view] i: type');
    terminal.type('\x04');
    await attached(terminal);
    expect(app.tabs().projects[0].tabs).toEqual([]);
    expect(worker.sent).toEqual([]);

    // The explorer shown over a typing tab: closed again, the tab is view-only.
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await attached(terminal, 'orc-w1');
    terminal.type('i');
    await waitForSidebar(terminal, '[typing]');
    terminal.type(`${F12}t`);
    await attached(terminal, 'explorer-demo');
    terminal.type('\x1d');
    await attached(terminal, 'orc-w1');
    await waitForSidebar(terminal, '[view] i: type');

    // An attention jump (F11 to w2) leaves w1 view-only too.
    terminal.type('i');
    await waitForSidebar(terminal, '[typing]');
    terminal.type(F11);
    await attached(terminal, 'orc-w2');
    terminal.type(`${ESC}OQ`);
    await attached(terminal, 'orc-w1');
    await waitForSidebar(terminal, '[view] i: type');
    expect(clients.filter((fake) => fake.target.session === 'orc-w1').flatMap((fake) => fake.sent)).toEqual([]);
  });

  it('refuses the explorer without a host, keeping the active tab', async () => {
    const { terminal } = start();
    await attached(terminal);
    expect(text(await shown(terminal), 2, SIDEBAR_COLS)).not.toContain('tasks');
    terminal.type(`${F12}t`);
    await waitForTabBar(terminal, 2, 'This cockpit has no task explorer.');
  });

  it('jumps to the next agent needing attention across projects on F11 and on a click on the badge', async () => {
    const { terminal, app } = start({
      projects: [
        projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }, { agent_id: 'w2', socket: 'orc-sock', session: 'orc-w2', attention: { kind: 'question', detail: null } }] }),
        projectState('other', {
          master: { socket: 'orc-other', session: 'orc-master-other' },
          workers: [{ agent_id: 'o1', socket: 'orc-other', session: 'orc-o1', attention: { kind: 'permission_prompt', detail: null } }],
        }),
        projectState('down', { running: false, workers: [{ agent_id: 'd1', socket: 'orc-down', session: 'orc-d1', attention: { kind: 'question', detail: null } }] }),
      ],
    });
    await attached(terminal);
    await waitForTabBar(terminal, 1, '! 2 Ctrl-q: quit'); // the stopped project's agent is not counted
    terminal.type(F11);
    await attached(terminal, 'orc-w2');
    expect(app.tabs().activeProject).toBe('demo');
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w2'], active: 'w2' });
    await waitForSidebar(terminal, '[view] i: type'); // it opens view-only, with the keys
    // The badge: the next one is in the other project, added with the agent's tab.
    terminal.type(click(await columnOf(terminal, 2, '!', SIDEBAR_COLS), 2));
    await attached(terminal, 'orc-o1');
    expect(app.tabs().activeProject).toBe('other');
    expect(app.tabs().projects[1]).toEqual({ projectId: 'other', tabs: ['o1'], active: 'o1' });
    // Wraps around.
    terminal.type(F11);
    await attached(terminal, 'orc-w2');
    expect(app.tabs().activeProject).toBe('demo');
  });

  it('says so when no agent needs attention', async () => {
    const { terminal, app } = start();
    await attached(terminal);
    const before = app.tabs();
    terminal.type(F11);
    await waitForTabBar(terminal, 2, 'No agent needs attention.');
    expect(app.tabs()).toEqual(before);
  });
});

describe('runApp pane mouse (fake tmux clients)', () => {
  // The slot at 80x24 starts at frame cell (34, 3).
  const SX = 34;
  const SY = 4;

  it('forwards clicks, drags and the wheel pane-relative to an app with SGR any-motion mouse, motion coalesced per frame', async () => {
    const { terminal, client } = start({ setup: (fake) => { fake.modes = SGR_ANY; } });
    await attached(terminal);
    terminal.type(sgr(0, SX + 6, SY + 7));
    terminal.type(sgr(32, SX + 7, SY + 7) + sgr(32, SX + 8, SY + 7) + sgr(32, SX + 9, SY + 8));
    expect(client().sent).toEqual([`%1 ${ESC}[<0;7;8M`]);
    await waitFor(() => client().sent.length === 2);
    expect(client().sent[1]).toBe(`%1 ${ESC}[<32;10;9M`);
    // A drag that leaves the slot stays with the pane, clamped to its edge; the release flushes waiting motion first.
    terminal.type(sgr(32, 2, SY + 8) + sgr(0, 2, SY + 8, true));
    expect(client().sent.slice(2)).toEqual([`%1 ${ESC}[<32;1;9M`, `%1 ${ESC}[<0;1;9m`]);
    terminal.type(sgr(65, SX, SY));
    expect(client().sent.at(-1)).toBe(`%1 ${ESC}[<65;1;1M`);
    // Plain motion over the pane: the app asked for all motion.
    terminal.type(sgr(35, SX + 1, SY + 1));
    await waitFor(() => client().sent.at(-1) === `%1 ${ESC}[<35;2;2M`);
    await sleep(30);
    expect(copied(terminal)).toEqual([]);
  });

  it('re-encodes for the app\'s encoding and leaves motion out when its mode does not want it', async () => {
    const { terminal, client } = start({ setup: (fake) => { fake.modes = { mouseAny: true, mouseStandard: true }; } });
    await attached(terminal);
    terminal.type(sgr(0, SX, SY) + sgr(32, SX + 1, SY) + sgr(0, SX + 1, SY, true));
    await sleep(40);
    expect(client().sent).toEqual([`%1 ${ESC}[M !!`, `%1 ${ESC}[M#"!`]);
  });

  it('scrolls the cockpit scrollback with the wheel when the app did not ask for the mouse, history from before the attach included; a key returns to live', async () => {
    const { terminal, client } = start({ setup: (fake) => { fake.lines = Array.from({ length: 30 }, (_, i) => `line ${i}`); } });
    await waitForSlotLine(terminal, 'line 29');
    expect((await slotRows(terminal))[0]).toBe('line 11');
    terminal.type(sgr(64, SX + 3, SY + 3));
    await waitForSlotLine(terminal, 'line 8');
    expect((await slotRows(terminal))[0]).toBe('line 8');
    terminal.type(sgr(64, SX + 3, SY + 3) + sgr(64, SX + 3, SY + 3) + sgr(64, SX + 3, SY + 3));
    await waitForSlotLine(terminal, 'line 0');
    terminal.type(sgr(65, SX + 3, SY + 3));
    await waitFor(async () => (await slotRows(terminal))[0] === 'line 3');
    expect(client().sent).toEqual([]);
    terminal.type('a');
    await waitFor(async () => (await slotRows(terminal))[0] === 'line 11');
    expect(client().sent).toEqual(['%1 a']);
  });

  it('selects text by drag with a highlight and copies exactly the selection with OSC 52 on release', async () => {
    const { terminal, client } = start({ setup: (fake) => { fake.lines = ['$ echo 日本語', 'second line']; } });
    await waitForSlotLine(terminal, '$ echo 日本語');
    // From "echo" to the right half of 語, then down to "second".
    terminal.type(sgr(0, SX + 2, SY) + sgr(32, SX + 12, SY));
    await waitFor(async () => (await shown(terminal)).cell(SX + 2, SY)?.style.inverse === true);
    expect((await shown(terminal)).cell(SX + 1, SY)?.style.inverse).toBe(false);
    terminal.type(sgr(32, SX + 5, SY + 1) + sgr(0, SX + 5, SY + 1, true));
    await waitFor(() => copied(terminal).length === 1);
    expect(copied(terminal)).toEqual(['echo 日本語\nsecond']);
    expect(client().sent).toEqual([]);
    // A click without a drag copies nothing and clears the highlight.
    terminal.type(sgr(0, SX + 2, SY) + sgr(0, SX + 2, SY, true));
    await waitFor(async () => (await shown(terminal)).cell(SX + 2, SY)?.style.inverse === false);
    expect(copied(terminal)).toHaveLength(1);
  });

  it('keeps a drag\'s selection through a watcher update and copies it on release', async () => {
    const { terminal, client, watcher } = start({ setup: (fake) => { fake.lines = ['$ echo hi']; } });
    await waitForSlotLine(terminal, '$ echo hi');
    terminal.type(sgr(0, SX + 2, SY) + sgr(32, SX + 5, SY));
    await waitFor(async () => (await shown(terminal)).cell(SX + 2, SY)?.style.inverse === true);
    watcher.emit({ type: 'status', project_id: 'demo', status: projectState('demo').status! });
    await sleep(30);
    expect((await shown(terminal)).cell(SX + 2, SY)?.style.inverse).toBe(true);
    terminal.type(sgr(0, SX + 5, SY, true));
    await waitFor(() => copied(terminal).length === 1);
    expect(copied(terminal)).toEqual(['echo']);
    expect(client().sent).toEqual([]);
  });

  it('keeps the pending motion to a mouse app through a watcher update', async () => {
    const { terminal, client, watcher } = start({ setup: (fake) => { fake.modes = SGR_ANY; } });
    await attached(terminal);
    terminal.type(sgr(0, SX + 6, SY + 7) + sgr(32, SX + 7, SY + 7));
    watcher.emit({ type: 'status', project_id: 'demo', status: projectState('demo').status! });
    await waitFor(() => client().sent.length === 2);
    expect(client().sent[1]).toBe(`%1 ${ESC}[<32;8;8M`);
  });

  it('gives Shift-held events to the cockpit even when the app wants the mouse', async () => {
    const { terminal, client } = start({ setup: (fake) => { fake.modes = SGR_ANY; } });
    await attached(terminal);
    terminal.type(sgr(4, SX, SY) + sgr(36, SX + 6, SY) + sgr(4, SX + 6, SY, true));
    await waitFor(() => copied(terminal).length === 1);
    expect(copied(terminal)).toEqual(['$ hello']);
    terminal.type(sgr(68, SX, SY));
    await sleep(40);
    expect(client().sent).toEqual([]);
  });

  it('forwards no mouse event from a view-mode worker tab, and forwards once it types', async () => {
    const { terminal, clients, app } = start({
      projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] })],
      setup: (fake) => { fake.modes = SGR_ANY; },
    });
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    const worker = clients[1];
    terminal.type(sgr(0, SX + 1, SY) + sgr(32, SX + 2, SY) + sgr(0, SX + 2, SY, true) + sgr(64, SX, SY) + sgr(35, SX, SY));
    await sleep(40);
    expect(worker.sent).toEqual([]);
    terminal.type('i');
    await waitForSidebar(terminal, '[typing]');
    terminal.type(sgr(0, SX + 1, SY));
    expect(worker.sent).toEqual([`%2 ${ESC}[<0;2;1M`]);
  });
});
