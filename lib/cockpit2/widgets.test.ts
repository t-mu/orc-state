import { describe, expect, it } from 'vitest';
import { stringWidth } from '../cellWidth.ts';
import type { SidebarAgent, SidebarModel, SidebarProject } from '../tui/sidebar.ts';
import { fitText } from '../tui/sidebar.ts';
import { CLOSE_MARKER, TAB_GAP, buildTabBarModel, layoutTabBar, tabBarClickTarget, type TabBarState } from '../tui/tabBarModel.ts';
import { computeLayout } from './app.ts';
import { DEFAULT_STYLE, createFrame, type Frame } from './frame.ts';
import { BUILT_IN_THEMES, attentionRole, badgeRole, styleOf } from './theme.ts';
import { INITIAL_SIDEBAR_NAV, drawSidebarCards, sidebarCardsLayout, type SidebarNav } from './sidebarCards.ts';
import {
  EXPLORER_TAB, PLUS_LABEL, TYPING_MARK, VIEW_MARK, HEADER_MARK, drawFooter, drawHeader, drawTabBar, headerButtonAt, headerView,
  onPlusTab, tabBarView, withExplorerTab, withModeMarks, type FooterHint, type HeaderButton,
} from './widgets.ts';

/** Today's look: every cell drawn as before the theme roles. */
const CLASSIC = BUILT_IN_THEMES.classic;

const CJK_PROJECT = '日本語プロジェクト';
const EMOJI_AGENT = 'agent-🚀-rocket';
const CJK_AGENT = '作業者-一';

function project(id: string, overrides: Partial<SidebarProject> = {}): SidebarProject {
  return {
    project_id: id, name: id, state_dir: `/state/${id}`, target_repo_root: `/repo/${id}`,
    connection: 'running', state: 'running', error: null, attention: 0, active: false, ...overrides,
  };
}

function agent(id: string, overrides: Partial<SidebarAgent> = {}): SidebarAgent {
  return { key: `p1/${id}`, agent_id: id, role: 'worker', phase: 'implement', elapsed: '12m', detail: `working on ${id}`, attention: null, ...overrides };
}

function model(overrides: Partial<SidebarModel> = {}): SidebarModel {
  return {
    status: { coordinator: 'running', workers: { used: 3, total: 4 }, attention: 1 },
    projects: [project('p1', { name: CJK_PROJECT, active: true, attention: 1 }), project('p2', { state: 'stopped', connection: 'stopped' })],
    activeProjectId: 'p1',
    agents: [
      agent(EMOJI_AGENT, { attention: 'question', detail: '? 本当に続けますか' }),
      agent(CJK_AGENT, { detail: '日本語のテキストがとても長い行の詳細' }),
      agent('w3'),
    ],
    agentsStale: false,
    notice: null,
    ...overrides,
  };
}

/** Row `y` of `frame` from column `x`, `cols` wide, as text (a wide grapheme's continuation cell adds nothing). */
const rowText = (frame: Frame, y: number, x = 0, cols = frame.cols) =>
  frame.cells.slice(y * frame.cols + x, y * frame.cols + x + cols).map((cell) => cell.text).join('');

// ── tab bar ──────────────────────────────────────────────────────────────────

const TABS: TabBarState = { activeProject: 'p1', projects: [{ projectId: 'p1', tabs: [CJK_AGENT, EMOJI_AGENT, 'w3'], active: CJK_AGENT }] };

function renderTabBar(cols: number, rows: number, state: TabBarState = TABS, slotFocused = true, typing = new Set([EMOJI_AGENT])) {
  const layout = computeLayout(cols, rows);
  const frame = createFrame(cols, rows);
  const bar = tabBarView(withModeMarks(buildTabBarModel(state, new Map([['w3', 'permission_prompt' as const]])), (id) => typing.has(id)), layout.tabBar.cols);
  drawTabBar(frame, layout.tabBar, bar, { slotFocused, error: null, theme: CLASSIC });
  const labelY = layout.tabBar.y + Math.floor((layout.tabBar.rows - 1) / 2);
  const line = rowText(frame, labelY, layout.tabBar.x, layout.tabBar.cols);
  return { frame, layout, bar, line, labelY };
}

describe('drawTabBar', () => {
  it('draws every tab at 200x60 with mode marks, badges and close markers, wide names in their display width', () => {
    const { line, bar, layout } = renderTabBar(200, 60);
    expect(line).toContain(` master `);
    expect(line).toContain(` ${VIEW_MARK} ${CJK_AGENT} ${CLOSE_MARKER} `);
    expect(line).toContain(` ${TYPING_MARK} ${EMOJI_AGENT} ${CLOSE_MARKER} `);
    expect(line).toContain(` ${VIEW_MARK} w3 ! PERMISSION ${CLOSE_MARKER} `);
    expect(line).not.toContain('quit'); // the quit key is in the footer
    expect(line).not.toContain('│'); // the tabs are solid blocks, no side borders
    // Each tab's edges are where the layout puts them: display widths, not string lengths; one column between tabs.
    for (const cell of bar.layout.cells) {
      expect(columnOf(line, cell.x)).toBe(' ');
      expect(columnOf(line, cell.x + cell.width - 1)).toBe(' ');
      expect(columnOf(line, cell.x + cell.width)).toBe(' ');
    }
    expect(bar.layout.cells.map((cell) => cell.width)).toEqual(bar.model.tabs.map((tab) => 2 + stringWidth(` ${tab.label}`) + (tab.attention ? ' ! PERMISSION'.length : 0) + (tab.closable ? 3 : 1)));
    expect(layout.tabBar.rows).toBe(4);
  });

  it('fills each tab\'s label row in tab.active or tab.inactive, caps a filled tab with half blocks, the gaps unstyled, focused or not', () => {
    const focused = renderTabBar(200, 60);
    const [master, active] = focused.bar.layout.cells;
    const { y } = focused.layout.tabBar;
    const cell = (frame: Frame, x: number, row = focused.labelY) => frame.cells[row * 200 + focused.layout.tabBar.x + x];
    const label = cell(focused.frame, active.x + 2).style;
    expect(label).toEqual(styleOf(CLASSIC, 'tab.active')); // classic: inverse
    expect(cell(focused.frame, master.x + 2).style).toEqual(styleOf(CLASSIC, 'tab.inactive'));
    expect(cell(focused.frame, active.x).style).toEqual(label);
    expect(cell(focused.frame, master.x + master.width).style).toEqual(DEFAULT_STYLE); // the gap
    // The active tab (inverse, no fill colour) is capped above and below; classic's inactive tab has no fill, so no caps.
    expect(cell(focused.frame, active.x, y).text).toBe('▄');
    expect(cell(focused.frame, active.x, y + 2).text).toBe('▀');
    expect(cell(focused.frame, master.x, y).text).toBe(' ');
    const unfocused = renderTabBar(200, 60, TABS, false);
    expect(cell(unfocused.frame, active.x + 2).style).toEqual(label);
  });

  it('caps a tab with a fill colour in that colour (amber)', () => {
    const AMBER = BUILT_IN_THEMES.amber;
    const layout = computeLayout(200, 60);
    const frame = createFrame(200, 60);
    const bar = tabBarView(buildTabBarModel(TABS), layout.tabBar.cols);
    drawTabBar(frame, layout.tabBar, bar, { slotFocused: true, error: null, theme: AMBER });
    const active = bar.layout.cells.find((c) => bar.model.tabs[c.index].active)!;
    const top = frame.cells[layout.tabBar.y * 200 + layout.tabBar.x + active.x];
    expect(top.text).toBe('▄');
    expect(top.style.fg).toEqual(styleOf(AMBER, 'tab.active').bg);
    expect(top.style.bg).toEqual(DEFAULT_STYLE.bg);
  });

  it('fits 80x24 with overflow markers and the active tab always shown, the tabs taking the full width', () => {
    const { line, bar } = renderTabBar(80, 24);
    expect(bar.layout.hiddenLeft + bar.layout.hiddenRight).toBeGreaterThan(0);
    expect(bar.layout.cells.some((cell) => cell.index === 1)).toBe(true);
    expect(stringWidth(line)).toBe(45);
    expect(bar.layout).toEqual(layoutTabBar(bar.model, 45)); // nothing reserved for buttons or a hint
    expect(line).not.toContain('quit');
    expect(line).not.toContain('tasks');
  });

  it('shows an error instead of the tabs, and a notice without tabs', () => {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    drawTabBar(frame, layout.tabBar, tabBarView(buildTabBarModel(TABS), 45), { slotFocused: true, error: 'The master tab stays open.', theme: CLASSIC });
    expect(rowText(frame, 2, 35, 45).trimEnd()).toBe('The master tab stays open.'); // the bar's label row
    const empty = createFrame(80, 24);
    drawTabBar(empty, layout.tabBar, tabBarView(buildTabBarModel({ activeProject: null, projects: [] }), 45), { slotFocused: true, error: null, theme: CLASSIC });
    expect(rowText(empty, 2, 35, 45)).toContain('No project is open');
  });
});

describe('tab bar roles', () => {
  const AMBER = BUILT_IN_THEMES.amber;
  const MONO = BUILT_IN_THEMES.mono;
  const ATTENTION: TabBarState = { activeProject: 'p1', projects: [{ projectId: 'p1', tabs: ['w1', 'w2', 'w3'], active: 'w1' }] };
  const KINDS = new Map([['w2', 'stalled' as const], ['w3', 'no_progress' as const]]);

  /** The tab bar at `cols` columns in a one-row frame. */
  function draw(theme: typeof AMBER, cols: number, slotFocused: boolean, error: string | null = null, state = ATTENTION) {
    const frame = createFrame(cols, 1);
    const bar = tabBarView(buildTabBarModel(state, KINDS), cols);
    drawTabBar(frame, { x: 0, y: 0, cols, rows: 1 }, bar, { slotFocused, error, theme });
    return { frame, bar, at: (x: number) => frame.cells[x].style };
  }

  it('draws each segment kind in its role', () => {
    const { bar, at, frame } = draw(AMBER, 80, true);
    const [master, w1, w2, w3] = bar.layout.cells;
    const fill = styleOf(AMBER, 'tab.active');
    const inactive = styleOf(AMBER, 'tab.inactive');
    expect(inactive.bg.type).not.toBe('default');
    // A tab is its fill edge to edge; the column between tabs is unstyled.
    expect(at(master.x)).toEqual(inactive);
    expect(at(master.x + 2)).toEqual(inactive);
    expect(at(master.x + master.width)).toEqual(DEFAULT_STYLE);
    expect(at(w1.x)).toEqual(fill);
    expect(at(w1.x + 2)).toEqual(fill);
    // The close mark keeps its colour on the tab's fill.
    expect(at(w1.closeX!)).toEqual({ ...styleOf(AMBER, 'tab.close'), bg: fill.bg });
    expect(at(w2.closeX!)).toEqual({ ...styleOf(AMBER, 'tab.close'), bg: inactive.bg });
    // An attention badge (`! KIND`) in its kind's status colour, from theme.ts, on the tab's fill.
    for (const [cell, kind] of [[w2, 'stalled'], [w3, 'no_progress']] as const) {
      const badgeX = cell.x + 1 + stringWidth(cell.text);
      expect(rowText(frame, 0, badgeX, cell.badge.length)).toBe(cell.badge);
      expect(cell.badge.startsWith(' ! ')).toBe(true);
      for (let x = badgeX; x < badgeX + cell.badge.length; x += 1) expect(at(x)).toEqual({ ...styleOf(AMBER, badgeRole(attentionRole(kind))), bg: inactive.bg });
    }
    // Right of the tabs nothing is drawn.
    expect(at(79)).toEqual(DEFAULT_STYLE);
    // Unfocused, the active tab keeps its fill.
    expect(draw(AMBER, 80, false).at(w1.x + 2)).toEqual(fill);
  });

  it('draws the active tab\'s close mark inverse when tab.active has no fill colour, as in mono', () => {
    const { bar, at } = draw(MONO, 80, true);
    const [, w1, w2] = bar.layout.cells;
    expect(at(w1.closeX!)).toEqual({ ...styleOf(MONO, 'tab.close'), inverse: true });
    expect(at(w2.closeX!)).toEqual(styleOf(MONO, 'tab.close'));
  });

  it('draws overflow markers and notices in text.muted, errors in error', () => {
    const many: TabBarState = { activeProject: 'p1', projects: [{ projectId: 'p1', tabs: Array.from({ length: 12 }, (_, index) => `worker-${index}`), active: 'worker-11' }] };
    const { bar, at } = draw(AMBER, 40, true, null, many);
    expect(bar.layout.leftMarker).not.toBe('');
    expect(at(0)).toEqual(styleOf(AMBER, 'text.muted'));
    const failed = draw(AMBER, 40, true, 'tmux select-pane failed', many);
    expect(rowText(failed.frame, 0).trimEnd()).toBe('tmux select-pane failed');
    expect(failed.at(0)).toEqual(styleOf(AMBER, 'error'));
    const none = draw(AMBER, 40, true, null, { activeProject: null, projects: [] });
    expect(none.at(0)).toEqual(styleOf(AMBER, 'text.muted'));
  });

  it('shows the same text with mono as with amber', () => {
    for (const focused of [true, false]) {
      const text = (theme: typeof AMBER) => rowText(draw(theme, 80, focused).frame, 0);
      expect(text(MONO)).toEqual(text(AMBER));
    }
  });
});

describe('header', () => {
  const BUTTONS: HeaderButton[] = [{ action: 'explorer', text: 'tasks' }, { action: 'attention', text: '! 2' }];
  const NAME = 'a-project-with-a-name-long-enough-to-cut-at-sixty';

  function renderHeader(cols: number, name: string | null = NAME, buttons: HeaderButton[] = BUTTONS, theme = CLASSIC) {
    const frame = createFrame(cols, 1);
    const view = headerView(cols, name, buttons);
    drawHeader(frame, { x: 0, y: 0, cols, rows: 1 }, view, theme);
    return { frame, view, line: rowText(frame, 0, 0, cols) };
  }

  it('shows the mark, the project and the buttons flush right at 80 columns', () => {
    const { line, view } = renderHeader(80);
    expect(line).toBe(`ORC │ ${NAME}`.padEnd(80 - ' tasks ! 2'.length) + ' tasks ! 2');
    expect(view.buttons.map((button) => [button.action, button.x])).toEqual([['explorer', 71], ['attention', 77]]);
  });

  it('cuts the project name first, then drops the explorer button, then the attention button', () => {
    expect(renderHeader(60).line).toBe(`ORC │ ${fitText(NAME, 44)} tasks ! 2`);
    expect(renderHeader(40).line).toBe(`ORC │ ${fitText(NAME, 24)} tasks ! 2`);
    const narrow = renderHeader(20);
    expect(narrow.line).toBe(`ORC │ ${fitText(NAME, 10)} ! 2`);
    expect(narrow.view.buttons.map((button) => button.action)).toEqual(['attention']);
    // Only the attention button left: it goes once the name would keep fewer than 6 columns.
    expect(renderHeader(16).view.buttons.map((button) => button.action)).toEqual(['attention']);
    expect(renderHeader(15).view.buttons).toEqual([]);
    expect(renderHeader(15).line).toBe(`ORC │ ${fitText(NAME, 9)}`);
    // A short name is not cut before the buttons go.
    expect(renderHeader(20, 'demo').line).toBe('ORC │ demo tasks ! 2');
  });

  it('shows only the mark with no project open', () => {
    expect(renderHeader(40, null, []).line).toBe('ORC'.padEnd(40));
  });

  it('hit-tests the buttons on their text only', () => {
    const { view } = renderHeader(80);
    const [tasks, badge] = view.buttons.map((button) => button.x);
    expect([tasks, tasks + 4].map((x) => headerButtonAt(view, x))).toEqual(['explorer', 'explorer']);
    expect([badge, badge + 2].map((x) => headerButtonAt(view, x))).toEqual(['attention', 'attention']);
    expect([tasks - 1, tasks + 5, 0].map((x) => headerButtonAt(view, x))).toEqual([null, null, null]);
  });

  it('draws the mark bold in text.accent, the name in text.primary and the buttons in their roles', () => {
    const AMBER = BUILT_IN_THEMES.amber;
    const { frame, view } = renderHeader(80, NAME, BUTTONS, AMBER);
    expect(frame.cells[0].text).toBe(HEADER_MARK[0]);
    expect(frame.cells[0].style).toEqual({ ...styleOf(AMBER, 'text.accent'), bold: true });
    expect(frame.cells[6].style).toEqual(styleOf(AMBER, 'text.primary'));
    expect(frame.cells[view.buttons[0].x].style).toEqual(styleOf(AMBER, 'button'));
    expect(frame.cells[view.buttons[1].x].style).toEqual(styleOf(AMBER, 'button.attention'));
  });
});

describe('the explorer tab', () => {
  it('shows the explorer as the active, closable tab after the project\'s tabs', () => {
    const model = withExplorerTab(buildTabBarModel(TABS));
    expect(model.tabs.map((tab) => [tab.label, tab.active])).toEqual([['master', false], [CJK_AGENT, false], [EMOJI_AGENT, false], ['w3', false], ['tasks', true]]);
    expect(model.tabs.at(-1)).toMatchObject({ agentId: EXPLORER_TAB, number: 5, closable: true });
    const bar = tabBarView(model, 200);
    const cell = bar.layout.cells.at(-1)!;
    expect(tabBarClickTarget(bar.model, bar.layout, cell.closeX!)).toEqual({ kind: 'close', tab: model.tabs.at(-1) });
    const empty = buildTabBarModel({ activeProject: null, projects: [] });
    expect(withExplorerTab(empty)).toBe(empty);
  });
});

describe('the + tab and shell tabs', () => {
  it('sits a gap after the last tab, only when asked for and with room', () => {
    const model = buildTabBarModel(TABS);
    const bar = tabBarView(model, 200, true);
    const last = bar.layout.cells.at(-1)!;
    expect(bar.layout.rightMarker).toBe('');
    expect(bar.plus).toEqual({ x: last.x + last.width + TAB_GAP });
    expect(onPlusTab(bar, bar.plus!.x)).toBe(true);
    expect(onPlusTab(bar, bar.plus!.x + PLUS_LABEL.length - 1)).toBe(true);
    expect(onPlusTab(bar, bar.plus!.x - 1)).toBe(false);
    expect(onPlusTab(bar, bar.plus!.x + PLUS_LABEL.length)).toBe(false);
    expect(tabBarView(model, 200).plus).toBeNull();
    expect(tabBarView(model, 200, false).plus).toBeNull();
    // No project open: the notice, no + tab.
    expect(tabBarView(buildTabBarModel({ activeProject: null, projects: [] }), 200, true).plus).toBeNull();
    // Too narrow for it.
    expect(tabBarView(model, 12, true).plus).toBeNull();
    expect(onPlusTab(tabBarView(model, 12, true), 0)).toBe(false);
  });

  it('goes after the overflow marker when the tabs do not all fit', () => {
    const bar = tabBarView(buildTabBarModel(TABS), 30, true);
    expect(bar.layout.rightMarker).not.toBe('');
    const last = bar.layout.cells.at(-1)!;
    expect(bar.plus).toEqual({ x: last.x + last.width + stringWidth(bar.layout.rightMarker) + TAB_GAP });
    expect(bar.plus!.x + PLUS_LABEL.length).toBeLessThanOrEqual(30);
  });

  it('draws the + as an inactive tab block with its caps', () => {
    const frame = createFrame(80, 4);
    const bar = tabBarView(buildTabBarModel(TABS), 80, true);
    drawTabBar(frame, { x: 0, y: 0, cols: 80, rows: 4 }, bar, { slotFocused: true, error: null, theme: BUILT_IN_THEMES.orc });
    const x = bar.plus!.x;
    expect(rowText(frame, 1, x, PLUS_LABEL.length)).toBe(PLUS_LABEL);
    expect(rowText(frame, 0, x, PLUS_LABEL.length)).toBe('▄'.repeat(PLUS_LABEL.length));
    expect(rowText(frame, 2, x, PLUS_LABEL.length)).toBe('▀'.repeat(PLUS_LABEL.length));
    const inactive = styleOf(BUILT_IN_THEMES.orc, 'tab.inactive');
    expect(frame.cells[1 * 80 + x + 1].style).toEqual({ ...inactive, bold: true });
    expect(frame.cells[x].style.fg).toEqual(inactive.bg);
  });

  it('labels shell tabs shell N, with no mode mark', () => {
    const model = withModeMarks(buildTabBarModel({ activeProject: 'p1', projects: [{ projectId: 'p1', tabs: ['w3', 'shell:2'], active: 'shell:2' }] }), () => false);
    expect(model.tabs.map((tab) => tab.label)).toEqual(['master', `${VIEW_MARK} w3`, 'shell 2']);
  });
});

describe('tab bar hit-testing', () => {
  for (const [cols, rows] of [[80, 24], [200, 60]] as const) {
    it(`selects a tab on its label and closes it on its close marker at ${cols}x${rows}`, () => {
      const { line, bar } = renderTabBar(cols, rows);
      for (const cell of bar.layout.cells) {
        const tab = bar.model.tabs[cell.index];
        expect(tabBarClickTarget(bar.model, bar.layout, cell.x + 1)).toEqual({ kind: 'select', tab });
        if (cell.closeX === null) continue;
        // The drawn `×` is where the hit-test puts it, even after a wide name.
        expect(columnOf(line, cell.closeX)).toBe(CLOSE_MARKER);
        expect(tabBarClickTarget(bar.model, bar.layout, cell.closeX)).toEqual({ kind: 'close', tab });
      }
    });
  }
});

/** The grapheme drawn at display column `x` of a row's text (a wide grapheme takes two columns); null inside one's second half. */
function columnOf(line: string, x: number): string | null {
  let col = 0;
  for (const ch of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)) {
    if (col === x) return ch.segment;
    col += stringWidth(ch.segment);
    if (col > x) return null;
  }
  return null;
}

// ── footer ───────────────────────────────────────────────────────────────────

const FOOTER_HINTS: FooterHint[] = [{ key: 'Ctrl-q', action: 'quit' }, { key: 'F10', action: 'dashboard' }, { key: 'F11', action: 'attention' }];

describe('drawFooter', () => {
  const MODE = '[view] i: type · q/Esc: close';
  const FULL = `${MODE} · ${CJK_PROJECT} › w1 · Ctrl-q: quit · F10: dashboard · F11: attention`;
  function footer(cols: number, mode = MODE, breadcrumb: { project: string; tab: string } | null = { project: CJK_PROJECT, tab: 'w1' }) {
    const layout = computeLayout(Math.max(cols, 30), 24);
    const frame = createFrame(layout.cols, 24);
    drawFooter(frame, { ...layout.footer, cols }, { mode, breadcrumb, hints: FOOTER_HINTS, theme: CLASSIC });
    return { frame, line: rowText(frame, 23, 0, cols).trimEnd() };
  }

  it('shows the mode, then project › tab, then the key hints on the last row', () => {
    expect(footer(120).line).toBe(FULL);
    expect(stringWidth(FULL)).toBeLessThan(120);
  });

  it('drops hints from the right as the width shrinks, keeps quit by cutting the breadcrumb; the mode always comes first', () => {
    const fullWidth = stringWidth(FULL);
    expect(footer(fullWidth).line).toBe(FULL);
    expect(footer(fullWidth - 1).line).toBe(`${MODE} · ${CJK_PROJECT} › w1 · Ctrl-q: quit · F10: dashboard`);
    expect(footer(80).line).toBe(`${MODE} · ${CJK_PROJECT} › w1 · Ctrl-q: quit`);
    // Quit stays: the breadcrumb is cut by display width instead.
    expect(footer(60).line).toBe(`${MODE} · 日本語プロジ… · Ctrl-q: quit`);
    expect(stringWidth(footer(60).line)).toBe(60);
    // Quit goes when even it does not fit; the breadcrumb is kept down to 8 columns.
    expect(footer(52).line).toBe(`${MODE} · Ctrl-q: quit`);
    expect(footer(40).line).toBe(`${MODE} · 日本語…`);
    expect(footer(36).line).toBe(MODE);
    // The mode is cut last, by display width.
    expect(footer(12).line).toBe(`${MODE.slice(0, 11)}…`);
    expect(stringWidth(footer(12).line)).toBe(12);
    // No project open: the hints follow the mode.
    expect(footer(80, MODE, null).line).toBe(`${MODE} · Ctrl-q: quit · F10: dashboard · F11: attention`);
  });

  it('keeps the quit key in view at 80 columns with a long project and tab name', () => {
    const mode = '[sidebar] ↑↓ Tab · Enter: open · Esc: pane';
    const { line } = footer(80, mode, { project: 'orc-state-desktop-app', tab: 'worker-grommash-cockpit' });
    expect(line).toBe(`${mode} · orc-state-desktop-a… · Ctrl-q: quit`);
    expect(stringWidth(line)).toBe(80);
  });

  it('ends a breadcrumb cut right after the project name with …', () => {
    // MODE (29) + ' · ' + crumb + ' · Ctrl-q: quit' (15): the crumb gets exactly the project's 9 columns.
    const { line } = footer(29 + 3 + 9 + 15, MODE, { project: 'orc-state', tab: 'master' });
    expect(line).toBe(`${MODE} · orc-stat… · Ctrl-q: quit`);
  });

  it('draws the mode and key names in text.accent, separators and actions in text.muted', () => {
    const { frame, line } = footer(120);
    const cellAt = (part: string) => frame.cells[23 * frame.cols + [...line.slice(0, line.indexOf(part))].reduce((sum, ch) => sum + stringWidth(ch), 0)];
    expect(cellAt('[view]').style).toEqual(styleOf(CLASSIC, 'text.accent'));
    expect(cellAt(' · Ctrl').style).toEqual(styleOf(CLASSIC, 'text.muted')); // the separator after the breadcrumb; the mode's own ` · ` is the mode's
    expect(cellAt(' › ').style).toEqual(styleOf(CLASSIC, 'text.muted'));
    expect(cellAt('Ctrl-q').style).toEqual(styleOf(CLASSIC, 'text.accent'));
    expect(cellAt(': quit').style).toEqual(styleOf(CLASSIC, 'text.muted'));
  });

  it('draws nothing into a dropped footer', () => {
    const layout = computeLayout(30, 5);
    const frame = createFrame(30, 5);
    drawFooter(frame, layout.footer, { mode: MODE, breadcrumb: null, hints: FOOTER_HINTS, theme: CLASSIC });
    expect(frame.cells.every((cell) => cell.text === ' ')).toBe(true);
  });
});

// ── full-style snapshot ──────────────────────────────────────────────────────

/** A cell style as a short key: attribute letters, then fg and bg (`p<index>`, `#rrggbb`, empty for default). */
function styleKey(style: Frame['cells'][number]['style']): string {
  const flags = (['bold', 'dim', 'italic', 'underline', 'blink', 'inverse', 'invisible', 'strikethrough'] as const)
    .filter((name) => style[name]).map((name) => name[0] + name[1]).join('');
  const color = (value: typeof style.fg) => value.type === 'palette' ? `p${value.index}`
    : value.type === 'rgb' ? `#${[value.r, value.g, value.b].map((n) => n.toString(16).padStart(2, '0')).join('')}` : '';
  return `${flags}/${color(style.fg)}/${color(style.bg)}`;
}

/** Every row of `frame` as runs of one style: `{style}text`, a wide grapheme's continuation cell kept as `·` so widths show. */
const serialiseFrame = (frame: Frame): string[] => Array.from({ length: frame.rows }, (_, y) => {
  let out = '';
  let last: string | null = null;
  for (const cell of frame.cells.slice(y * frame.cols, (y + 1) * frame.cols)) {
    const key = styleKey(cell.style);
    if (key !== last) out += `{${key}}`;
    last = key;
    out += cell.width === 0 ? '·' : cell.text;
  }
  return out;
});

describe('full-style snapshot at 80x24', () => {
  const STATES = ['running', 'connecting', 'stopped', 'stale', 'incompatible'] as const;
  const KINDS = ['permission_prompt', 'question', 'stalled', 'no_progress'] as const;
  const projects = STATES.map((state, index) => project(`p${index + 1}`, { state, active: index === 0, attention: index === 0 ? 4 : index === 2 ? 1 : 0 }));
  const agents = [...KINDS.map((kind) => agent(`a-${kind}`, { attention: kind, detail: `${kind} detail` })), agent('plain', { elapsed: null, detail: null })];
  const tabAgents = KINDS.map((kind) => `a-${kind}`);
  const tabAttention = new Map(KINDS.map((kind) => [`a-${kind}`, kind]));
  const BUTTONS: HeaderButton[] = [{ action: 'explorer', text: 'tasks' }, { action: 'attention', text: '! 4' }];

  function draw(sidebar: SidebarModel, focus: 'projects' | 'project' | 'agents' | null, nav: SidebarNav, activeTab: string, slotFocused: boolean, error: string | null, explorer = false): string[] {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    drawSidebarCards(frame, layout.sidebar, sidebarCardsLayout(sidebar, layout.sidebar.rows, nav, layout.sidebar.cols), { focus, theme: CLASSIC });
    const tabs = buildTabBarModel({ activeProject: 'p1', projects: [{ projectId: 'p1', tabs: tabAgents, active: activeTab }] }, tabAttention);
    const marked = withModeMarks(tabs, (id) => id === 'a-question');
    drawHeader(frame, layout.header, headerView(80, 'p1', explorer ? BUTTONS.slice(1) : BUTTONS), CLASSIC);
    drawTabBar(frame, layout.tabBar, tabBarView(explorer ? withExplorerTab(marked) : marked, layout.tabBar.cols), { slotFocused, error, theme: CLASSIC });
    drawFooter(frame, layout.footer, { mode: '[sidebar] ↑↓ move · Enter open', breadcrumb: { project: 'p1', tab: explorer ? 'tasks' : activeTab }, hints: FOOTER_HINTS, theme: CLASSIC });
    return serialiseFrame(frame);
  }

  it('projects focused: every project state, the cursor row, a notice; a permission tab active with the slot unfocused', () => {
    const sidebar = model({ projects, agents, notice: 'coordinator restarting', status: { coordinator: 'connecting', workers: null, attention: 4 } });
    expect(draw(sidebar, 'projects', { ...INITIAL_SIDEBAR_NAV, box: 'projects', projectKey: 'p5', agentKey: null }, 'a-permission_prompt', false, null)).toMatchSnapshot();
  });

  it('agents focused: every attention kind, the cursor on an attention agent; a question tab active and focused', () => {
    const sidebar = model({ projects: projects.slice(0, 2), agents, status: { coordinator: 'stale', workers: { used: 4, total: 4 }, attention: 1 } });
    expect(draw(sidebar, 'agents', { ...INITIAL_SIDEBAR_NAV, box: 'agents', projectKey: null, agentKey: 'p1/a-stalled' }, 'a-question', true, null)).toMatchSnapshot();
  });

  it('a stale agent list with the cursor on a plain agent; stalled and no-progress tabs with an error line', () => {
    const sidebar = model({ projects: projects.slice(0, 1), agents: [agents[4], agents[2], agents[3]], agentsStale: true, status: { coordinator: 'incompatible', workers: { used: 0, total: 2 }, attention: 0 } });
    expect(draw(sidebar, 'agents', { ...INITIAL_SIDEBAR_NAV, box: 'agents', projectKey: null, agentKey: 'p1/plain' }, 'a-stalled', true, 'The master tab stays open.')).toMatchSnapshot();
  });

  it('no focus, a stopped coordinator with no agents; the explorer tab shown', () => {
    const sidebar = model({ projects: [project('p1', { state: 'stopped', connection: 'stopped', active: true })], agents: [], status: { coordinator: 'stopped', workers: null, attention: 0 } });
    expect(draw(sidebar, null, INITIAL_SIDEBAR_NAV, 'a-no_progress', false, null, true)).toMatchSnapshot();
  });
});
