import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { tmuxSessionTarget, type ProjectWatchState } from '../../client.ts';
import { MASTER_TAB, closeTab, openAgent, selectTab, showProject } from '../cockpitTabs.ts';
import { DEFAULT_COCKPIT_KEYS, resolveCockpitKeys, type CockpitKeys } from '../cockpitKeys.ts';
import {
  FOOTER_ROWS, GUTTER_COLS, HEADER_ROWS, SIDEBAR_COLS, TAB_BAR_ROWS, agentTarget, computeLayout, dispatchMouse, footerHints, hitTest, masterTarget, quitHint, runApp, slotMessage,
  type AgentActionHost,
} from './app.ts';
import type { ColorDepth } from './color.ts';
import { BUILT_IN_THEMES, resolveTheme, type Theme } from './theme.ts';
import type { ExplorerHost } from './explorer.ts';
import type { SettingValue, SettingsHost } from './settingsDialog.ts';
import type { ProjectHost } from './addProjectDialog.ts';
import type { AgentDefinition } from './newAgentDialog.ts';
import type { MouseEvent } from './mouse.ts';
import { EDGE_COLUMN, EDGE_ROW } from './frame.ts';
import type { PaneClient } from './sessions.ts';
import type { PaneReport } from './tmuxControl.ts';
import { DEFAULT_VIEW_STATE, addProject, type TmuxTarget } from './viewState.ts';
import {
  ESC, FakeTerminal, LEADER, FakeWatcher, MASTER_TARGET, MemoryStore, W1_TARGET, apps, projectState, shown, sidebarRows, sleep, slotRows, text,
  waitFor, waitForFooter, waitForSidebar, waitForSlotLine, waitForSlotText, waitForTabBar,
} from '../../test-fixtures/cockpitAppFakes.ts';

// ── layout ────────────────────────────────────────────────────────────────────

describe('computeLayout', () => {
  it('lays out 80x24: a header row, a 34-column sidebar, a one-column gutter, a four-row tab bar over a boxed 43x16 slot, a footer row', () => {
    expect(computeLayout(80, 24)).toEqual({
      cols: 80, rows: 24,
      header: { x: 0, y: 0, cols: 80, rows: HEADER_ROWS },
      sidebar: { x: 0, y: 1, cols: SIDEBAR_COLS, rows: 22 },
      gutter: { x: 34, y: 1, cols: 1, rows: 22 },
      tabBar: { x: 35, y: 1, cols: 45, rows: TAB_BAR_ROWS },
      slot: { x: 36, y: 6, cols: 43, rows: 16 },
      paneFrame: { x: 35, y: 5, cols: 45, rows: 18 },
      footer: { x: 0, y: 23, cols: 80, rows: FOOTER_ROWS },
    });
  });

  it('keeps the sidebar width, the tab bar height and both full-width rows at 200x60 and 120x40', () => {
    const layout = computeLayout(200, 60);
    expect(layout.header).toEqual({ x: 0, y: 0, cols: 200, rows: 1 });
    expect(layout.sidebar).toEqual({ x: 0, y: 1, cols: 34, rows: 58 });
    expect(layout.gutter).toEqual({ x: 34, y: 1, cols: GUTTER_COLS, rows: 58 });
    expect(layout.tabBar).toEqual({ x: 36, y: 1, cols: 164, rows: 4 });
    expect(layout.slot).toEqual({ x: 37, y: 6, cols: 162, rows: 52 });
    expect(layout.paneFrame).toEqual({ x: 36, y: 5, cols: 164, rows: 54 });
    expect(layout.footer).toEqual({ x: 0, y: 59, cols: 200, rows: 1 });
    const mid = computeLayout(120, 40);
    expect(mid.slot).toEqual({ x: 37, y: 6, cols: 82, rows: 32 });
    expect(mid.paneFrame).toEqual({ x: 36, y: 5, cols: 84, rows: 34 });
    expect(mid.sidebar.rows).toBe(38);
    expect(mid.footer).toEqual({ x: 0, y: 39, cols: 120, rows: 1 });
  });

  it('puts a two-column gutter from 100 columns, one from 60, none below 60 or without a sidebar', () => {
    expect(computeLayout(120, 40).gutter).toEqual({ x: 34, y: 1, cols: 2, rows: 38 });
    expect(computeLayout(100, 40).gutter.cols).toBe(2);
    expect(computeLayout(99, 40).gutter.cols).toBe(1);
    expect(computeLayout(80, 24).gutter).toEqual({ x: 34, y: 1, cols: 1, rows: 22 });
    expect(computeLayout(60, 24).gutter.cols).toBe(1);
    const narrow = computeLayout(50, 24);
    expect(narrow.gutter.cols).toBe(0);
    expect(narrow.tabBar.x).toBe(narrow.sidebar.cols);
    expect(computeLayout(20, 3).gutter.cols).toBe(0); // no sidebar, no gutter
  });

  it('takes a custom sidebar width, shrinking it to leave the slot its minimum', () => {
    const wide = computeLayout(120, 40, 50);
    expect(wide.sidebar.cols).toBe(50);
    expect(wide.gutter).toEqual({ x: 50, y: 1, cols: 2, rows: 38 });
    expect(wide.tabBar.x).toBe(52);
    expect(wide.paneFrame).toEqual({ x: 52, y: 5, cols: 68, rows: 34 });
    expect(computeLayout(80, 24, 24).slot).toEqual({ x: 26, y: 6, cols: 53, rows: 16 });
    // 80 columns leave the sidebar at most 80 - 20 - 1.
    expect(computeLayout(80, 24, 60).sidebar.cols).toBe(59);
  });

  it('drops the footer, then the tabs\' extra rows, then the header, then the tab bar before the slot falls below 20x3', () => {
    // 30x9: room for everything.
    expect(computeLayout(30, 9)).toMatchObject({ header: { rows: 1 }, tabBar: { y: 1, rows: 4 }, footer: { y: 8, rows: 1 }, slot: { x: 10, y: 5, cols: 20, rows: 3 } });
    // 30x8: the footer goes first.
    expect(computeLayout(30, 8)).toMatchObject({ header: { rows: 1 }, tabBar: { y: 1, rows: 4 }, footer: { y: 8, rows: 0 }, slot: { x: 10, y: 5, cols: 20, rows: 3 } });
    // 30x7, 30x6: then the tabs' extra rows, one at a time; the header and its buttons stay.
    expect(computeLayout(30, 7)).toMatchObject({ header: { rows: 1 }, tabBar: { y: 1, rows: 3 }, footer: { rows: 0 }, slot: { x: 10, y: 4, cols: 20, rows: 3 } });
    expect(computeLayout(30, 6)).toMatchObject({ header: { rows: 1 }, tabBar: { y: 1, rows: 2 }, footer: { rows: 0 }, slot: { x: 10, y: 3, cols: 20, rows: 3 } });
    const five = computeLayout(30, 5);
    expect(five.header).toEqual({ x: 0, y: 0, cols: 30, rows: 1 });
    expect(five.footer).toEqual({ x: 0, y: 5, cols: 30, rows: 0 });
    expect(five.tabBar).toEqual({ x: 10, y: 1, cols: 20, rows: 1 });
    expect(five.slot).toEqual({ x: 10, y: 2, cols: 20, rows: 3 });
    expect(five.sidebar).toEqual({ x: 0, y: 1, cols: 10, rows: 4 });
    // 30x4: then the header; the tab bar stays above the slot.
    const four = computeLayout(30, 4);
    expect(four.sidebar.cols).toBe(10);
    expect(four.tabBar).toEqual({ x: 10, y: 0, cols: 20, rows: 1 });
    expect(four.slot).toEqual({ x: 10, y: 1, cols: 20, rows: 3 });
    expect(four.header.rows + four.footer.rows).toBe(0);
    // 30x3: then the tab bar; the slot keeps its minimum.
    const three = computeLayout(30, 3);
    expect(three.tabBar.rows).toBe(0);
    expect(three.slot).toEqual({ x: 10, y: 0, cols: 20, rows: 3 });
  });
  it('boxes the slot only with room for a 20x3 slot inside the box', () => {
    // 56x11: just enough on both axes.
    expect(computeLayout(56, 11)).toMatchObject({ paneFrame: { x: 34, y: 5, cols: 22, rows: 5 }, slot: { x: 35, y: 6, cols: 20, rows: 3 } });
    // One column short: no frame, the slot keeps the whole right side.
    expect(computeLayout(55, 11)).toMatchObject({ paneFrame: null, slot: { x: 34, y: 5, cols: 21, rows: 5 } });
    // One row short: no frame.
    expect(computeLayout(56, 10)).toMatchObject({ paneFrame: null, slot: { x: 34, y: 5, cols: 22, rows: 4 } });
    expect(computeLayout(80, 6).paneFrame).toBeNull();
    expect(computeLayout(30, 4).paneFrame).toBeNull();
    for (const [cols, rows] of [[20, 3], [30, 4], [40, 8], [55, 11], [56, 10], [56, 11], [57, 12], [80, 6], [80, 7], [80, 24]]) {
      const { slot } = computeLayout(cols, rows);
      expect(slot.cols, `${cols}x${rows}`).toBeGreaterThanOrEqual(20);
      expect(slot.rows, `${cols}x${rows}`).toBeGreaterThanOrEqual(3);
    }
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
    expect(hitTest(layout, 34, 1)).toEqual({ region: 'gutter', x: 0, y: 0 });
    expect(hitTest(layout, 34, 22)).toEqual({ region: 'gutter', x: 0, y: 21 });
    expect(hitTest(layout, 35, 1)).toEqual({ region: 'tabBar', x: 0, y: 0 });
    expect(hitTest(layout, 79, 1)).toEqual({ region: 'tabBar', x: 44, y: 0 });
    expect(hitTest(layout, 79, 4)).toEqual({ region: 'tabBar', x: 44, y: 3 });
    expect(hitTest(layout, 36, 6)).toEqual({ region: 'slot', x: 0, y: 0 });
    expect(hitTest(layout, 78, 21)).toEqual({ region: 'slot', x: 42, y: 15 });
    // The pane frame's top and bottom rows and its sides belong to no region.
    expect(hitTest(layout, 50, 5)).toBeNull();
    expect(hitTest(layout, 35, 6)).toBeNull();
    expect(hitTest(layout, 79, 10)).toBeNull();
    expect(hitTest(layout, 50, 22)).toBeNull();
    expect(hitTest(layout, 0, 23)).toEqual({ region: 'footer', x: 0, y: 0 });
    expect(hitTest(layout, 79, 23)).toEqual({ region: 'footer', x: 79, y: 0 });
    expect(hitTest(layout, 80, 1)).toBeNull();
    expect(hitTest(layout, 0, 24)).toBeNull();
    // A dropped header or footer is never hit.
    expect(hitTest(computeLayout(30, 4), 0, 0)?.region).toBe('sidebar');
    expect(hitTest(computeLayout(30, 4), 15, 3)?.region).toBe('slot');
    // At 30x5 the header still takes clicks above the tab bar.
    expect(hitTest(computeLayout(30, 5), 25, 0)?.region).toBe('header');
    expect(hitTest(computeLayout(30, 5), 15, 1)?.region).toBe('tabBar');
  });

  it('hands an event to its region\'s handler with region-relative coordinates', () => {
    const seen: Array<[string, number, number]> = [];
    const handlers = { slot: (_: MouseEvent, at: { x: number; y: number }) => seen.push(['slot', at.x, at.y]) };
    expect(dispatchMouse(layout, click(40, 7), handlers)).toBe('slot');
    expect(dispatchMouse(layout, click(1, 2), handlers)).toBe('sidebar'); // no handler yet: nothing happens
    expect(dispatchMouse(layout, click(40, 0), handlers)).toBe('header'); // no handler here: nothing happens
    expect(dispatchMouse(layout, click(40, 23), handlers)).toBe('footer');
    expect(dispatchMouse(layout, click(90, 2), handlers)).toBeNull();
    expect(seen).toEqual([['slot', 4, 1]]);
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
      { key: 'Ctrl-Space q', action: 'quit' }, { key: 'F10', action: 'dashboard' }, { key: 'F11', action: 'attention' }, { key: 'Ctrl-Space ?', action: 'help' },
    ]);
    const { keys } = resolveCockpitKeys({ ORC_COCKPIT_PREFIX: 'C-a', ORC_COCKPIT_KEYS: 'quit=M-x,dashboard=C-F5,attention=none' });
    expect(footerHints(keys)).toEqual([
      { key: 'Alt-x', action: 'quit' }, { key: 'Ctrl-F5', action: 'dashboard' }, { key: 'Ctrl-a !', action: 'attention' }, { key: 'Ctrl-a ?', action: 'help' },
    ]);
    // Without direct keys: the leader then q, the leader then s.
    expect(footerHints({ ...keys, quit: null, direct: { ...keys.direct, dashboard: null } }).slice(0, 2))
      .toEqual([{ key: 'Ctrl-a q', action: 'quit' }, { key: 'Ctrl-a s', action: 'dashboard' }]);
  });
});

describe('quitHint', () => {
  it('names the quit key (when bound) and the leader then q, spelled out', () => {
    expect(quitHint(DEFAULT_COCKPIT_KEYS)).toBe('Ctrl-Space q: quit');
    expect(quitHint({ ...DEFAULT_COCKPIT_KEYS, prefix: 'C-a', quit: 'C-q' })).toBe('Ctrl-q: quit · Ctrl-a q: quit');
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
  settings?: SettingsHost;
  agents?: AgentActionHost;
  colorDepth?: ColorDepth;
  theme?: Theme;
  projectHost?: ProjectHost;
  agentDefinitions?: (repoRoot: string) => AgentDefinition[];
}

function start({ keys = DEFAULT_COCKPIT_KEYS, projects = [projectState('demo')], store = new MemoryStore(), projectId = 'demo', setup, explorer, settings, agents, colorDepth, theme, projectHost, agentDefinitions }: StartOptions = {}) {
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
    settings,
    agents,
    colorDepth,
    theme,
    projectHost,
    agentDefinitions,
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

  it('draws its chrome in orc by default and in the theme it is given', async () => {
    // orc and amber share the amber chrome; the focused pane's border tells them apart (orc's: the same amber, bold).
    const AMBER_BORDER = '38;2;255;176;0';
    const ORC_FOCUS = '1;38;2;255;176;0;48;2;22;22;22m┌';
    const AMBER_FOCUS = '38;2;255;194;51';
    const VIOLET = '38;2;124;58;237m';
    const orc = start();
    await attached(orc.terminal);
    expect(orc.terminal.writes.join('')).toContain(AMBER_BORDER);
    expect(orc.terminal.writes.join('')).toContain(ORC_FOCUS);
    expect(orc.terminal.writes.join('')).not.toContain(AMBER_FOCUS);
    expect(orc.terminal.writes.join('')).not.toContain('38;2;255;201;77');

    const amber = start({ theme: BUILT_IN_THEMES.amber });
    await attached(amber.terminal);
    expect(amber.terminal.writes.join('')).toContain(AMBER_BORDER);
    expect(amber.terminal.writes.join('')).toContain(AMBER_FOCUS);
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

  it('paints orc\'s panel inside the cards and the pane box, its canvas elsewhere, never the slot, and nothing with amber', async () => {
    const CANVAS = { type: 'rgb', r: 0x08, g: 0x08, b: 0x08 };
    const PANEL = { type: 'rgb', r: 0x16, g: 0x16, b: 0x16 };
    const orc = start({ theme: BUILT_IN_THEMES.orc });
    await attached(orc.terminal);
    const screen = await shown(orc.terminal);
    const { header, sidebar, gutter, tabBar, slot, paneFrame, footer } = computeLayout(orc.terminal.cols, orc.terminal.rows);
    const bg = (x: number, y: number) => screen.row(y)[x].style.bg;
    // The header, the footer's end, the gutter and the tab bar's gap row above the pane box: the floor.
    expect(bg(header.cols - 1, header.y)).toEqual(CANVAS);
    expect(bg(footer.cols - 1, footer.y)).toEqual(CANVAS);
    for (let y = gutter.y; y < gutter.y + gutter.rows; y += 1) expect(bg(gutter.x, y)).toEqual(CANVAS);
    expect(text(screen, tabBar.y + tabBar.rows - 1, tabBar.x).trim()).toBe('');
    expect(bg(tabBar.x + tabBar.cols - 1, tabBar.y + tabBar.rows - 1)).toEqual(CANVAS);
    // The tab strip above the gap row: raised, after the tabs.
    for (let y = tabBar.y; y < tabBar.y + tabBar.rows - 1; y += 1) {
      for (const x of [tabBar.x + tabBar.cols - 10, tabBar.x + tabBar.cols - 1]) expect(bg(x, y)).toEqual(PANEL);
    }
    // The sidebar: card rows (a border in the first column) on the panel, border and blank body alike; any row outside the cards on the canvas.
    let cardRows = 0;
    for (let y = sidebar.y; y < sidebar.y + sidebar.rows; y += 1) {
      const inCard = ['┌', '│', '└'].includes(screen.row(y)[sidebar.x].text);
      if (inCard) cardRows += 1;
      for (const x of [sidebar.x, sidebar.x + 1, sidebar.x + sidebar.cols - 2]) expect(bg(x, y)).toEqual(inCard ? PANEL : CANVAS);
    }
    expect(cardRows).toBeGreaterThan(0);
    // The pane box's border on the panel.
    expect(paneFrame).not.toBeNull();
    const frame = paneFrame!;
    for (const [x, y] of [[frame.x, frame.y], [frame.x + frame.cols - 1, frame.y + frame.rows - 1], [frame.x, slot.y], [frame.x + frame.cols - 1, slot.y]]) {
      expect(bg(x, y)).toEqual(PANEL);
    }
    // The slot keeps the pane's own cells: its text and the blank after it stay on the default background.
    for (const x of [slot.x, slot.x + slot.cols - 1]) expect(bg(x, slot.y)).toEqual({ type: 'default' });
    expect(bg(slot.x, slot.y + slot.rows - 1)).toEqual({ type: 'default' });

    const amber = start({ theme: BUILT_IN_THEMES.amber });
    await attached(amber.terminal);
    expect(amber.terminal.writes.join('')).not.toMatch(/48;2;(8;8;8|22;22;22)m/);
  });

  it('shows the master in the slot next to the sidebar and tab bar, its window sized to the slot', async () => {
    const { terminal, clients } = start();
    await attached(terminal);
    expect(clients.map((fake) => [fake.target, fake.ignoreSize])).toEqual([[MASTER_TARGET, false]]);
    expect(clients[0].resizes).toEqual(['43x16']);
    const screen = await shown(terminal);
    expect(text(screen, 6, 36, 43)).toBe('$ hello from orc-master');
    // The pane's box: around the slot, its top row (the master's header) under the tab bar, its bottom row above the footer.
    // At 45 columns the badge fits and the parts do not: whole parts only.
    expect(text(screen, 5, 35)).toBe(`┌─ [ MASTER ] ${'─'.repeat(6)} [COORDINATOR RUNNING] ─┐`);
    expect(screen.row(6)[35].text).toBe('│');
    expect(screen.row(6)[79].text).toBe('│');
    expect(text(screen, 22, 35)).toBe(`└${'─'.repeat(43)}┘`);
    expect((await sidebarRows(terminal)).some((row) => row.includes('[ DEMO-PROJECT ]'))).toBe(true);
    // The tabs: four rows, the labels on the second between half-block caps, then a blank row above the pane box.
    expect(text(screen, 2, 34)).toContain('master');
    expect(text(screen, 1, 34)).not.toContain('master');
    expect(text(screen, 4, 34).trim()).toBe('');
    expect(text(screen, 2, 34)).not.toContain('quit'); // the quit key is in the footer only
    // The cursor is where the pane has it, in frame coordinates.
    expect(screen.cursor()).toEqual({ x: 38, y: 6, visible: true });
    // The footer, full width on the last row: the mode, project › tab, the keys; the header: the mark and the project.
    expect(text(screen, 23)).toBe('[master] keys go to the master · demo-project › master · Ctrl-Space q: quit');
    expect(text(screen, 0)).toBe('ORC │ demo-project');
  });

  it('names the resolved keys in the footer', async () => {
    const { terminal } = start({ keys: resolveCockpitKeys({ ORC_COCKPIT_KEYS: 'quit=C-x,dashboard=M-d,attention=M-a' }).keys });
    await attached(terminal);
    terminal.resizeTo(140, 30);
    await waitFor(async () => text(await shown(terminal), 29).includes('Alt-a: attention'));
    expect(text(await shown(terminal), 29))
      .toBe('[master] keys go to the master · demo-project › master · Ctrl-x: quit · Alt-d: dashboard · Alt-a: attention · Ctrl-Space ?: help');
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

  it('quits on the leader then q: the terminal is restored and the control client closed, nothing sent to the master', async () => {
    const { terminal, client, app } = start();
    await attached(terminal);
    terminal.type(`${LEADER}q`);
    expect(await app.done).toBe('quit');
    expect(terminal.restored).toBe(1);
    expect(client().closed).toBe(1);
    expect(client().sent).toEqual([]);
    const writes = terminal.writes.length;
    client().emit('output', '%1', Buffer.from('more'));
    await sleep(40);
    expect(terminal.writes.length).toBe(writes);
  });

  it('sends Ctrl-q to the master (no quit key by default); the leader twice reaches the pane as NUL; an unbound key after it is dropped', async () => {
    const { terminal, client, app } = start();
    await attached(terminal);
    terminal.type('\x11');
    terminal.type(`${LEADER}${LEADER}`);
    terminal.type(`${LEADER}x`); // not in the leader table: dropped
    expect(client().sent).toEqual(['%1 \x11', `%1 ${LEADER}`]);
    terminal.type(`${LEADER}q`);
    await app.done;
    expect(client().closed).toBe(1);
  });

  it('shows LEADER and its keys in the footer while the leader is armed, and the mode again once it disarms', async () => {
    const { terminal } = start();
    await attached(terminal);
    terminal.type(LEADER);
    await waitForFooter(terminal, 'LEADER ←→ tab · Tab focus · 1-9 · ? help');
    terminal.type(ESC);
    await waitForFooter(terminal, '[master] keys go to the master');
    // It disarms by itself after about a second.
    terminal.type(LEADER);
    await waitForFooter(terminal, 'LEADER');
    await waitForFooter(terminal, '[master] keys go to the master');
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
    await waitFor(() => client().resizes.includes('162x52'));
    client().lines = ['$ resized'];
    client().emit('resize', 162, 52);
    await waitForSlotLine(terminal, '$ resized');
    const screen = await shown(terminal);
    expect(text(screen, 6, 37, 162)).toBe('$ resized');
    // With room, the master's header shows its facts.
    expect(text(screen, 5, 36)).toContain('[ MASTER ] demo-project · workers 0/2 · no open tasks ');
    expect(text(screen, 58, 36)).toBe(`└${'─'.repeat(162)}┘`);
    expect(text(screen, 0)).toBe('ORC │ demo-project');
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
    expect(text(screen, 6, 36, 43)).toBe('$ hello from orc-master');
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

  it('opens a worker tab sized to the slot and switches between tabs, each shown correctly', async () => {
    const { terminal, clients, app } = twoTabs();
    await attached(terminal);
    expect(app.apply((state) => openAgent(state, 'demo', 'w1')).ok).toBe(true);
    await attached(terminal, 'orc-w1');
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    const [master, worker] = clients;
    expect([worker.target, worker.ignoreSize]).toEqual([W1_TARGET, false]);
    expect(worker.resizes).toEqual(['43x16']); // the shown worker's window is sized to the slot
    expect(text(await shown(terminal), 2, 34)).toContain('w1');
    expect(text(await shown(terminal), 5, 35)).toMatch(/^┌─ \[ W1 \] /); // the agent's header on the pane box

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

  it('pads a smaller worker screen into the slot with the edge marker, and crops a larger one, when its window changes size outside the cockpit', async () => {
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
    await waitForSlotLine(terminal, `$ ${'x'.repeat(41)}`);
    expect(worker.resizes).toEqual(['43x16']); // only when shown
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
    terminal.type(`${LEADER}${LEADER}`);
    await sleep(40);
    expect(worker.sent).toEqual([]);
    expect(worker.pastes).toEqual([]);
    expect(clients[0].sent).toEqual([]);
    await waitForFooter(terminal, '[view] i: type · q/Esc: close');
    await waitForTabBar(terminal, 1, '○ w1');

    terminal.type('i');
    await waitForFooter(terminal, '[typing] Ctrl-]: stop typing');
    await waitForTabBar(terminal, 1, '✎ w1');
    expect(worker.sent).toEqual([]); // i itself only starts typing
    terminal.type(`q\x04\x03${ESC}[A`);
    terminal.type(`${ESC}[200~pasted${ESC}[201~`);
    expect(worker.sent).toEqual(['%2 q', '%2 \x04', '%2 \x03', `%2 ${ESC}[A`]);
    expect(worker.pastes).toEqual(['%2 pasted']);

    terminal.type('\x1d'); // Ctrl-] back to view mode
    await waitForFooter(terminal, '[view]');
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
    terminal.type(`${LEADER}1`); // the master tab through the leader table
    await waitForSlotLine(terminal, '$ hello from orc-master');
    terminal.type(`${LEADER}2`);
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

  it('runs the leader table and direct keys: tab walking that repeats, closing and projects', async () => {
    const { terminal, app } = start({ projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] }), projectState('other')] });
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type(`${LEADER}${ESC}[C`); // → wraps to the master
    expect(app.tabs().projects[0].active).toBe(null);
    terminal.type('l'); // still armed: → again
    expect(app.tabs().projects[0].active).toBe('w1');
    terminal.type(`h${ESC}[D`); // ← twice
    expect(app.tabs().projects[0].active).toBe('w1');
    terminal.type('w'); // closes w1 and disarms
    expect(app.tabs().projects[0].tabs).toEqual([]);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    terminal.type(`${ESC}OP`); // F1: the master tab
    expect(app.tabs().projects[0].active).toBe(null);
    terminal.type(`${LEADER}w`); // the master tab stays open
    expect(app.tabs().projects[0].tabs).toEqual(['w1']);
    app.apply((state) => showProject(state, 'other'));
    terminal.type(`${LEADER}n`);
    expect(app.tabs().activeProject).toBe('demo');
    terminal.type(`${LEADER}N`);
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
    await waitForTabBar(terminal, 1, 'view state not saved: EACCES');
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
    await waitForSidebar(terminal, '[ OTHER-PROJECT ]');
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
/** Waits until the header (the terminal's top row) contains `part`. */
async function waitForHeader(terminal: FakeTerminal, part: string): Promise<void> {
  await waitFor(async () => text(await shown(terminal), 0).includes(part));
}
async function sidebarRow(terminal: FakeTerminal, part: string): Promise<number> {
  await waitForSidebar(terminal, part);
  // A frame row: the sidebar's rows start below the header.
  return computeLayout(terminal.cols, terminal.rows).sidebar.y + (await sidebarRows(terminal)).findIndex((row) => row.includes(part));
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
    await waitForSidebar(terminal, '[ DEMO-PROJECT ]');
    await waitForSidebar(terminal, '日本語');
    await waitForSidebar(terminal, `${WIDE_AGENT}`);
    const rows = await sidebarRows(terminal);
    // The agent needing attention sorts first and shows its badge in its phase's place.
    const wide = rows.findIndex((row) => row.includes(WIDE_AGENT));
    expect(rows[wide]).toContain('QUESTION');
    expect(wide).toBeLessThan(rows.findIndex((row) => row.includes('w1 ')));
    expect(rows[0].endsWith('┐')).toBe(true);
    // Every card row ends on the sidebar's right border, wide names or not; the gap rows between cards are blank.
    const screen = await shown(terminal);
    const gaps = rows.slice(0, 14).flatMap((row, index) => (row.trim() === '' ? [index] : []));
    expect(gaps.length).toBeGreaterThan(0);
    for (let y = 1; y < 15; y++) expect(screen.row(y)[SIDEBAR_COLS - 1].text).toMatch(gaps.includes(y - 1) ? /^ $/ : /[┐│┘]/);
    expect(rows.some((row) => row.includes('[master]'))).toBe(false); // the mode is the footer's
    expect(text(screen, 23)).toContain('[master] keys go to the master');
  });

  it('expands an agent on a click on its row and opens it on its [ OPEN ], shows a tab on a click and closes it on its close marker, the worker untouched', async () => {
    const { terminal, clients, app } = withWorkers();
    terminal.resizeTo(120, 30); // room for all three tabs
    await waitForSlotText(terminal, '$ hello from orc-master');
    // A click on the row expands the agent, opening nothing and leaving the keys where they were.
    terminal.type(click(8, await sidebarRow(terminal, 'w1 ')));
    await waitForSidebar(terminal, '[-] w1 ');
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: [], active: null });
    await waitForFooter(terminal, '[master]');
    // Only its [ OPEN ] opens it.
    terminal.type(click(5, await sidebarRow(terminal, '[ OPEN ]')));
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: 'w1' });
    // The opened tab takes the keys, as after a tab click: its view mode's keys work at once.
    await waitForFooter(terminal, '[view] i: type');
    await waitForSlotText(terminal, '$ hello from orc-w1');
    // The second row of an agent (its question) expands it too; its [ OPEN ] (above w1's) opens it; a wide name's tab lays out by display width.
    terminal.type(click(3, (await sidebarRow(terminal, WIDE_AGENT)) + 1));
    await waitForSidebar(terminal, `[-] ${WIDE_AGENT}`);
    expect(app.tabs().projects[0].tabs).toEqual(['w1']);
    terminal.type(click(5, await sidebarRow(terminal, '[ OPEN ]')));
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1', WIDE_AGENT], active: WIDE_AGENT });
    await waitForSlotText(terminal, '$ hello from orc-wide');
    await waitForTabBar(terminal, 1, `○ ${WIDE_AGENT} ! QUESTION ×`);

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
    await waitForSidebar(terminal, '[ 日本語 ]');
    // Its master takes the keys right away.
    const other = clients.find((fake) => fake.target.session === 'orc-master-other')!;
    terminal.type('z');
    expect(other.sent).toEqual([`${other.paneId} z`]);
  });

  it('navigates the sidebar by keyboard: F10 focuses it, arrows move, Enter expands an agent, ↓ and Enter press its OPEN and give the opened tab the keys, Tab switches box, Esc returns to the pane', async () => {
    const { terminal, clients, app } = withWorkers();
    await attached(terminal);
    const master = clients[0];
    terminal.type(F10);
    await waitForFooter(terminal, 'Tab: card · Enter: open/expand · Esc: pane');
    // The cursor starts on the first agent (the one needing attention); down moves to w1, Enter expands it and opens nothing.
    terminal.type(`${ESC}[B\r`);
    await waitForSidebar(terminal, '[-] w1 ');
    expect(app.tabs().projects[0].tabs).toEqual([]);
    // Down goes onto its [ OPEN ], marked; Enter presses it.
    terminal.type(`${ESC}[B`);
    await waitForSidebar(terminal, '▸[ OPEN ] [ KILL ]');
    terminal.type('\r');
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: 'w1' });
    // The opened tab has the keys, as after a click: view mode, so i then a key reach the worker, and nothing the master.
    await waitForFooter(terminal, '[view] i: type · q/Esc: close');
    await attached(terminal, 'orc-w1');
    const worker = clients.find((fake) => fake.target.session === 'orc-w1')!;
    terminal.type('ix');
    expect(worker.sent).toEqual([`${worker.paneId} x`]);
    expect(master.sent).toEqual([]);

    // F10 toggles: pressed in the sidebar it returns to the pane, the tab still typing.
    terminal.type(F10);
    await waitForFooter(terminal, 'Enter: open');
    terminal.type(F10);
    await waitForFooter(terminal, '[typing] Ctrl-]: stop typing');

    // Back in the sidebar (its cursor kept on w1's OPEN): k returns to w1's row, k again to the wide-named agent; Enter expands it,
    // j goes to its OPEN, l and h move to KILL and back, Enter opens it.
    terminal.type(F10);
    await waitForFooter(terminal, 'Enter: open');
    terminal.type('kk\rj');
    await waitForSidebar(terminal, '▸[ OPEN ] [ KILL ]');
    terminal.type('l');
    await waitForSidebar(terminal, ' [ OPEN ]▸[ KILL ]');
    terminal.type('h\r');
    expect(app.tabs().projects[0].active).toBe(WIDE_AGENT);
    await waitForFooter(terminal, '[view] i: type');

    // Tab to the projects box: down and Enter switch project, and its master takes the keys.
    terminal.type(F10);
    await waitForFooter(terminal, 'Enter: open');
    terminal.type('\tj\r');
    expect(app.tabs().activeProject).toBe('other');
    await waitForSidebar(terminal, '[ 日本語 ]');
    await waitForFooter(terminal, '[master] keys go to the master');
    await attached(terminal, 'orc-master-other');
    const other = clients.find((fake) => fake.target.session === 'orc-master-other')!;
    terminal.type('y');
    expect(other.sent).toEqual([`${other.paneId} y`]);

    // Esc returns from the sidebar to the pane without opening anything.
    terminal.type(F10);
    await waitForFooter(terminal, 'Enter: open');
    terminal.type(ESC);
    await waitForFooter(terminal, '[master] keys go to the master');
    terminal.type('z');
    expect(other.sent).toEqual([`${other.paneId} y`, `${other.paneId} z`]);
  });

  it('cycles the Projects, Project and Agents cards with Tab and Shift-Tab; without a settings host Enter and a click on [ SETTINGS ] are refused', async () => {
    const { terminal, app } = withWorkers();
    await attached(terminal);
    terminal.type(F10);
    await waitForFooter(terminal, 'Tab: card');
    // From the Agents card Shift-Tab goes to the Project card, whose only target is the settings button.
    terminal.type(`${ESC}[Z\r`);
    await waitForTabBar(terminal, 1, 'This cockpit cannot change settings.');
    expect(app.tabs().projects[0]).toMatchObject({ tabs: [], active: null }); // nothing opened
    // Any key clears the notice; a click on the button asks again.
    terminal.type(ESC);
    await waitFor(async () => !text(await shown(terminal), 2).includes('This cockpit cannot change settings.'));
    terminal.type(click(4, await sidebarRow(terminal, '[ SETTINGS ]')));
    await waitForTabBar(terminal, 1, 'This cockpit cannot change settings.');
  });

  it('expands and collapses the cursor agent with Space in the sidebar and an agent with a click on its marker; Space in the slot reaches the pane', async () => {
    const { terminal, client, app } = withWorkers();
    await attached(terminal);
    const sidebarHas = async (part: string) => (await sidebarRows(terminal)).some((row) => row.includes(part));
    // With the slot focused Space is typed into the master; nothing expands.
    terminal.type(' ');
    expect(client().sent).toEqual(['%1  ']);
    expect(await sidebarHas('[-]')).toBe(false);

    // Sidebar focused: Space expands the cursor's agent (the one needing attention sorts first) without opening it, and collapses it again.
    terminal.type(F10);
    await waitForFooter(terminal, 'Enter: open/expand');
    terminal.type(' ');
    await waitForSidebar(terminal, `[-] ${WIDE_AGENT}`);
    await waitForSidebar(terminal, '[ OPEN ] [ KILL ]');
    await waitForSidebar(terminal, 'Which one?');
    expect(app.tabs().projects[0].tabs).toEqual([]);
    terminal.type(' ');
    await waitFor(async () => !(await sidebarHas('[-]')));
    terminal.type(ESC);
    await waitForFooter(terminal, '[master]');

    // A click on w1's marker expands it, opens nothing and leaves the keys where they were; one on its [ OPEN ] opens it.
    terminal.type(click(3, await sidebarRow(terminal, '[+] w1 ')));
    await waitForSidebar(terminal, '[-] w1 ');
    expect(app.tabs().projects[0].tabs).toEqual([]);
    await waitForFooter(terminal, '[master]');
    const top = await sidebarRow(terminal, '[-] w1 ');
    terminal.type(click(5, await sidebarRow(terminal, '[ OPEN ]')));
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w1'], active: 'w1' });
    // A click elsewhere on the block's title row collapses it, as one on its marker (one column further in, after the block's side) does.
    terminal.type(click(10, top));
    await waitForSidebar(terminal, '[+] w1 ');
    terminal.type(click(2, await sidebarRow(terminal, '[+] w1 ')));
    await waitForSidebar(terminal, '[-] w1 ');
    terminal.type(click(3, await sidebarRow(terminal, '[-] w1 ')));
    await waitForSidebar(terminal, '[+] w1 ');
    expect(app.tabs().projects[0].active).toBe('w1');
  });

  it('toggles the focus with the leader then s, and a click in the slot gives it the keys', async () => {
    const { terminal, client } = withWorkers();
    await attached(terminal);
    terminal.type(`${LEADER}s`);
    await waitForFooter(terminal, 'Enter: open');
    let screen = await shown(terminal);
    expect(screen.cursor().visible).toBe(false); // the pane's cursor is not shown while the sidebar has the keys
    terminal.type(`${LEADER}s`);
    await waitForFooter(terminal, '[master]');
    terminal.type('a');
    expect(client().sent).toEqual(['%1 a']);
    terminal.type(F10);
    await waitForFooter(terminal, 'Enter: open');
    terminal.type(click(50, 10));
    await waitForFooter(terminal, '[master]');
    screen = await shown(terminal);
    expect(screen.cursor().visible).toBe(true);
  });

  it('walks the container ring with the leader then Tab / Shift-Tab, which stay armed: pane, tab strip, sidebar, pane', async () => {
    const { terminal, client } = withWorkers();
    await attached(terminal);
    /** Esc disarms the leader (the footer shows LEADER while it is armed) and leaves the focus as it is. */
    const disarm = async () => { terminal.type(ESC); await sleep(40); };
    terminal.type(`${LEADER}\t`);
    await waitForFooter(terminal, 'LEADER ←→ tab');
    await disarm();
    await waitForFooter(terminal, '[tabs]');
    terminal.type(`${LEADER}\t`);
    await disarm();
    await waitForFooter(terminal, 'Enter: open');
    terminal.type(`${LEADER}\t\t\t`); // round the ring: pane, tab strip, sidebar
    await disarm();
    await waitForFooter(terminal, 'Enter: open');
    terminal.type(`${LEADER}\t`);
    await disarm();
    await waitForFooter(terminal, '[master]');
    terminal.type(`${LEADER}${ESC}[Z`); // Shift-Tab: back to the sidebar, then the tab strip
    terminal.type(`${ESC}[Z`);
    await disarm();
    await waitForFooter(terminal, '[tabs]');
    terminal.type(`${LEADER}p`); // the pane, disarming
    await waitForFooter(terminal, '[master]');
    terminal.type('a');
    expect(client().sent).toEqual(['%1 a']);
    // F10 still toggles the sidebar, from the tab strip too.
    terminal.type(`${LEADER}\t`);
    await disarm();
    await waitForFooter(terminal, '[tabs]');
    terminal.type(F10);
    await waitForFooter(terminal, 'Enter: open');
    terminal.type(F10);
    await waitForFooter(terminal, '[master]');
  });

  it('moves a highlight over the tab strip with ←/→; Enter shows the tab, w closes it, Esc returns to the pane; no key reaches the pane', async () => {
    const { terminal, client, app } = withWorkers();
    await attached(terminal);
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type(`${LEADER}\t`);
    terminal.type(ESC); // disarms; the tab strip keeps the keys
    await sleep(40);
    await waitForFooter(terminal, '[tabs] ←→ · Enter: show · w: close · Esc: pane');
    // The highlight starts on the shown tab.
    await waitForTabBar(terminal, 1, '▸');
    const row = computeLayout(terminal.cols, terminal.rows).tabBar.y + 1;
    const marker = async () => text(await shown(terminal), row, SIDEBAR_COLS).indexOf('▸');
    const onW1 = await marker();
    expect(text(await shown(terminal), row, SIDEBAR_COLS).slice(onW1)).toContain('w1');
    terminal.type(`${ESC}[D`);
    await waitFor(async () => (await marker()) < onW1);
    terminal.type('ab\x03');
    expect(client().sent).toEqual([]);
    terminal.type('\r'); // shows the master and gives it the keys
    await waitForFooter(terminal, '[master]');
    expect(app.tabs().projects[0].active).toBeNull();
    await waitFor(async () => (await marker()) < 0);
    terminal.type(`${LEADER}\t`);
    terminal.type(ESC);
    await sleep(40);
    await waitForFooter(terminal, '[tabs]');
    terminal.type(`${ESC}[C`);
    terminal.type('w'); // closes w1, only the view
    expect(app.tabs().projects[0].tabs).toEqual([]);
    terminal.type(`${ESC}[B`); // ↓: back to the pane
    await waitForFooter(terminal, '[master]');
    expect(client().sent).toEqual([]);
  });

  it('starts and stops typing on the shown worker tab with the leader then i; nothing on the master', async () => {
    const { terminal, clients, app } = withWorkers();
    await attached(terminal);
    terminal.type(`${LEADER}i`);
    await sleep(30);
    await waitForFooter(terminal, '[master]');
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await waitForSlotLine(terminal, '$ hello from orc-w1');
    terminal.type(`${LEADER}i`);
    await waitForFooter(terminal, '[typing]');
    terminal.type('a');
    expect(clients[1].sent).toEqual(['%2 a']);
    terminal.type(`${LEADER}i`);
    await waitForFooter(terminal, '[view]');
    terminal.type('b');
    expect(clients[1].sent).toEqual(['%2 a']);
    expect(clients[0].sent).toEqual([]);
  });

  it('opens the help dialog with the leader then ?, listing the configured keys; it scrolls, takes every key and closes on Esc', async () => {
    const { terminal, client } = withWorkers();
    await attached(terminal);
    const screenText = async () => {
      const screen = await shown(terminal);
      return Array.from({ length: terminal.rows }, (_, y) => text(screen, y)).join('\n');
    };
    terminal.type(`${LEADER}?`);
    await waitFor(async () => (await screenText()).includes('Leader: Ctrl-Space, then'));
    const before = await screenText();
    expect(before).toContain('HELP');
    expect(before).toContain('quit the cockpit');
    terminal.type('jjjj');
    await waitFor(async () => !(await screenText()).includes('Leader: Ctrl-Space, then'));
    terminal.type('a');
    terminal.type(ESC);
    await waitFor(async () => !(await screenText()).includes('HELP'));
    expect(client().sent).toEqual([]);
    terminal.type('x');
    expect(client().sent).toEqual(['%1 x']);
  });

  it('shows why a tab transition was refused until the next key', async () => {
    const { terminal, app } = withWorkers();
    await attached(terminal);
    terminal.type(`${LEADER}w`);
    await waitForTabBar(terminal, 1, 'The master tab stays open');
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
      await waitForSidebar(terminal, '[ DEMO-PROJECT ]');
      const right = SIDEBAR_COLS + computeLayout(cols, rows).gutter.cols;
      for (let until = Date.now() + 2_000; ; await sleep(25)) {
        const screen = await shown(terminal);
        const footer = text(screen, rows - 1, 0, SIDEBAR_COLS);
        // The pane box's top-left corner sits under the tab bar's four rows, right of the gutter.
        if (screen.row(1)[SIDEBAR_COLS - 1].text === '┐' && footer.includes('[master]') && text(screen, 5, right).startsWith('┌')
          && screen.row(rows - 2)[cols - 1].text === '┘') break;
        if (Date.now() > until) throw new Error(`layout not redrawn at ${cols}x${rows}`);
      }
      const { slot, paneFrame } = computeLayout(cols, rows);
      const framed = { x: right, y: HEADER_ROWS + TAB_BAR_ROWS, cols: cols - right, rows: rows - HEADER_ROWS - TAB_BAR_ROWS - FOOTER_ROWS };
      expect(paneFrame).toEqual(framed);
      expect(slot).toEqual({ x: framed.x + 1, y: framed.y + 1, cols: framed.cols - 2, rows: framed.rows - 2 });
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
  shells: Array<{ session: string; cwd: string; size: string }> = [];
  startShell(session: string, cwd: string, size: { cols: number; rows: number }) {
    this.shells.push({ session, cwd, size: `${size.cols}x${size.rows}` });
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve({ socket: 'orc-explorer', session });
  }
  agents: Array<{ session: string; cwd: string; size: string; command: string }> = [];
  startAgent(session: string, cwd: string, size: { cols: number; rows: number }, command: string) {
    this.agents.push({ session, cwd, size: `${size.cols}x${size.rows}`, command });
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve({ socket: 'orc-explorer', session });
  }
  prompts: Array<{ session: string; text: string }> = [];
  sendPrompt(target: TmuxTarget, text: string) { this.prompts.push({ session: target.session, text }); return Promise.resolve(); }
  readonly accepted: string[] = [];
  acceptStartup(target: TmuxTarget) { this.accepted.push(target.session); return Promise.resolve(); }
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

  it('opens a shell tab on a click on the + tab: typing at once, closed by × (its session stopped) or by its shell ending', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients, app } = start({ explorer: host });
    await attached(terminal);
    const shellClient = (session: string) => clients.find((fake) => fake.target.session === session);
    terminal.type(click(await columnOf(terminal, 2, '+', SIDEBAR_COLS), 2));
    await attached(terminal, 'shell-demo-1');
    expect(host.shells).toEqual([{ session: 'shell-demo-1', cwd: '/repo/demo', size: '43x16' }]);
    expect(shellClient('shell-demo-1')!.target.socket).toBe('orc-explorer');
    expect(app.tabs().projects[0].active).toBe('shell:1');
    await waitForTabBar(terminal, 1, 'shell 1 ×');
    expect(text(await shown(terminal), 5, 35)).toContain('[ SHELL 1 ]');
    // It types at once: keys reach it without i, i among them.
    const fake = shellClient('shell-demo-1')!;
    terminal.type('ls\ri');
    await waitFor(() => fake.sent.length === 4);
    expect(fake.sent).toEqual([`${fake.paneId} l`, `${fake.paneId} s`, `${fake.paneId} \r`, `${fake.paneId} i`]);
    // A second + gives shell 2.
    terminal.type(click(await columnOf(terminal, 2, '+', SIDEBAR_COLS), 2));
    await attached(terminal, 'shell-demo-2');
    expect(app.tabs().projects[0].active).toBe('shell:2');
    // Its shell ending closes its tab.
    shellClient('shell-demo-2')!.emit('exit', 'session closed');
    await waitFor(() => !app.tabs().projects[0].tabs.includes('shell:2'));
    // × on shell 1 closes the tab and stops its session.
    terminal.type(`${LEADER}2`);
    await attached(terminal, 'shell-demo-1');
    const row = text(await shown(terminal), 2);
    terminal.type(click(row.indexOf('×', row.indexOf('shell 1')), 2));
    await waitFor(() => !app.tabs().projects[0].tabs.includes('shell:1'));
    expect(host.stopped).toContainEqual({ socket: 'orc-explorer', session: 'shell-demo-1' });
    expect(clients[0].sent).toEqual([]); // nothing reached the master
  });

  it('refuses a shell that did not start and opens no tab', async () => {
    const host = new FakeExplorerHost();
    host.failWith = new Error('no tmux');
    const { terminal, app } = start({ explorer: host });
    await attached(terminal);
    const before = app.tabs();
    terminal.type(click(await columnOf(terminal, 2, '+', SIDEBAR_COLS), 2));
    await waitFor(() => host.shells.length === 1);
    await sleep(30);
    expect(app.tabs()).toEqual(before);
  });

  it('has no + tab without an explorer host', async () => {
    const { terminal } = start();
    await attached(terminal);
    expect(text(await shown(terminal), 2, SIDEBAR_COLS)).not.toContain('+');
  });

  it('opens the explorer as a tab on the leader then e, forwards its keys, and closes it on q back to the active tab', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients, app } = start({ explorer: host });
    await attached(terminal);
    await waitForHeader(terminal, 'tasks');
    const before = app.tabs();
    terminal.type(`${LEADER}e`);
    await attached(terminal, 'explorer-demo');
    expect(host.started).toEqual(['demo 43x16']);
    const fake = explorerClient(clients)!;
    // The explorer's window is the cockpit's own: sized to the slot, not an ignore-size view.
    expect(fake.ignoreSize).toBe(false);
    await waitForTabBar(terminal, 1, ' tasks ×');
    await waitForFooter(terminal, '[tasks] Ctrl-] or ×: close');
    expect(text(await shown(terminal), 5, 35)).toBe('┌─ [ TASKS ] task explorer · demo-project ──┐'); // the explorer's header on the pane box
    expect(text(await shown(terminal), 0)).not.toContain('tasks'); // no entry while it is shown
    // Its own keys reach it; i is not the typing key here.
    terminal.type(`j${ESC}[Bi\r`);
    await waitFor(() => fake.sent.length === 4);
    expect(fake.sent).toEqual([`${fake.paneId} j`, `${fake.paneId} ${ESC}[B`, `${fake.paneId} i`, `${fake.paneId} \r`]);
    // The leader then e again keeps it.
    terminal.type(`${LEADER}e`);
    expect(host.started).toHaveLength(1);
    // Ctrl-] closes it: its session is killed and the master shown again, the tabs as they were.
    terminal.type('\x1d');
    await attached(terminal);
    expect(host.stopped).toEqual([{ socket: 'orc-explorer', session: 'explorer-demo' }]);
    expect(fake.closed).toBe(1);
    expect(app.tabs()).toEqual(before);
    expect(clients[0].sent).toEqual([]); // nothing typed reached the master
    await waitForFooter(terminal, '[master] keys go to the master');
  });

  it('opens on a click on the header tasks entry, closes on its close marker, and gives way to any tab change', async () => {
    const host = new FakeExplorerHost();
    const { terminal, app } = start({ explorer: host, projects: [projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] })] });
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await attached(terminal, 'orc-w1');
    await waitForHeader(terminal, 'tasks');
    // The tab bar's right end, where the entry was before the header: no button there now.
    terminal.type(click(76, 2));
    await sleep(30);
    expect(host.started).toEqual([]);
    terminal.type(click(await columnOf(terminal, 0, 't', 40), 0));
    await attached(terminal, 'explorer-demo');
    const close = await columnOf(terminal, 2, '×', (await columnOf(terminal, 2, '×', SIDEBAR_COLS)) + 1);
    terminal.type(click(close, 2));
    await attached(terminal, 'orc-w1'); // back to the active tab
    expect(host.stopped).toHaveLength(1);

    // A tab change while the explorer is shown shows that tab and ends the explorer.
    terminal.type(`${LEADER}e`);
    await attached(terminal, 'explorer-demo');
    terminal.type(`${LEADER}1`);
    await attached(terminal);
    expect(app.tabs().projects[0].active).toBeNull();
    expect(host.stopped).toHaveLength(2);
    // Its own number keeps it shown.
    terminal.type(`${LEADER}e`);
    await attached(terminal, 'explorer-demo');
    terminal.type(`${LEADER}3`);
    expect(host.stopped).toHaveLength(2);
  });

  it('shows why the explorer did not start, closes when it quits on its own, and stops it when the cockpit quits', async () => {
    const host = new FakeExplorerHost();
    host.failWith = new Error('no server running on /tmp/tmux-1000/orc-explorer');
    const { terminal, clients, app } = start({ explorer: host });
    await attached(terminal);
    terminal.type(`${LEADER}e`);
    await waitForSlotText(terminal, 'The task explorer did not start.');
    await waitForSlotText(terminal, 'no server running');
    terminal.type('q');
    await attached(terminal);
    expect(host.stopped).toEqual([]); // no session was started

    host.failWith = null;
    terminal.type(`${LEADER}e`);
    await attached(terminal, 'explorer-demo');
    explorerClient(clients)!.emit('exit', 'session closed');
    await attached(terminal);
    expect(host.stopped).toHaveLength(1);

    terminal.type(`${LEADER}e`);
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
    terminal.type(`${LEADER}e`);
    await attached(terminal, 'explorer-demo');
    const fake = explorerClient(clients)!;
    // Enter opens a task's detail; Esc (back to the list) reaches the explorer and the tab stays.
    terminal.type('\r');
    terminal.type(ESC);
    await waitFor(() => fake.sent.length === 2);
    expect(fake.sent).toEqual([`${fake.paneId} \r`, `${fake.paneId} ${ESC}`]);
    await sleep(30);
    expect(host.stopped).toEqual([]);
    await waitForTabBar(terminal, 1, ' tasks ×');
    // q in its list: the explorer quits on its own, its session ends, the cockpit closes the tab.
    terminal.type('q');
    await waitFor(() => fake.sent.length === 3);
    expect(fake.sent[2]).toBe(`${fake.paneId} q`);
    fake.emit('exit', 'session closed');
    await attached(terminal);
    expect(app.tabs()).toEqual(before);
    expect(clients[0].sent).toEqual([]); // nothing reached the master
    await waitForFooter(terminal, '[master] keys go to the master');
  });

  it('sends keys that arrive in one read to the explorer one at a time, each after the one before reached it', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients } = start({ explorer: host });
    await attached(terminal);
    terminal.type(`${LEADER}e`);
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
    terminal.type(`${LEADER}e`);
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
    terminal.type(`${LEADER}e`);
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
    await waitForFooter(terminal, '[typing]');
    terminal.type(`${ESC}OP`);
    await attached(terminal);
    terminal.type(`${ESC}OQ`);
    await attached(terminal, 'orc-w1');
    await waitForFooter(terminal, '[view] i: type');
    terminal.type('\x04');
    await attached(terminal);
    expect(app.tabs().projects[0].tabs).toEqual([]);
    expect(worker.sent).toEqual([]);

    // The explorer shown over a typing tab: closed again, the tab is view-only.
    app.apply((state) => openAgent(state, 'demo', 'w1'));
    await attached(terminal, 'orc-w1');
    terminal.type('i');
    await waitForFooter(terminal, '[typing]');
    terminal.type(`${LEADER}e`);
    await attached(terminal, 'explorer-demo');
    terminal.type('\x1d');
    await attached(terminal, 'orc-w1');
    await waitForFooter(terminal, '[view] i: type');

    // An attention jump (F11 to w2) leaves w1 view-only too.
    terminal.type('i');
    await waitForFooter(terminal, '[typing]');
    terminal.type(F11);
    await attached(terminal, 'orc-w2');
    terminal.type(`${ESC}OQ`);
    await attached(terminal, 'orc-w1');
    await waitForFooter(terminal, '[view] i: type');
    expect(clients.filter((fake) => fake.target.session === 'orc-w1').flatMap((fake) => fake.sent)).toEqual([]);
  });

  it('refuses the explorer without a host, keeping the active tab', async () => {
    const { terminal } = start();
    await attached(terminal);
    expect(text(await shown(terminal), 0)).not.toContain('tasks');
    terminal.type(`${LEADER}e`);
    await waitForTabBar(terminal, 1, 'This cockpit has no task explorer.');
  });

  it('jumps to the next agent needing attention across projects on F11 and on a click on the header badge', async () => {
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
    await waitForHeader(terminal, '! 2'); // the stopped project's agent is not counted
    expect((await shown(terminal)).row(0).map((cell) => cell.text).join('').endsWith(' ! 2')).toBe(true);
    // The count is on the button only: not in the tab bar or the footer.
    expect(text(await shown(terminal), 1, SIDEBAR_COLS)).not.toContain('! 2');
    expect(text(await shown(terminal), 23)).not.toContain('! 2');
    terminal.type(F11);
    await attached(terminal, 'orc-w2');
    expect(app.tabs().activeProject).toBe('demo');
    expect(app.tabs().projects[0]).toEqual({ projectId: 'demo', tabs: ['w2'], active: 'w2' });
    await waitForFooter(terminal, '[view] i: type'); // it opens view-only, with the keys
    // A click where the badge was in the tab bar does nothing.
    terminal.type(click(79, 1));
    await sleep(30);
    expect(app.tabs().activeProject).toBe('demo');
    // The badge: the next one is in the other project, added with the agent's tab.
    terminal.type(click(await columnOf(terminal, 0, '!'), 0));
    await attached(terminal, 'orc-o1');
    expect(app.tabs().activeProject).toBe('other');
    expect(app.tabs().projects[1]).toEqual({ projectId: 'other', tabs: ['o1'], active: 'o1' });
    // Wraps around.
    terminal.type(F11);
    await attached(terminal, 'orc-w2');
    expect(app.tabs().activeProject).toBe('demo');
  });

  it('keeps the header badge with no project open, without the tasks entry, and a click on it jumps', async () => {
    const { terminal, app } = start({
      explorer: new FakeExplorerHost(),
      projects: [projectState('demo', { workers: [{ agent_id: 'w2', socket: 'orc-sock', session: 'orc-w2', attention: { kind: 'question', detail: null } }] })],
    });
    await attached(terminal);
    app.apply((state) => ({ ok: true, state: { ...state, activeProject: null }, message: 'none' }));
    await waitFor(async () => !text(await shown(terminal), 0).includes('tasks'));
    expect(text(await shown(terminal), 0)).toMatch(/^ORC +! 1$/);
    terminal.type(click(await columnOf(terminal, 0, '!'), 0));
    await attached(terminal, 'orc-w2');
    expect(app.tabs().activeProject).toBe('demo');
  });

  it('says so when no agent needs attention', async () => {
    const { terminal, app } = start();
    await attached(terminal);
    const before = app.tabs();
    terminal.type(F11);
    await waitForTabBar(terminal, 1, 'No agent needs attention.');
    expect(app.tabs()).toEqual(before);
  });
});

describe('runApp pane mouse (fake tmux clients)', () => {
  // The slot at 80x24 starts at frame cell (36, 6), inside the pane box right of the one-column gutter.
  const SX = 36;
  const SY = 6;

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
    expect((await slotRows(terminal))[0]).toBe('line 14');
    terminal.type(sgr(64, SX + 3, SY + 3));
    await waitFor(async () => (await slotRows(terminal))[0] === 'line 11');
    terminal.type(sgr(64, SX + 3, SY + 3) + sgr(64, SX + 3, SY + 3) + sgr(64, SX + 3, SY + 3) + sgr(64, SX + 3, SY + 3));
    await waitForSlotLine(terminal, 'line 0');
    terminal.type(sgr(65, SX + 3, SY + 3));
    await waitFor(async () => (await slotRows(terminal))[0] === 'line 3');
    expect(client().sent).toEqual([]);
    terminal.type('a');
    await waitFor(async () => (await slotRows(terminal))[0] === 'line 14');
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
    await waitForFooter(terminal, '[typing]');
    terminal.type(sgr(0, SX + 1, SY));
    expect(worker.sent).toEqual([`%2 ${ESC}[<0;2;1M`]);
  });
  it('drags the divider on the gutter: a preview line while moving, the width applied once on release and saved', async () => {
    const { terminal, client, store } = start({ setup: (fake) => { fake.modes = SGR_ANY; } });
    await attached(terminal);
    expect(client().resizes).toEqual(['43x16']);
    // The gutter at 80x24 is column 34.
    terminal.type(sgr(0, 34, 10) + sgr(32, 40, 10) + sgr(32, 44, 10));
    await waitFor(async () => (await shown(terminal)).cell(44, 12)?.text === '┃');
    expect(client().resizes).toEqual(['43x16']); // not on motion
    terminal.type(sgr(0, 44, 10, true));
    // Sidebar 44, gutter 1: a 35-column right side, a 33x16 slot inside the box.
    await waitFor(() => client().resizes.length === 2);
    expect(client().resizes).toEqual(['43x16', '33x16']);
    await waitFor(() => store.state.sidebarCols === 44);
    await waitFor(async () => (await shown(terminal)).cell(44, 12)?.text !== '┃');
    expect(client().sent).toEqual([]); // nothing reached the pane
    // A plain click on the gutter changes nothing.
    await sleep(450);
    terminal.type(sgr(0, 44, 10) + sgr(0, 44, 10, true));
    await sleep(30);
    expect(client().resizes).toHaveLength(2);
  });

  it('keeps a dragged width within 24..60 columns', async () => {
    const { terminal, store } = start();
    await attached(terminal);
    terminal.type(sgr(0, 34, 10) + sgr(32, 5, 10) + sgr(0, 5, 10, true));
    await waitFor(() => store.state.sidebarCols === 24);
  });

  it('starts at the saved sidebar width and resets it to the default on a double press', async () => {
    const store = new MemoryStore({ ...DEFAULT_VIEW_STATE, sidebarCols: 40 });
    const { terminal, client } = start({ store });
    // (The fixtures' slot helpers assume the default width.)
    await waitFor(() => client()?.resizes.length === 1);
    // Sidebar 40, gutter 1: a 39-column right side, a 37x16 slot.
    expect(client().resizes).toEqual(['37x16']);
    terminal.type(sgr(0, 40, 10) + sgr(0, 40, 10, true) + sgr(0, 40, 10));
    await waitFor(() => client().resizes.length === 2);
    expect(client().resizes).toEqual(['37x16', '43x16']);
    await waitFor(() => store.state.sidebarCols === undefined);
  });
});

// ── settings dialog ──────────────────────────────────────────────────────────

class FakeSettingsHost implements SettingsHost {
  writes: Array<[string, string, SettingValue]> = [];
  restarts: string[] = [];
  reads: string[] = [];
  /** Set to make writes throw. */
  writeError: Error | null = null;
  /** Set to make reads throw. */
  readError: Error | null = null;
  /** The pending restart, resolved or rejected by the test. */
  restart: { resolve: () => void; reject: (error: Error) => void } | null = null;
  constructor(public settings: Record<string, unknown> = {
    'worker_pool.max_workers': 2, 'coordinator.merge_strategy': 'direct', 'worker_pool.provider': 'claude',
    'worker_pool.provider_models.claude': 'opus', 'worker_pool.execution_mode': 'full-access',
  }) {}
  read(projectId: string) {
    this.reads.push(projectId);
    if (this.readError) throw this.readError;
    return this.settings;
  }
  write(projectId: string, key: string, value: SettingValue) {
    if (this.writeError) throw this.writeError;
    this.writes.push([projectId, key, value]);
  }
  restartCoordinator(projectId: string) {
    this.restarts.push(projectId);
    return new Promise<void>((resolve, reject) => { this.restart = { resolve, reject }; });
  }
}

describe('runApp settings dialog (fake tmux client, fake settings host)', () => {
  const DIALOG_TITLE = 'SETTINGS · DEMO-PROJECT';
  const screenHas = async (terminal: FakeTerminal, part: string) => {
    const screen = await shown(terminal);
    return Array.from({ length: screen.rows }, (_, y) => text(screen, y)).some((row) => row.includes(part));
  };
  const waitForScreen = (terminal: FakeTerminal, part: string) => waitFor(() => screenHas(terminal, part));
  const waitForClosed = (terminal: FakeTerminal) => waitFor(async () => !(await screenHas(terminal, DIALOG_TITLE)));
  /** Opens the dialog from the keyboard: F10, Shift-Tab to the Project card, Enter on [ SETTINGS ]. */
  async function openDialog(terminal: FakeTerminal): Promise<void> {
    terminal.type(F10);
    await waitForFooter(terminal, 'Tab: card');
    terminal.type(`${ESC}[Z\r`);
    await waitForScreen(terminal, DIALOG_TITLE);
  }
  /** The frame cell where `part` first starts, on whichever row has it. */
  async function cellOf(terminal: FakeTerminal, part: string): Promise<{ x: number; y: number }> {
    const screen = await shown(terminal);
    for (let y = 0; y < screen.rows; y++) {
      const x = text(screen, y).indexOf(part);
      if (x >= 0) return { x, y };
    }
    throw new Error(`${part} is not shown`);
  }

  it('opens on Enter on [ SETTINGS ] over a dimmed frame with the project\'s settings, hides the cursor, and Esc closes it without writing', async () => {
    const host = new FakeSettingsHost();
    const { terminal, client } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    expect(host.reads).toEqual(['demo']);
    await waitForScreen(terminal, '‹ opus ›');
    const screen = await shown(terminal);
    // Behind the dialog: the dimmed sidebar; the cursor is hidden.
    expect(screen.row(2)[1].style.dim).toBe(true);
    expect(terminal.writes.join('').lastIndexOf('\x1b[?25l')).toBeGreaterThan(terminal.writes.join('').lastIndexOf('\x1b[?25h'));
    terminal.type(ESC);
    await waitForClosed(terminal);
    expect(host.writes).toEqual([]);
    expect(client().sent).toEqual([]);
  });

  it('opens on a click on [ SETTINGS ]; a click on CANCEL closes it', async () => {
    const host = new FakeSettingsHost();
    const { terminal } = start({ settings: host });
    await attached(terminal);
    terminal.type(click(4, await sidebarRow(terminal, '[ SETTINGS ]')));
    await waitForScreen(terminal, DIALOG_TITLE);
    const cancel = await cellOf(terminal, '[ CANCEL ]');
    terminal.type(click(cancel.x + 2, cancel.y));
    await waitForClosed(terminal);
    expect(host.writes).toEqual([]);
  });

  it('takes every key while open: none reaches the pane or the sidebar', async () => {
    const host = new FakeSettingsHost();
    const { terminal, client, app } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    // x, a paste and F10 do nothing; j moves the dialog's cursor, not the sidebar's.
    terminal.type(`x${ESC}[200~pasted${ESC}[201~${F10}jj`);
    await sleep(50);
    expect(client().sent).toEqual([]);
    expect(client().pastes).toEqual([]);
    expect(app.tabs().projects[0]).toMatchObject({ tabs: [], active: null });
    await waitForScreen(terminal, DIALOG_TITLE);
  });

  it('writes exactly the changed max workers on Enter and closes', async () => {
    const host = new FakeSettingsHost();
    const { terminal } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    terminal.type('l');
    await waitForScreen(terminal, '‹ 3 ›');
    await waitForScreen(terminal, 'Applies at once.');
    terminal.type('\r');
    await waitForClosed(terminal);
    expect(host.writes).toEqual([['demo', 'worker_pool.max_workers', 3]]);
    expect(host.restarts).toEqual([]);
  });

  it('refuses pr merge without a PR provider: the error shows and nothing is written', async () => {
    const host = new FakeSettingsHost();
    const { terminal } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    terminal.type('jl');
    await waitForScreen(terminal, 'PR provider');
    terminal.type('\r');
    await waitForScreen(terminal, 'PR merge needs a PR provider.');
    expect(host.writes).toEqual([]);
    await waitForScreen(terminal, DIALOG_TITLE);
  });

  it('pr merge with github and SAVE & RESTART writes both, restarts the coordinator once, ignores keys meanwhile, and closes after', async () => {
    const host = new FakeSettingsHost();
    const { terminal } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    // Merge → pr, PR provider → github, then Tab over the rest of the fields and SAVE to SAVE & RESTART.
    terminal.type('jljl');
    await waitForScreen(terminal, '‹ github ›');
    await waitForScreen(terminal, '! Applies after a coordinator restart.');
    terminal.type('\t\t\t\t\t');
    terminal.type('\r');
    await waitForScreen(terminal, 'Restarting the coordinator…');
    expect(host.writes).toEqual([['demo', 'coordinator.merge_strategy', 'pr'], ['demo', 'coordinator.pr_provider', 'github']]);
    expect(host.restarts).toEqual(['demo']);
    terminal.type(`\r${ESC}`);
    await sleep(50);
    expect(host.restarts).toEqual(['demo']);
    await waitForScreen(terminal, DIALOG_TITLE);
    host.restart!.resolve();
    await waitForClosed(terminal);
    expect(host.writes).toHaveLength(2);
  });

  it('keeps the dialog open with the first line of a failed write, and saves on a retry', async () => {
    const host = new FakeSettingsHost();
    host.writeError = new Error('worker_pool.max_workers must be a non-negative integer\nmore detail');
    const { terminal } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    terminal.type('l\r');
    await waitForScreen(terminal, 'worker_pool.max_workers must be a non-negativ');
    expect(await screenHas(terminal, 'more detail')).toBe(false);
    await waitForScreen(terminal, DIALOG_TITLE);
    // It still takes keys: a retry once the write works saves and closes.
    host.writeError = null;
    terminal.type('\r');
    await waitForClosed(terminal);
    expect(host.writes).toEqual([['demo', 'worker_pool.max_workers', 3]]);
  });

  it('shows a failed restart in the dialog', async () => {
    const host = new FakeSettingsHost();
    const { terminal } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    // Execution mode (the last field, up from the first over the buttons) → sandbox, then SAVE & RESTART.
    terminal.type('kkkl');
    await waitForScreen(terminal, '‹ sandbox ›');
    terminal.type('jj\r');
    await waitFor(() => host.restart !== null);
    host.restart!.reject(new Error('Coordinator did not start'));
    await waitForScreen(terminal, 'Coordinator did not start');
    expect(host.writes).toEqual([['demo', 'worker_pool.execution_mode', 'sandbox']]);
  });

  it('closes when its project is removed', async () => {
    const host = new FakeSettingsHost();
    const { terminal, watcher } = start({ settings: host });
    await attached(terminal);
    await openDialog(terminal);
    watcher.emit({ type: 'removed', project_id: 'demo' });
    await waitForClosed(terminal);
  });

  it('refuses to open when the settings cannot be read', async () => {
    const host = new FakeSettingsHost();
    host.readError = new Error('Project is not registered: demo');
    const { terminal } = start({ settings: host });
    await attached(terminal);
    terminal.type(F10);
    await waitForFooter(terminal, 'Tab: card');
    terminal.type(`${ESC}[Z\r`);
    await waitForTabBar(terminal, 1, 'The settings could not be read');
    expect(await screenHas(terminal, DIALOG_TITLE)).toBe(false);
  });
});

// ── killing an agent ─────────────────────────────────────────────────────────

class FakeAgentHost implements AgentActionHost {
  kills: Array<[string, string, 'worker' | 'scout', string | null]> = [];
  /** The pending kill, resolved or rejected by the test. */
  pending: { resolve: () => void; reject: (error: Error) => void } | null = null;
  kill(projectId: string, agentId: string, kind: 'worker' | 'scout', taskRef: string | null) {
    this.kills.push([projectId, agentId, kind, taskRef]);
    return new Promise<void>((resolve, reject) => { this.pending = { resolve, reject }; });
  }
}

describe('runApp agent block buttons and kill (fake tmux clients, fake agents host)', () => {
  const S1_TARGET = { socket: 'orc-sock', session: 'orc-s1' };
  /** demo with w1 on task feat/one (claude, opus) and a scout s1 (codex, model unknown, a two-line objective). */
  function demo(): ProjectWatchState {
    const state = projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET }] });
    const status = state.status as unknown as { worker_capacity: { slots: Array<Record<string, unknown>> }; scouts: unknown[] };
    Object.assign(status.worker_capacity.slots[0], { active_task_ref: 'feat/one', provider: 'claude', model: 'opus' });
    status.scouts = [{
      agent_id: 's1', provider: 'codex', model: null, objective: 'find docs errors\nin docs/', status: 'running', launched_at: null,
      session_handle: `tmux:${S1_TARGET.socket}:${S1_TARGET.session}`, tmux_socket: S1_TARGET.socket, tmux_session: S1_TARGET.session,
    }];
    return state;
  }
  const screenHas = async (terminal: FakeTerminal, part: string) => {
    const screen = await shown(terminal);
    return Array.from({ length: screen.rows }, (_, y) => text(screen, y)).some((row) => row.includes(part));
  };
  const waitForScreen = (terminal: FakeTerminal, part: string) => waitFor(() => screenHas(terminal, part));
  const waitForGone = (terminal: FakeTerminal, part: string) => waitFor(async () => !(await screenHas(terminal, part)));
  /** Expands `agent` with a click on its marker; resolves with its buttons row. */
  async function expand(terminal: FakeTerminal, agent: string): Promise<number> {
    terminal.type(click(3, await sidebarRow(terminal, `[+] ${agent} `)));
    const top = await sidebarRow(terminal, `[-] ${agent} `);
    await waitFor(async () => (await sidebarRows(terminal)).slice(top - 1).some((row) => row.includes('[ OPEN ] [ KILL ]')));
    const rows = await sidebarRows(terminal);
    return computeLayout(terminal.cols, terminal.rows).sidebar.y + rows.findIndex((row, index) => index >= top - 1 && row.includes('[ OPEN ] [ KILL ]'));
  }
  const KILL_X = 14;
  const OPEN_X = 5;

  it('opens the agent\'s tab on a click on OPEN; its pane header shows the task, phase and provider · model', async () => {
    const host = new FakeAgentHost();
    const { terminal, app } = start({ projects: [demo()], agents: host });
    await attached(terminal);
    terminal.type(click(OPEN_X, await expand(terminal, 'w1')));
    await waitFor(() => app.tabs().projects[0].active === 'w1');
    await waitFor(async () => text(await shown(terminal), 5, 35).startsWith('┌─ [ W1 ] feat/one · busy · claude · opus '));
    expect(host.kills).toEqual([]);
    // A scout's header: its brief (the objective's first line) and provider · model (`default`: unknown), no role, task or phase part.
    expect(app.apply((state) => openAgent(state, 'demo', 's1')).ok).toBe(true);
    // Whole parts only: at 80 columns the brief alone fits; wider, provider · model follows.
    await waitFor(async () => /^┌─ \[ S1 \] find docs errors ─+┐$/.test(text(await shown(terminal), 5, 35)));
    terminal.resizeTo(120, terminal.rows);
    await waitFor(async () => text(await shown(terminal), 5).includes('┌─ [ S1 ] find docs errors · codex · default ─'));
  });

  it('asks before killing a worker on a click on KILL; KILL in the dialog resets its task through the host and closes it', async () => {
    const host = new FakeAgentHost();
    const { terminal, client, app } = start({ projects: [demo()], agents: host });
    await attached(terminal);
    terminal.type(click(KILL_X, await expand(terminal, 'w1')));
    await waitForScreen(terminal, 'KILL · W1');
    await waitForScreen(terminal, 'Kill w1? Its run is cancelled and feat/one goes');
    expect(host.kills).toEqual([]);
    expect(app.tabs().projects[0].tabs).toEqual([]);
    // Behind the dialog the frame is dimmed; keys reach nothing behind it.
    expect((await shown(terminal)).row(2)[1].style.dim).toBe(true);
    terminal.type('x');
    await sleep(30);
    expect(client().sent).toEqual([]);
    terminal.type('\r');
    await waitFor(() => host.kills.length === 1);
    expect(host.kills).toEqual([['demo', 'w1', 'worker', 'feat/one']]);
    await waitForScreen(terminal, 'Killing…');
    host.pending!.resolve();
    await waitForGone(terminal, 'KILL · W1');
  });

  it('asks before killing a scout with the x key in the agents box, and a click on the dialog\'s KILL removes it', async () => {
    const host = new FakeAgentHost();
    const { terminal } = start({ projects: [demo()], agents: host });
    await attached(terminal);
    terminal.type(F10);
    await waitForFooter(terminal, 'Tab: card');
    terminal.type('jx');
    await waitForScreen(terminal, 'Kill s1? Its session ends and it is removed.');
    const screen = await shown(terminal);
    const y = Array.from({ length: screen.rows }, (_, row) => row).find((row) => text(screen, row).includes('[ KILL ]  [ CANCEL ]'))!;
    terminal.type(click(text(screen, y).indexOf('[ KILL ]') + 2, y));
    await waitFor(() => host.kills.length === 1);
    expect(host.kills).toEqual([['demo', 's1', 'scout', null]]);
    host.pending!.resolve();
    await waitForGone(terminal, 'KILL · S1');
  });

  it('cancels on Esc, q or CANCEL without killing', async () => {
    const host = new FakeAgentHost();
    const { terminal } = start({ projects: [demo()], agents: host });
    await attached(terminal);
    const buttons = await expand(terminal, 'w1');
    for (const close of [ESC, 'q', 'cancel']) {
      terminal.type(click(KILL_X, buttons));
      await waitForScreen(terminal, 'KILL · W1');
      if (close === 'cancel') {
        const screen = await shown(terminal);
        const y = Array.from({ length: screen.rows }, (_, row) => row).find((row) => text(screen, row).includes('[ CANCEL ]'))!;
        terminal.type(click(text(screen, y).indexOf('[ CANCEL ]') + 2, y));
      } else {
        terminal.type(close);
      }
      await waitForGone(terminal, 'KILL · W1');
    }
    expect(host.kills).toEqual([]);
  });

  it('keeps the dialog open with the first line of the error when the kill fails', async () => {
    const host = new FakeAgentHost();
    const { terminal } = start({ projects: [demo()], agents: host });
    await attached(terminal);
    terminal.type(click(KILL_X, await expand(terminal, 'w1')));
    await waitForScreen(terminal, 'KILL · W1');
    terminal.type('\r');
    await waitFor(() => host.pending !== null);
    host.pending!.reject(new Error('Task not found: feat/one\nmore detail'));
    await waitForScreen(terminal, 'Task not found: feat/one');
    expect(await screenHas(terminal, 'more detail')).toBe(false);
    expect(await screenHas(terminal, 'KILL · W1')).toBe(true);
  });

  it('refuses without an agents host', async () => {
    const { terminal } = start({ projects: [demo()] });
    await attached(terminal);
    terminal.type(click(KILL_X, await expand(terminal, 'w1')));
    await waitForTabBar(terminal, 1, 'This cockpit cannot kill agents.');
    expect(await screenHas(terminal, 'KILL · W1')).toBe(false);
  });
});

// ── add-project and new-agent dialogs ────────────────────────────────────────

class FakeProjectHost implements ProjectHost {
  added: Array<[string, string | null, string]> = [];
  failWith: Error | null = null;
  constructor(public projectId = 'fresh') {}
  add(path: string, name: string | null, provider: string) {
    this.added.push([path, name, provider]);
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve({ projectId: this.projectId });
  }
}

describe('runApp add-project and new-agent dialogs (fake hosts)', () => {
  const screenText = async (terminal: FakeTerminal) => {
    const screen = await shown(terminal);
    return Array.from({ length: screen.rows }, (_, y) => text(screen, y)).join('\n');
  };
  const waitForScreen = (terminal: FakeTerminal, part: string) => waitFor(async () => (await screenText(terminal)).includes(part));
  const waitForGone = (terminal: FakeTerminal, part: string) => waitFor(async () => !(await screenText(terminal)).includes(part));
  const critic: AgentDefinition = { name: 'critic', description: 'Reviews changes', prompt: 'You are the critic.\nReview the diff.' };

  it('adds a project: typing and a paste into the path, validation in the dialog, ADD calls the host, then shows the project once known', async () => {
    const projectHost = new FakeProjectHost('fresh');
    const { terminal, client, app, watcher } = start({ projectHost });
    await attached(terminal);
    app.openAddProject();
    await waitForScreen(terminal, '[ ADD PROJECT ]');
    // Enter with no path: refused in the dialog.
    terminal.type('\r');
    await waitForScreen(terminal, 'Path is required');
    // j, k, q and a space are typed, not keys; a paste goes in on one line.
    terminal.type('/w jq');
    terminal.type(`${ESC}[200~/pasted\n${ESC}[201~`);
    await waitForScreen(terminal, '/w jq/pasted');
    terminal.type('\x7f\x7f\x15/work/app');
    await waitForScreen(terminal, '/work/app');
    // Tab to the name, type it; Tab to the provider, → to codex; Enter adds.
    terminal.type('\tMy App\t');
    terminal.type(`${ESC}[C`);
    await waitForScreen(terminal, '‹ codex ›');
    terminal.type('\r');
    await waitFor(() => projectHost.added.length === 1);
    expect(projectHost.added).toEqual([['/work/app', 'My App', 'codex']]);
    await waitForGone(terminal, '[ ADD PROJECT ]');
    expect(client().sent).toEqual([]);
    expect(app.tabs().activeProject).toBe('demo');
    // The watcher reports the project: it is shown.
    watcher.emit({ type: 'added', project_id: 'fresh', state: projectState('fresh') });
    await waitFor(() => app.tabs().activeProject === 'fresh');
  });

  it('keeps a failed add open with its first line, and Esc closes it', async () => {
    const projectHost = new FakeProjectHost();
    projectHost.failWith = new Error('Not a git repository: /nope\nmore detail');
    const { terminal } = start({ projectHost });
    await attached(terminal);
    const app = apps.at(-1)!;
    app.openAddProject();
    await waitForScreen(terminal, '[ ADD PROJECT ]');
    terminal.type('/nope\r');
    await waitForScreen(terminal, 'Not a git repository: /nope');
    expect(await screenText(terminal)).not.toContain('more detail');
    terminal.type(ESC);
    await waitForGone(terminal, '[ ADD PROJECT ]');
  });

  it('refuses the add-project dialog without a project host', async () => {
    const { terminal, app } = start();
    await attached(terminal);
    app.openAddProject();
    await waitForTabBar(terminal, 1, 'cannot add projects');
  });

  it('keeps the provider\'s permission prompts under a sandbox execution mode, and runs and records the project\'s model', async () => {
    const host = new FakeExplorerHost();
    const settings = new FakeSettingsHost({
      'worker_pool.provider': 'codex', 'worker_pool.execution_mode': 'sandbox', 'worker_pool.provider_models.codex': 'gpt-6.1-sol',
    });
    const { terminal, app, store } = start({ explorer: host, settings, agentDefinitions: () => [critic], projects: [projectState('demo', { name: 'demo' })] });
    await attached(terminal);
    app.openNewAgent('demo');
    await waitForScreen(terminal, '‹ codex ›');
    terminal.type('\r');
    await attached(terminal, 'agent-demo-1');
    expect(host.agents[0].command).toBe('codex --model gpt-6.1-sol');
    expect(host.accepted).toEqual([]); // sandbox: its startup questions are the user's
    await waitFor(() => store.state.agentTabs?.demo?.['agent:1'] !== undefined);
    expect(store.state.agentTabs?.demo?.['agent:1']).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol' });
  });

  it('starts a fresh session on the project\'s provider in an agent:1 tab that types at once; × kills it', async () => {
    const host = new FakeExplorerHost();
    const settings = new FakeSettingsHost({ 'worker_pool.provider': 'codex' });
    const { terminal, clients, app, store } = start({ explorer: host, settings, agentDefinitions: () => [critic], projects: [projectState('demo', { name: 'demo' })] });
    await attached(terminal);
    app.openNewAgent('demo');
    await waitForScreen(terminal, 'NEW AGENT · DEMO');
    await waitForScreen(terminal, '‹ codex ›');
    expect(await screenText(terminal)).not.toContain('Agent');
    terminal.type('\r');
    await attached(terminal, 'agent-demo-1');
    // Full-access (the default execution mode): the provider's skip-permissions flag, and its startup questions answered.
    expect(host.agents).toEqual([{ session: 'agent-demo-1', cwd: '/repo/demo', size: '43x16', command: 'codex --dangerously-bypass-approvals-and-sandbox' }]);
    expect(host.accepted).toEqual(['agent-demo-1']);
    expect(host.prompts).toEqual([]);
    expect(app.tabs().projects[0].active).toBe('agent:1');
    await waitForTabBar(terminal, 1, 'codex 1 ×');
    expect(text(await shown(terminal), 5, 35)).toContain('[ CODEX 1 ]');
    expect(text(await shown(terminal), 5, 35)).toContain('fresh session');
    await waitFor(() => store.state.agentTabs?.demo?.['agent:1'] !== undefined);
    expect(store.state.agentTabs).toEqual({ demo: { 'agent:1': { provider: 'codex', agent: null, openedAt: expect.any(String) } } });
    // It types at once.
    const fake = clients.find((candidate) => candidate.target.session === 'agent-demo-1')!;
    terminal.type('hi');
    await waitFor(() => fake.sent.length === 2);
    // × closes the tab and kills the session.
    const row = text(await shown(terminal), 2);
    terminal.type(click(row.indexOf('×', row.indexOf('codex 1')), 2));
    await waitFor(() => !app.tabs().projects[0].tabs.includes('agent:1'));
    expect(host.stopped).toContainEqual({ socket: 'orc-explorer', session: 'agent-demo-1' });
    await waitFor(() => store.state.agentTabs === undefined);
  });

  describe('in the Agents card', () => {
    const OPEN_X = 5;
    const KILL_X = 14;
    const sidebarHas = async (terminal: FakeTerminal, part: string) => (await sidebarRows(terminal)).some((row) => row.includes(part));
    /** demo with a worker w1 needing attention, and a fresh claude session started from the new-agent dialog in agent:1. */
    async function withSession() {
      const host = new FakeExplorerHost();
      const demo = projectState('demo', { workers: [{ agent_id: 'w1', ...W1_TARGET, attention: { kind: 'question', detail: null } }] });
      const started = start({ explorer: host, projects: [demo] });
      await attached(started.terminal);
      started.app.openNewAgent('demo');
      await waitForScreen(started.terminal, 'NEW AGENT · DEMO');
      started.terminal.type('\r');
      await attached(started.terminal, 'agent-demo-1');
      await waitForSidebar(started.terminal, '◇ claude 1');
      return { ...started, host };
    }

    it('lists the session after the coordinator\'s agents with [LOCAL], counted apart and not in the header\'s attention', async () => {
      const { terminal } = await withSession();
      const rows = await sidebarRows(terminal);
      const worker = rows.findIndex((row) => row.includes('[+] w1 '));
      const local = rows.findIndex((row) => row.includes('[+] ◇ claude 1'));
      expect(worker).toBeGreaterThan(-1);
      expect(local).toBeGreaterThan(worker);
      expect(rows[local]).toMatch(/0m \[LOCAL\]/);
      expect(rows.some((row) => /\[ AGENTS \].*1 live · 1 local/.test(row))).toBe(true);
      // The header counts w1 only.
      expect(text(await shown(terminal), 0)).toMatch(/! 1$/);
    });

    it('expands into its block; OPEN shows its tab; KILL asks, then closes the tab and ends the session', async () => {
      const { terminal, app, host } = await withSession();
      expect(app.apply((state) => openAgent(state, 'demo', 'w1')).ok).toBe(true);
      await waitFor(() => app.tabs().projects[0].active === 'w1');
      terminal.type(click(3, await sidebarRow(terminal, '[+] ◇ claude 1')));
      await waitForSidebar(terminal, '[-] ◇ claude 1');
      for (const part of ['model  claude · default', 'type   fresh session', 'not managed by the', '[ OPEN ] [ KILL ]']) await waitForSidebar(terminal, part);
      const buttons = await sidebarRow(terminal, '[ OPEN ] [ KILL ]');
      terminal.type(click(OPEN_X, buttons));
      await waitFor(() => app.tabs().projects[0].active === 'agent:1');
      terminal.type(click(KILL_X, await sidebarRow(terminal, '[ OPEN ] [ KILL ]')));
      await waitForScreen(terminal, 'KILL · CLAUDE 1');
      await waitForScreen(terminal, 'Kill claude 1? Its session ends and its tab');
      expect(app.tabs().projects[0].tabs).toContain('agent:1');
      terminal.type('\r');
      await waitFor(() => !app.tabs().projects[0].tabs.includes('agent:1'));
      expect(host.stopped).toContainEqual({ socket: 'orc-explorer', session: 'agent-demo-1' });
      await waitFor(async () => !(await sidebarHas(terminal, '◇')));
      expect(await sidebarHas(terminal, '1 local')).toBe(false);
    });

    it('drops the session when its tab is closed, and shows [ENDED] for one whose session ended in a tab not shown', async () => {
      const { terminal, app, clients } = await withSession();
      expect(app.apply((state) => openAgent(state, 'demo', 'w1')).ok).toBe(true);
      clients.find((candidate) => candidate.target.session === 'agent-demo-1')!.emit('exit', 'session closed');
      await waitFor(async () => (await sidebarRows(terminal)).some((row) => row.includes('◇ claude 1') && row.includes('[ENDED]')));
      expect(app.apply((state) => closeTab(state, 'agent:1')).ok).toBe(true);
      await waitFor(async () => !(await sidebarHas(terminal, '◇')));
    });
  });

  it('starts a custom agent with its prompt as the first message; its session ending closes the tab', async () => {
    const host = new FakeExplorerHost();
    const { terminal, clients, app } = start({ explorer: host, agentDefinitions: (root) => (root === '/repo/demo' ? [critic] : []) });
    await attached(terminal);
    app.openNewAgent('demo');
    await waitForScreen(terminal, 'NEW AGENT');
    // Down to the variant, → to custom agent: the Agent row appears.
    terminal.type(`j${ESC}[C`);
    await waitForScreen(terminal, 'Agent       critic');
    terminal.type('\r');
    await attached(terminal, 'agent-demo-1');
    expect(host.agents[0].command).toBe('claude --dangerously-skip-permissions');
    await waitFor(() => host.prompts.length === 1);
    expect(host.prompts).toEqual([{ session: 'agent-demo-1', text: critic.prompt }]);
    await waitForTabBar(terminal, 1, 'critic · claude ×');
    expect(text(await shown(terminal), 5, 35)).toContain('[ CRITIC ]');
    clients.find((candidate) => candidate.target.session === 'agent-demo-1')!.emit('exit', 'session closed');
    await waitFor(() => !app.tabs().projects[0].tabs.includes('agent:1'));
  });

  it('refuses a custom agent when the checkout has none, and keeps a failed start in the dialog', async () => {
    const host = new FakeExplorerHost();
    const { terminal, app } = start({ explorer: host });
    await attached(terminal);
    app.openNewAgent('demo');
    await waitForScreen(terminal, 'NEW AGENT');
    terminal.type(`j${ESC}[C`);
    await waitForScreen(terminal, 'no custom agents in .claude/agents');
    terminal.type('\r');
    await waitForScreen(terminal, 'No custom agents in .claude/agents to start.');
    expect(host.agents).toEqual([]);
    // Back to a fresh session; the start fails.
    terminal.type(`${ESC}[D`);
    host.failWith = new Error('no tmux');
    terminal.type('\r');
    await waitForScreen(terminal, 'no tmux');
    expect(app.tabs().projects[0].tabs).toEqual([]);
  });

  it('refuses the new-agent dialog without an explorer host', async () => {
    const { terminal, app } = start();
    await attached(terminal);
    app.openNewAgent('demo');
    await waitForTabBar(terminal, 1, 'cannot start agent sessions');
  });
});
