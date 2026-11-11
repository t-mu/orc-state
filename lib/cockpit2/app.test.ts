import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { tmuxSessionTarget } from '../../client.ts';
import { DEFAULT_COCKPIT_KEYS, type CockpitKeys } from '../cockpitKeys.ts';
import {
  SIDEBAR_COLS, TAB_BAR_ROWS, computeLayout, dispatchMouse, hitTest, masterTarget, quitHint, resolveMasterTarget, runApp,
  type App, type MasterTarget, type PaneClient,
} from './app.ts';
import type { MouseEvent } from './mouse.ts';
import { createScreen, type Screen } from './screen.ts';
import type { TerminalSession } from './terminal.ts';
import type { PaneModes } from './tmuxControl.ts';

const ESC = '\x1b';
const F12 = `${ESC}[24~`;

async function waitFor(check: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── layout ────────────────────────────────────────────────────────────────────

describe('computeLayout', () => {
  it('lays out 80x24: a 34-column sidebar, a 3-row tab bar over the slot', () => {
    expect(computeLayout(80, 24)).toEqual({
      cols: 80, rows: 24,
      sidebar: { x: 0, y: 0, cols: SIDEBAR_COLS, rows: 24 },
      tabBar: { x: 34, y: 0, cols: 46, rows: TAB_BAR_ROWS },
      slot: { x: 34, y: 3, cols: 46, rows: 21 },
    });
  });

  it('keeps the sidebar width and tab bar height at 200x60', () => {
    const layout = computeLayout(200, 60);
    expect(layout.sidebar).toEqual({ x: 0, y: 0, cols: 34, rows: 60 });
    expect(layout.tabBar).toEqual({ x: 34, y: 0, cols: 166, rows: 3 });
    expect(layout.slot).toEqual({ x: 34, y: 3, cols: 166, rows: 57 });
  });

  it('shrinks the sidebar and tab bar before the slot on a tiny terminal', () => {
    const layout = computeLayout(30, 4);
    expect(layout.sidebar.cols).toBe(10);
    expect(layout.tabBar.rows).toBe(1);
    expect(layout.slot).toEqual({ x: 10, y: 1, cols: 20, rows: 3 });
  });
});

describe('hitTest and dispatchMouse', () => {
  const layout = computeLayout(80, 24);
  const click = (x: number, y: number): MouseEvent => ({ button: 'left', shift: false, alt: false, ctrl: false, motion: false, release: false, x, y });

  it('finds the region under a cell and the cell relative to it', () => {
    expect(hitTest(layout, 0, 0)).toEqual({ region: 'sidebar', x: 0, y: 0 });
    expect(hitTest(layout, 33, 23)).toEqual({ region: 'sidebar', x: 33, y: 23 });
    expect(hitTest(layout, 34, 0)).toEqual({ region: 'tabBar', x: 0, y: 0 });
    expect(hitTest(layout, 79, 2)).toEqual({ region: 'tabBar', x: 45, y: 2 });
    expect(hitTest(layout, 34, 3)).toEqual({ region: 'slot', x: 0, y: 0 });
    expect(hitTest(layout, 79, 23)).toEqual({ region: 'slot', x: 45, y: 20 });
    expect(hitTest(layout, 80, 0)).toBeNull();
    expect(hitTest(layout, 0, 24)).toBeNull();
  });

  it('hands an event to its region\'s handler with region-relative coordinates', () => {
    const seen: Array<[string, number, number]> = [];
    const handlers = { slot: (_: MouseEvent, at: { x: number; y: number }) => seen.push(['slot', at.x, at.y]) };
    expect(dispatchMouse(layout, click(40, 5), handlers)).toBe('slot');
    expect(dispatchMouse(layout, click(1, 1), handlers)).toBe('sidebar'); // no handler yet: nothing happens
    expect(dispatchMouse(layout, click(90, 1), handlers)).toBeNull();
    expect(seen).toEqual([['slot', 6, 2]]);
  });
});

// ── master target ─────────────────────────────────────────────────────────────

describe('masterTarget', () => {
  const stateDir = '/data/projects/p1';

  it('uses the status view\'s recorded target', () => {
    const status = { master: { agent_id: 'master', tmux_socket: 'orc-abc', tmux_session: 'orc-master-1' } } as never;
    expect(masterTarget(stateDir, status)).toEqual({ socket: 'orc-abc', session: 'orc-master-1' });
  });

  it('computes it from the state directory without a coordinator, or for a master with no recorded target', async () => {
    expect(masterTarget(stateDir, null)).toEqual(tmuxSessionTarget(stateDir, 'master'));
    const custom = { master: { agent_id: 'boss', tmux_socket: null, tmux_session: null } } as never;
    expect(masterTarget(stateDir, custom)).toEqual(tmuxSessionTarget(stateDir, 'boss'));
    await expect(resolveMasterTarget(stateDir, () => Promise.reject(new Error('no coordinator'))))
      .resolves.toEqual(tmuxSessionTarget(stateDir, 'master'));
  });
});

describe('quitHint', () => {
  it('names the quit key and the prefix then d, spelled out', () => {
    expect(quitHint(DEFAULT_COCKPIT_KEYS)).toBe('Ctrl-q: quit · F12 d: quit');
    expect(quitHint({ ...DEFAULT_COCKPIT_KEYS, prefix: 'C-a', quit: null })).toBe('Ctrl-a d: quit');
  });
});

// ── the app with a fake tmux client ──────────────────────────────────────────

const MODES: PaneModes = {
  paneId: '%1', cols: 46, rows: 21, cursorX: 2, cursorY: 0, alternateOn: false, mouseAny: false, mouseButton: false,
  mouseStandard: false, mouseSgr: false, mouseUtf8: false, keypadCursor: false, cursorVisible: true,
};

class FakeClient extends EventEmitter {
  resizes: string[] = [];
  sent: string[] = [];
  pastes: string[] = [];
  closed = 0;
  modeQueries = 0;
  lines = ['$ hello'];
  /** Set to hold the next capture until the test releases it. */
  gate: Promise<void> | null = null;
  size = { cols: MODES.cols, rows: MODES.rows };
  resize(cols: number, rows: number) { this.resizes.push(`${cols}x${rows}`); this.size = { cols, rows }; return Promise.resolve(); }
  paneModes() { this.modeQueries++; return Promise.resolve({ ...MODES, ...this.size }); }
  async capture() { if (this.gate) await this.gate; return this.lines; }
  sendBytes(pane: string, bytes: Buffer) { this.sent.push(`${pane} ${bytes.toString('latin1')}`); return Promise.resolve(); }
  paste(pane: string, text: string) { this.pastes.push(`${pane} ${text}`); return Promise.resolve(); }
  close() { this.closed++; }
}

class FakeTerminal implements TerminalSession {
  cols = 80;
  rows = 24;
  writes: string[] = [];
  restored = 0;
  private input = new Set<(chunk: Buffer) => void>();
  private resizes = new Set<() => void>();
  size() { return { cols: this.cols, rows: this.rows }; }
  write(data: string) { this.writes.push(data); }
  onInput(listener: (chunk: Buffer) => void) { this.input.add(listener); return () => this.input.delete(listener); }
  onResize(listener: () => void) { this.resizes.add(listener); return () => this.resizes.delete(listener); }
  restore() { this.restored++; }
  type(text: string) { for (const listener of this.input) listener(Buffer.from(text, 'latin1')); }
  resizeTo(cols: number, rows: number) { this.cols = cols; this.rows = rows; for (const listener of this.resizes) listener(); }
}

/** The real terminal as a user would see it: every write replayed into an emulator. */
async function shown(terminal: FakeTerminal): Promise<Screen> {
  const screen = createScreen({ cols: terminal.cols, rows: terminal.rows, scrollback: 0 });
  await screen.write(terminal.writes.join(''));
  return screen;
}
const text = (screen: Screen, y: number, x = 0, cols = screen.cols) =>
  screen.row(y).slice(x, x + cols).map((cell) => cell.text).join('').trimEnd();
/** The slot's rows as the real terminal shows them. */
async function slotRows(terminal: FakeTerminal): Promise<string[]> {
  const screen = await shown(terminal);
  const { slot } = computeLayout(terminal.cols, terminal.rows);
  return Array.from({ length: slot.rows }, (_, y) => text(screen, slot.y + y, slot.x, slot.cols));
}
/** Waits until a slot row is `line` on the real terminal (the renderer writes only changed cells, so the bytes alone do not say). */
async function waitForSlotLine(terminal: FakeTerminal, line: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await slotRows(terminal)).includes(line)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(line)} in the slot:\n${(await slotRows(terminal)).join("\n")}`);
    await sleep(25);
  }
}

const apps: App[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.quit(); });

function start(keys: CockpitKeys = DEFAULT_COCKPIT_KEYS) {
  const terminal = new FakeTerminal();
  const client = new FakeClient();
  const targets: MasterTarget[] = [];
  const app = runApp({
    terminal, keys, tmuxBinary: 'tmux', dataHome: '/data', lockPath: '/data/cockpit/cockpit2.lock',
    projectName: 'demo-project', target: { socket: 'orc-sock', session: 'orc-master' },
    connect: (target) => { targets.push(target); return client as unknown as PaneClient; },
    resyncDelayMs: 5,
  });
  apps.push(app);
  return { terminal, client, app, targets };
}

/** Waits until the master's capture is on the real terminal. */
async function attached(terminal: FakeTerminal): Promise<void> {
  await waitFor(() => terminal.writes.join('').includes('hello'));
}

describe('runApp (fake tmux client)', () => {
  it('shows the master in the slot next to the placeholder sidebar and tab bar, its window sized to the slot', async () => {
    const { terminal, client, targets } = start();
    await attached(terminal);
    expect(targets).toEqual([{ socket: 'orc-sock', session: 'orc-master' }]);
    expect(client.resizes).toEqual(['46x21']);
    const screen = await shown(terminal);
    expect(text(screen, 3, 34)).toBe('$ hello');
    expect(text(screen, 0, 0, 34)).toContain('demo-project');
    expect(text(screen, 1, 34)).toContain('master');
    expect(text(screen, 1, 34)).toContain('Ctrl-q: quit · F12 d: quit');
    // The cursor is where the pane has it, in frame coordinates.
    expect(screen.cursor()).toEqual({ x: 36, y: 3, visible: true });
  });

  it('writes nothing while idle and coalesces a burst of output into few frames', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    await sleep(30);
    const settled = terminal.writes.length;
    await sleep(150);
    expect(terminal.writes.length).toBe(settled);
    for (let i = 0; i < 50; i++) client.emit('output', '%1', Buffer.from(`x${i} `));
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
    client.emit('output', '%9', Buffer.from('elsewhere'));
    await sleep(60);
    expect(terminal.writes.length).toBe(settled);
  });

  it('drops output the capture already shows and keeps what arrives after it', async () => {
    const { terminal, client } = start();
    let release!: () => void;
    client.gate = new Promise((resolve) => { release = resolve; });
    await waitFor(() => client.modeQueries === 1);
    await sleep(5);
    client.emit('output', '%1', Buffer.from('BEFORE')); // in the capture already
    release();
    client.gate = null;
    await attached(terminal);
    client.emit('output', '%1', Buffer.from('AFTER'));
    await waitFor(() => terminal.writes.join('').includes('AFTER'));
    expect(terminal.writes.join('')).not.toContain('BEFORE');
  });

  it('forwards typed bytes to the master pane and pastes through paste()', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    terminal.type('ls -l\r');
    terminal.type(`${ESC}[A`);
    terminal.type(`${ESC}[200~one\ntwo${ESC}[201~`);
    expect(client.sent).toEqual(['%1 l', '%1 s', '%1  ', '%1 -', '%1 l', '%1 \r', `%1 ${ESC}[A`]);
    expect(client.pastes).toEqual(['%1 one\ntwo']);
  });

  it('quits on Ctrl-q: the terminal is restored and the control client closed, nothing sent to the master', async () => {
    const { terminal, client, app } = start();
    await attached(terminal);
    terminal.type('\x11');
    await app.done;
    expect(terminal.restored).toBe(1);
    expect(client.closed).toBe(1);
    expect(client.sent).toEqual([]);
    const writes = terminal.writes.length;
    client.emit('output', '%1', Buffer.from('more'));
    await sleep(40);
    expect(terminal.writes.length).toBe(writes);
  });

  it('quits on the prefix then d; the prefix twice reaches the pane', async () => {
    const { terminal, client, app } = start();
    await attached(terminal);
    terminal.type(`${F12}${F12}`);
    terminal.type(`${F12}x`); // not in this step's prefix table: dropped
    expect(client.sent).toEqual([`%1 ${F12}`]);
    terminal.type(`${F12}d`);
    await app.done;
    expect(client.closed).toBe(1);
  });

  it('takes the quit key from the keys setting', async () => {
    const { terminal, client, app } = start({ ...DEFAULT_COCKPIT_KEYS, prefix: 'C-a', quit: 'C-x' });
    await attached(terminal);
    terminal.type('\x11');
    expect(client.sent).toEqual(['%1 \x11']);
    terminal.type('\x18');
    await app.done;
    expect(terminal.restored).toBe(1);
  });

  it('re-lays out on resize: the window follows the slot and the frame is redrawn at the new size', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    terminal.resizeTo(200, 60);
    await waitFor(() => client.resizes.includes('166x57'));
    client.lines = ['$ resized'];
    client.emit('notification', '%layout-change @1 abcd,166x57,0,0,1 abcd,166x57,0,0,1 *');
    await waitFor(() => terminal.writes.join('').includes('resized'));
    const screen = await shown(terminal);
    expect(text(screen, 3, 34)).toBe('$ resized');
    expect(text(screen, 1, 34)).toContain('Ctrl-q: quit');
  });

  it('says so when the master\'s session ends and stops typing into it', async () => {
    const { terminal, client } = start();
    await attached(terminal);
    client.emit('exit', 'session closed');
    await waitFor(() => terminal.writes.join('').includes('not running'));
    terminal.type('x');
    expect(client.sent).toEqual([]);
  });
});

// ── the app against a private tmux server ────────────────────────────────────

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasTmux)('runApp (private tmux server)', () => {
  const socket = `orc-cockpit2-app-test-${process.pid}-${Date.now()}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  afterAll(() => { tmux('kill-server'); });

  it('shows the master\'s shell, types into it, follows a resize and leaves the session running on quit', async () => {
    const session = 'orc-master-fake';
    const created = tmux('new-session', '-d', '-s', session, '-x', '100', '-y', '30',
      'env -i TERM=tmux-256color PS1="$ " LANG=C.UTF-8 sh');
    expect(created.status, created.stderr).toBe(0);
    const terminal = new FakeTerminal();
    const app = runApp({
      terminal, keys: DEFAULT_COCKPIT_KEYS, tmuxBinary: 'tmux', dataHome: '/unused', lockPath: '/unused/lock',
      projectName: 'fake', target: { socket, session },
    });
    apps.push(app);
    const windowSize = () => tmux('display-message', '-p', '-t', `=${session}:`, '#{window_width}x#{window_height}').stdout.trim();
    await waitFor(() => windowSize() === '46x21');

    // Typed bytes arrive and the output appears in the slot.
    await waitForSlotLine(terminal, '$');
    terminal.type('echo cockpit-$((6*7))\r');
    await waitForSlotLine(terminal, 'cockpit-42');

    // A resize re-lays out: the window follows the slot and the shell sees the new size.
    terminal.resizeTo(120, 40);
    await waitFor(() => windowSize() === '86x37');
    // tmux applies the pane's new tty size a moment after the window's: ask again until the shell sees it.
    await waitFor(() => tmux('display-message', '-p', '-t', `=${session}:`, '#{pane_width}x#{pane_height}').stdout.trim() === '86x37');
    for (let attempt = 0; ; attempt++) {
      terminal.type('clear; stty size\r');
      try { await waitForSlotLine(terminal, '37 86', 1_000); break; } catch (error) { if (attempt === 4) throw error; }
    }
    expect((await shown(terminal)).row(0).length).toBe(120);

    terminal.type('\x11');
    await app.done;
    expect(terminal.restored).toBe(1);
    expect(tmux('has-session', '-t', `=${session}`).status).toBe(0);
  }, 20_000);
});
