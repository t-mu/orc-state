import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { tmuxSessionTarget, type ProjectWatchState, type ProjectWatchUpdate } from '../../client.ts';
import { MASTER_TAB, closeTab, openAgent, selectTab, showProject } from '../cockpitTabs.ts';
import { DEFAULT_COCKPIT_KEYS, type CockpitKeys } from '../cockpitKeys.ts';
import {
  SIDEBAR_COLS, TAB_BAR_ROWS, agentTarget, computeLayout, dispatchMouse, hitTest, masterTarget, quitHint, runApp, shortQuitHint, slotMessage,
  type App,
} from './app.ts';
import type { MouseEvent } from './mouse.ts';
import { EDGE_COLUMN, EDGE_ROW } from './frame.ts';
import { createScreen, type Screen } from './screen.ts';
import type { PaneClient } from './sessions.ts';
import type { TerminalSession } from './terminal.ts';
import type { PaneReport } from './tmuxControl.ts';
import { DEFAULT_VIEW_STATE, type TmuxTarget, type ViewState, type ViewStateStore } from './viewState.ts';

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

class FakeWatcher {
  private listeners = new Set<(update: ProjectWatchUpdate) => void>();
  constructor(public states: ProjectWatchState[]) {}
  projects() { return this.states; }
  onUpdate(listener: (update: ProjectWatchUpdate) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(update: ProjectWatchUpdate) { for (const listener of this.listeners) listener(update); }
}

class MemoryStore implements ViewStateStore {
  /** Set to make the next updates fail. */
  failWith: Error | null = null;
  constructor(public state: ViewState = DEFAULT_VIEW_STATE) {}
  load() { return this.state; }
  update(change: (stored: ViewState) => ViewState) {
    if (this.failWith) return Promise.reject(this.failWith);
    this.state = structuredClone(change(this.state));
    return Promise.resolve(this.state);
  }
}

const MASTER_TARGET = { socket: 'orc-sock', session: 'orc-master' };
const W1_TARGET = { socket: 'orc-sock', session: 'orc-w1' };

type FakeWorker = { agent_id: string; attention?: { kind: 'question' | 'permission_prompt' | 'stalled' | 'no_progress'; detail: string | null } } & TmuxTarget;

function projectState(id: string, options: { running?: boolean; master?: TmuxTarget | null; workers?: FakeWorker[]; name?: string } = {}): ProjectWatchState {
  const { running = true, master = MASTER_TARGET, workers = [] } = options;
  return {
    project: { id, name: options.name ?? `${id}-project`, target_repo_root: `/repo/${id}`, state_dir: `/state/${id}`, repo_present: true, control_socket: null, coordinator_running: running },
    connection: running ? 'running' : 'stopped',
    error: null,
    status: {
      master: { agent_id: 'master', tmux_socket: master?.socket ?? null, tmux_session: master?.session ?? null },
      worker_capacity: {
        configured_slots: 2, used_slots: workers.length,
        slots: workers.map((worker) => ({
          ...worker, role: 'worker', status: 'running', slot_state: 'busy', attention: worker.attention ?? null,
          tmux_socket: worker.socket, tmux_session: worker.session, session_handle: `tmux:${worker.socket}:${worker.session}`,
        })),
      },
      claims: { active: [] },
      scouts: [],
    } as never,
    cursor: null,
  };
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

/** Waits until row `y` of the tab bar contains `part`. */
async function waitForTabBar(terminal: FakeTerminal, y: number, part: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (!text(await shown(terminal), y, SIDEBAR_COLS).includes(part)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(part)} in tab bar row ${y}: ${text(await shown(terminal), y, SIDEBAR_COLS)}`);
    await sleep(25);
  }
}

/** The sidebar's rows as the real terminal shows them. */
async function sidebarRows(terminal: FakeTerminal): Promise<string[]> {
  const screen = await shown(terminal);
  return Array.from({ length: terminal.rows }, (_, y) => text(screen, y, 0, SIDEBAR_COLS));
}

/** Waits until some sidebar row contains `part`. */
async function waitForSidebar(terminal: FakeTerminal, part: string): Promise<void> {
  const until = Date.now() + 2_000;
  while (!(await sidebarRows(terminal)).some((row) => row.includes(part))) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(part)} in the sidebar:\n${(await sidebarRows(terminal)).join('\n')}`);
    await sleep(25);
  }
}

/** Waits until some slot row contains `part` (messages are drawn indented). */
async function waitForSlotText(terminal: FakeTerminal, part: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (!(await slotRows(terminal)).some((row) => row.includes(part))) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${JSON.stringify(part)} in the slot:\n${(await slotRows(terminal)).join('\n')}`);
    await sleep(25);
  }
}

const apps: App[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.quit(); });

interface StartOptions { keys?: CockpitKeys; projects?: ProjectWatchState[]; store?: MemoryStore; projectId?: string }

function start({ keys = DEFAULT_COCKPIT_KEYS, projects = [projectState('demo')], store = new MemoryStore(), projectId = 'demo' }: StartOptions = {}) {
  const terminal = new FakeTerminal();
  const watcher = new FakeWatcher(projects);
  const clients: FakeClient[] = [];
  const app = runApp({
    terminal, keys, tmuxBinary: 'tmux', lockPath: '/data/cockpit/cockpit2.lock', store, projects: watcher, projectId,
    connect: (target, { ignoreSize }) => {
      const fake = new FakeClient(target, ignoreSize, `%${clients.length + 1}`);
      fake.lines = [`$ hello from ${target.session}`];
      clients.push(fake);
      return fake as unknown as PaneClient;
    },
    resyncDelayMs: 5,
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
  it('shows the master in the slot next to the sidebar and tab bar, its window sized to the slot', async () => {
    const { terminal, clients } = start();
    await attached(terminal);
    expect(clients.map((fake) => [fake.target, fake.ignoreSize])).toEqual([[MASTER_TARGET, false]]);
    expect(clients[0].resizes).toEqual(['46x21']);
    const screen = await shown(terminal);
    expect(text(screen, 3, 34)).toBe('$ hello from orc-master');
    expect((await sidebarRows(terminal)).some((row) => row.includes('▸ demo-project'))).toBe(true);
    expect(text(screen, 1, 34)).toContain('master');
    expect(text(screen, 1, 34).endsWith('Ctrl-q: quit')).toBe(true);
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
    await app.done;
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
    await waitFor(() => client().resizes.includes('166x57'));
    client().lines = ['$ resized'];
    client().emit('resize', 166, 57);
    await waitForSlotLine(terminal, '$ resized');
    const screen = await shown(terminal);
    expect(text(screen, 3, 34)).toBe('$ resized');
    expect(text(screen, 1, 34)).toContain('Ctrl-q: quit');
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
    expect(text(screen, 3, 34)).toBe('$ hello from orc-master');
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
    expect(text(await shown(terminal), 1, 34)).toContain('w1');

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

  it('reopens a closed worker tab view-only again, and keeps each open tab\'s mode across tab switches', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type('i');
    terminal.type(`${F12}1`); // the master tab through the prefix table
    await waitForSlotLine(terminal, '$ hello from orc-master');
    terminal.type(`${F12}2`);
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type('a');
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
    expect(rows[0].endsWith('╮')).toBe(true);
    // Every box row ends on the sidebar's right border, wide names or not.
    const screen = await shown(terminal);
    for (let y = 0; y < 14; y++) expect(screen.row(y)[SIDEBAR_COLS - 1].text).toMatch(/[╮│╯]/);
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
    const masterX = (await columnOf(terminal, 1, 'm', SIDEBAR_COLS));
    terminal.type(click(masterX, 1, true));
    terminal.type(`${ESC}[<32;${masterX + 1};2M${ESC}[<2;${masterX + 1};2M`);
    expect(app.tabs().projects[0].active).toBe(WIDE_AGENT);
    terminal.type(click(masterX, 1));
    expect(app.tabs().projects[0].active).toBe(null);
    await waitForSlotText(terminal, '$ hello from orc-master');

    // The close marker of the wide-named tab, found by its column on the real terminal.
    const firstClose = await columnOf(terminal, 1, '×', SIDEBAR_COLS);
    const wideClose = await columnOf(terminal, 1, '×', firstClose + 1);
    terminal.type(click(wideClose, 1));
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: null });
    const wideClient = clients.find((fake) => fake.target.session === 'orc-wide')!;
    expect(wideClient.closed).toBe(1);
    expect(wideClient.sent).toEqual([]);
    expect(wideClient.pastes).toEqual([]);
    for (let until = Date.now() + 2_000; text(await shown(terminal), 1, SIDEBAR_COLS).includes(WIDE_AGENT); await sleep(25)) {
      if (Date.now() > until) throw new Error('the closed tab is still drawn');
    }
    // A click on the master tab's text never closes it.
    terminal.type(click(masterX + 7, 1));
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

  it('navigates the sidebar by keyboard: F10 focuses it, arrows move, Enter opens, Tab switches box, Esc returns to the pane', async () => {
    const { terminal, clients, app } = withWorkers();
    await attached(terminal);
    const master = clients[0];
    terminal.type(F10);
    await waitForSidebar(terminal, '↑↓ Tab · Enter: open · Esc: pane');
    // The cursor starts on the first agent (the one needing attention); down moves to w1, Enter opens it.
    terminal.type(`${ESC}[B\r`);
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: 'w1' });
    // The keys stay with the sidebar: nothing reaches a pane, not even a paste.
    terminal.type(`xi${ESC}[200~p${ESC}[201~`);
    await sleep(30);
    expect(master.sent).toEqual([]);
    expect(clients.every((fake) => fake.sent.length === 0 && fake.pastes.length === 0)).toBe(true);
    // k moves up again, Enter opens the wide-named agent.
    terminal.type('k\r');
    expect(app.tabs().projects[0].active).toBe(WIDE_AGENT);

    // Tab to the projects box: down and Enter switch project.
    terminal.type('\tj\r');
    expect(app.tabs().activeProject).toBe('other');
    await waitForSidebar(terminal, '▸ 日本語');
    terminal.type(`${ESC}[Z`); // Shift-Tab back to the agents box
    terminal.type(ESC);
    // Esc goes to the pane after the lone-Esc timeout: then keys reach the master again.
    await waitForSidebar(terminal, '[master] keys go to the master');
    await attached(terminal, 'orc-master-other');
    const other = clients.find((fake) => fake.target.session === 'orc-master-other')!;
    terminal.type('y');
    expect(other.sent).toEqual(['%' + other.paneId.slice(1) + ' y']);
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
    for (let until = Date.now() + 2_000; text(await shown(terminal), 2, SIDEBAR_COLS).includes('stays open'); await sleep(25)) {
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
        if (screen.row(0)[SIDEBAR_COLS - 1].text === '╮' && footer.includes('[master]') && text(screen, 2, SIDEBAR_COLS).startsWith('╯')) break;
        if (Date.now() > until) throw new Error(`layout not redrawn at ${cols}x${rows}`);
      }
      const { slot } = computeLayout(cols, rows);
      expect(slot).toEqual({ x: SIDEBAR_COLS, y: TAB_BAR_ROWS, cols: cols - SIDEBAR_COLS, rows: rows - TAB_BAR_ROWS });
    }
  });
});

// ── the app against a private tmux server ────────────────────────────────────

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasTmux)('runApp (private tmux server)', () => {
  const socket = `orc-cockpit2-app-test-${process.pid}-${Date.now()}`;
  const tmux = (...args: string[]) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  afterAll(() => { tmux('kill-server'); });
  const windowSize = (session: string) => tmux('display-message', '-p', '-t', `=${session}:`, '#{window_width}x#{window_height}').stdout.trim();

  function startReal(projects: ProjectWatchState[]) {
    const terminal = new FakeTerminal();
    const app = runApp({
      terminal, keys: DEFAULT_COCKPIT_KEYS, tmuxBinary: 'tmux', lockPath: '/unused/lock', store: new MemoryStore(),
      projects: new FakeWatcher(projects), projectId: 'fake',
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
    await waitFor(() => windowSize(session) === '46x21');

    // Typed bytes arrive and the output appears in the slot.
    await waitForSlotLine(terminal, '$');
    terminal.type('echo cockpit-$((6*7))\r');
    await waitForSlotLine(terminal, 'cockpit-42');

    // A resize re-lays out: the window follows the slot and the shell sees the new size.
    terminal.resizeTo(120, 40);
    await waitFor(() => windowSize(session) === '86x37');
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
    await waitFor(() => windowSize(master) === '46x21');
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
    const captured = tmux('capture-pane', '-p', '-t', `=${master}:`).stdout.split('\n').slice(0, 21).map((line) => line.trimEnd());
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
});
