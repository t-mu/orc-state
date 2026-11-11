import { describe, expect, it } from 'vitest';
import { stringWidth } from '../cellWidth.ts';
import type { SidebarAgent, SidebarModel, SidebarProject } from '../tui/sidebar.ts';
import { fitText } from '../tui/sidebar.ts';
import { CLOSE_MARKER, buildTabBarModel, layoutTabBar, tabBarClickTarget, type TabBarState } from '../tui/tabBarModel.ts';
import { computeLayout } from './app.ts';
import { createFrame, type Frame } from './frame.ts';
import { BUILT_IN_THEMES, styleOf } from './theme.ts';
import {
  EXPLORER_TAB, INITIAL_SIDEBAR_NAV, TYPING_MARK, VIEW_MARK, HEADER_MARK, drawFooter, drawHeader, drawSidebar, drawTabBar, headerButtonAt, headerView, navigateSidebar, sidebarClick,
  sidebarView, tabBarView, withExplorerTab, withModeMarks, type FooterHint, type HeaderButton, type SidebarNav,
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

function renderSidebar(cols: number, rows: number, sidebar: SidebarModel, focus: 'projects' | 'agents' | null = null, nav: SidebarNav = INITIAL_SIDEBAR_NAV) {
  const layout = computeLayout(cols, rows);
  const frame = createFrame(cols, rows);
  const view = sidebarView(sidebar, layout.sidebar.rows, nav);
  drawSidebar(frame, layout.sidebar, view, { focus, theme: CLASSIC });
  // The sidebar's rows (row 0 is its first, below the header).
  const lines = Array.from({ length: layout.sidebar.rows }, (_, y) => rowText(frame, layout.sidebar.y + y, 0, layout.sidebar.cols));
  return { frame, layout, view, lines };
}

describe('drawSidebar', () => {
  for (const [cols, rows] of [[80, 24], [200, 60]] as const) {
    it(`draws the status, projects and agents boxes and no footer row at ${cols}x${rows}, wide names in their display width`, () => {
      const { frame, lines, layout } = renderSidebar(cols, rows, model());
      const width = layout.sidebar.cols;
      expect(width).toBe(34);
      expect(lines[0]).toBe(`╭─ Status ${'─'.repeat(width - 11)}╮`);
      expect(lines[1]).toContain('coordinator running');
      expect(lines[2]).toMatch(/^│workers 3\/4 +1 needs you│$/);
      expect(lines[4]).toMatch(/^╭─ Projects ─+╮$/);
      // `▸` marks the active project; its CJK name takes two columns a character, then state and badge flush right.
      expect(lines[5]).toBe(`│▸ ${CJK_PROJECT}${' '.repeat(width - 4 - stringWidth(CJK_PROJECT) - 'running !1'.length)}running !1│`);
      expect(lines[6]).toMatch(/^│ {2}p2 +stopped│$/);
      expect(lines[8]).toContain(`╭─ Agents · ${CJK_PROJECT.slice(0, 7)}`);
      // An agent needing attention sorts first with its badge; the emoji takes two columns.
      expect(lines[9]).toBe(`│${EMOJI_AGENT}${' '.repeat(width - 2 - stringWidth(EMOJI_AGENT) - ' QUESTION 12m'.length)} QUESTION 12m│`);
      expect(lines[10]).toBe('│  ? 本当に続けますか            │');
      expect(lines[11]).toContain(CJK_AGENT);
      // A long wide-character detail is cut with `…`, never half a character.
      expect(lines[12]).toBe('│  日本語のテキストがとても長い… │');
      expect(layout.sidebar.rows).toBe(rows - 2); // between the header and the footer
      expect(lines.some((line) => line.includes('[master]'))).toBe(false); // the mode is the footer's
      // Every box row ends on the right border and takes exactly the sidebar's width: no wide character was split or overflowed.
      for (let y = 0; y < 16; y += 1) {
        expect([...lines[y]].at(-1)).toMatch(/[╮│╯]/);
        expect(stringWidth(lines[y])).toBe(width);
        expect(frame.cells[(layout.sidebar.y + y) * cols + width].text).toBe(' '); // nothing spilled into the slot
      }
    });
  }

  it('marks the focused box: its title reversed, its border coloured, the cursor row reversed', () => {
    const projectsFocused = renderSidebar(80, 24, model(), 'projects');
    const titleCell = projectsFocused.frame.cells[5 * 80 + 3]; // `P` of `Projects`
    expect(titleCell.text).toBe('P');
    expect(titleCell.style.inverse).toBe(true);
    expect(projectsFocused.frame.cells[6 * 80 + 2].style.inverse).toBe(true); // the active project's row is the cursor
    expect(projectsFocused.frame.cells[9 * 80 + 3].style.inverse).toBe(false); // agents title

    const agentsFocused = renderSidebar(80, 24, model(), 'agents', { ...INITIAL_SIDEBAR_NAV, agentKey: `p1/${CJK_AGENT}` });
    expect(agentsFocused.frame.cells[5 * 80 + 3].style.inverse).toBe(false);
    expect(agentsFocused.frame.cells[9 * 80 + 3].style.inverse).toBe(true);
    expect(agentsFocused.frame.cells[12 * 80 + 1].style.inverse).toBe(true); // the cursor agent's first row
    expect(agentsFocused.frame.cells[10 * 80 + 1].style.inverse).toBe(false);

    const unfocused = renderSidebar(80, 24, model(), null);
    expect(unfocused.frame.cells.slice(0, 80 * 24).filter((_, index) => index % 80 < 34).some((cell) => cell.style.inverse && cell.text !== ' ' && cell.text !== '')).toBe(true); // the attention badge only
    expect(unfocused.frame.cells[5 * 80 + 3].style.inverse).toBe(false);
  });

  it('keeps a `+N more` row and the cursor in view when the agents do not fit 80x24', () => {
    const agents = Array.from({ length: 20 }, (_, index) => agent(`w${index + 1}`));
    const nav = { ...INITIAL_SIDEBAR_NAV, agentKey: 'p1/w15' };
    const { lines, view } = renderSidebar(80, 24, model({ agents }), 'agents', nav);
    expect(lines.some((line) => /\+\d+ more/.test(line))).toBe(true);
    expect(view.layout.agents).toContain(14);
    expect(lines.some((line) => line.includes('w15 '))).toBe(true);
    // No footer row is kept: the agents box may end on the sidebar's last row (two-row agents leave at most one spare).
    expect(lines.slice(-2).some((line) => /^╰─+╯$/.test(line))).toBe(true);
  });

  it('says why there are no agents', () => {
    const stopped = model({ agents: [], projects: [project('p1', { active: true, state: 'stopped', connection: 'stopped' })] });
    expect(renderSidebar(80, 24, stopped).lines.join('\n')).toContain('(coordinator not running)');
    expect(renderSidebar(80, 24, model({ agents: [] })).lines.join('\n')).toContain('(no live agents)');
  });
});

describe('sidebar navigation', () => {
  const view = (nav: SidebarNav) => sidebarView(model(), 23, nav);

  it('moves the cursor with up and down, stopping at either end', () => {
    let nav: SidebarNav = INITIAL_SIDEBAR_NAV;
    nav = navigateSidebar(view(nav), nav, 'up').nav;
    expect(nav.agentKey).toBe(`p1/${EMOJI_AGENT}`);
    for (let i = 0; i < 5; i += 1) nav = navigateSidebar(view(nav), nav, 'down').nav;
    expect(nav.agentKey).toBe('p1/w3');
  });

  it('switches boxes with Tab, opens with Enter and returns to the pane with Esc', () => {
    let nav: SidebarNav = INITIAL_SIDEBAR_NAV;
    let step = navigateSidebar(view(nav), nav, 'down');
    expect(step.command).toBeNull();
    nav = step.nav;
    step = navigateSidebar(view(nav), nav, 'open');
    expect(step.command).toEqual({ type: 'openAgent', projectId: 'p1', agentId: CJK_AGENT });

    step = navigateSidebar(view(nav), nav, 'switchBox');
    expect(step.nav.box).toBe('projects');
    nav = navigateSidebar(view(step.nav), step.nav, 'down').nav;
    step = navigateSidebar(view(nav), nav, 'open');
    expect(step.command).toEqual({ type: 'openProject', projectId: 'p2' });
    expect(step.nav.agentKey).toBeNull(); // another project's agents start at the top

    expect(navigateSidebar(view(nav), nav, 'back')).toEqual({ nav, command: { type: 'focusSlot' } });
    expect(navigateSidebar(view(nav), { ...nav, box: 'projects' }, 'switchBox').nav.box).toBe('agents');
  });

  it('opens nothing in an empty box', () => {
    const empty = sidebarView(model({ agents: [] }), 23, INITIAL_SIDEBAR_NAV);
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'open').command).toBeNull();
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'down').nav).toEqual(INITIAL_SIDEBAR_NAV);
  });
});

describe('sidebarClick (hit-testing sidebar rows)', () => {
  for (const [cols, rows] of [[80, 24], [200, 60]] as const) {
    it(`opens the project or agent under a click at ${cols}x${rows}, on either of an agent's rows`, () => {
      const { lines, view } = renderSidebar(cols, rows, model());
      const rowOf = (part: string) => lines.findIndex((line) => line.includes(part));
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, rowOf(CJK_PROJECT))?.command).toEqual({ type: 'openProject', projectId: 'p1' });
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, rowOf('p2'))?.command).toEqual({ type: 'openProject', projectId: 'p2' });
      const emoji = sidebarClick(view, INITIAL_SIDEBAR_NAV, rowOf(EMOJI_AGENT));
      expect(emoji).toEqual({ nav: { box: 'agents', projectKey: null, agentKey: `p1/${EMOJI_AGENT}` }, command: { type: 'openAgent', projectId: 'p1', agentId: EMOJI_AGENT } });
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, rowOf(EMOJI_AGENT) + 1)?.command).toEqual(emoji?.command);
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, rowOf('w3 '))?.command).toEqual({ type: 'openAgent', projectId: 'p1', agentId: 'w3' });
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, rowOf('Projects'))).toBeNull(); // a border
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, 1)).toBeNull(); // the status box
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, rows - 3)).toBeNull(); // the last row: the agents box's border
    });
  }
});

// ── tab bar ──────────────────────────────────────────────────────────────────

const TABS: TabBarState = { activeProject: 'p1', projects: [{ projectId: 'p1', tabs: [CJK_AGENT, EMOJI_AGENT, 'w3'], active: CJK_AGENT }] };

function renderTabBar(cols: number, rows: number, state: TabBarState = TABS, slotFocused = true, typing = new Set([EMOJI_AGENT])) {
  const layout = computeLayout(cols, rows);
  const frame = createFrame(cols, rows);
  const bar = tabBarView(withModeMarks(buildTabBarModel(state, new Map([['w3', 'permission_prompt' as const]])), (id) => typing.has(id)), layout.tabBar.cols);
  drawTabBar(frame, layout.tabBar, bar, { slotFocused, error: null, theme: CLASSIC });
  const lines = [0, 1, 2].map((y) => rowText(frame, layout.tabBar.y + y, layout.tabBar.x, layout.tabBar.cols));
  return { frame, layout, bar, lines };
}

describe('drawTabBar', () => {
  it('draws every tab at 200x60 with mode marks, badges and close markers, wide names in their display width', () => {
    const { lines, bar, layout } = renderTabBar(200, 60);
    expect(lines[1]).toContain(` 1 master │`);
    expect(lines[1]).toContain(` 2 ${VIEW_MARK} ${CJK_AGENT} ${CLOSE_MARKER} │`);
    expect(lines[1]).toContain(` 3 ${TYPING_MARK} ${EMOJI_AGENT} ${CLOSE_MARKER} │`);
    expect(lines[1]).toContain(` 4 ${VIEW_MARK} w3 PERMISSION ${CLOSE_MARKER} │`);
    expect(lines[1]).not.toContain('quit'); // the quit key is in the footer
    // Each tab's borders line up across the three rows: display widths, not string lengths.
    for (const cell of bar.layout.cells) {
      expect(columnOf(lines[0], cell.x)).toBe('╭');
      expect(columnOf(lines[1], cell.x)).toBe('│');
      expect(columnOf(lines[1], cell.x + cell.width - 1)).toBe('│');
    }
    expect(bar.layout.cells.map((cell) => cell.width)).toEqual(bar.model.tabs.map((tab) => 2 + stringWidth(` ${tab.number} ${tab.label}`) + (tab.attention ? ' PERMISSION'.length : 0) + (tab.closable ? 3 : 1)));
    expect(layout.tabBar.rows).toBe(3);
  });

  it('opens the active tab towards the slot and marks it as the focus', () => {
    const focused = renderTabBar(200, 60);
    const active = focused.bar.layout.cells[1];
    const x = focused.layout.tabBar.x + active.x;
    expect(focused.frame.cells[3 * 200 + x].text).toBe('╯');
    expect(focused.frame.cells[2 * 200 + x + 2].style.inverse).toBe(true); // its label
    expect(focused.frame.cells[2 * 200 + x].style.bold).toBe(true); // its border
    const unfocused = renderTabBar(200, 60, TABS, false);
    expect(unfocused.frame.cells[2 * 200 + x + 2].style.inverse).toBe(false);
    expect(unfocused.frame.cells[2 * 200 + x + 2].style.bold).toBe(true); // still the active tab
  });

  it('fits 80x24 with overflow markers and the active tab always shown, the tabs taking the full width', () => {
    const { lines, bar } = renderTabBar(80, 24);
    expect(bar.layout.hiddenLeft + bar.layout.hiddenRight).toBeGreaterThan(0);
    expect(bar.layout.cells.some((cell) => cell.index === 1)).toBe(true);
    for (const line of lines) expect(stringWidth(line)).toBe(46);
    expect(bar.layout).toEqual(layoutTabBar(bar.model, 46)); // nothing reserved for buttons or a hint
    expect(lines[1]).not.toContain('quit');
    expect(lines[1]).not.toContain('tasks');
  });

  it('shows the error on the bottom row and a notice without tabs', () => {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    drawTabBar(frame, layout.tabBar, tabBarView(buildTabBarModel(TABS), 46), { slotFocused: true, error: 'The master tab stays open.', theme: CLASSIC });
    expect(rowText(frame, 3, 34, 46).trimEnd()).toBe('The master tab stays open.');
    const empty = createFrame(80, 24);
    drawTabBar(empty, layout.tabBar, tabBarView(buildTabBarModel({ activeProject: null, projects: [] }), 46), { slotFocused: true, error: null, theme: CLASSIC });
    expect(rowText(empty, 2, 34, 46)).toContain('No project is open');
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

describe('tab bar hit-testing', () => {
  for (const [cols, rows] of [[80, 24], [200, 60]] as const) {
    it(`selects a tab on its label and closes it on its close marker at ${cols}x${rows}`, () => {
      const { lines, bar } = renderTabBar(cols, rows);
      for (const cell of bar.layout.cells) {
        const tab = bar.model.tabs[cell.index];
        expect(tabBarClickTarget(bar.model, bar.layout, cell.x + 1)).toEqual({ kind: 'select', tab });
        if (cell.closeX === null) continue;
        // The drawn `×` is where the hit-test puts it, even after a wide name.
        expect(columnOf(lines[1], cell.closeX)).toBe(CLOSE_MARKER);
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

  it('drops segments from the right as the width shrinks; the mode always comes first', () => {
    const fullWidth = stringWidth(FULL);
    expect(footer(fullWidth).line).toBe(FULL);
    expect(footer(fullWidth - 1).line).toBe(`${MODE} · ${CJK_PROJECT} › w1 · Ctrl-q: quit · F10: dashboard`);
    expect(footer(80).line).toBe(`${MODE} · ${CJK_PROJECT} › w1 · Ctrl-q: quit`);
    expect(footer(60).line).toBe(`${MODE} · ${CJK_PROJECT} › w1`);
    expect(footer(40).line).toBe(MODE);
    // The mode is cut last, by display width.
    expect(footer(12).line).toBe(`${MODE.slice(0, 11)}…`);
    expect(stringWidth(footer(12).line)).toBe(12);
    // No project open: the hints follow the mode.
    expect(footer(80, MODE, null).line).toBe(`${MODE} · Ctrl-q: quit · F10: dashboard · F11: attention`);
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
    const layout = computeLayout(30, 7);
    const frame = createFrame(30, 7);
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

  function draw(sidebar: SidebarModel, focus: 'projects' | 'agents' | null, nav: SidebarNav, activeTab: string, slotFocused: boolean, error: string | null, explorer = false): string[] {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    drawSidebar(frame, layout.sidebar, sidebarView(sidebar, layout.sidebar.rows, nav), { focus, theme: CLASSIC });
    const tabs = buildTabBarModel({ activeProject: 'p1', projects: [{ projectId: 'p1', tabs: tabAgents, active: activeTab }] }, tabAttention);
    const marked = withModeMarks(tabs, (id) => id === 'a-question');
    drawHeader(frame, layout.header, headerView(80, 'p1', explorer ? BUTTONS.slice(1) : BUTTONS), CLASSIC);
    drawTabBar(frame, layout.tabBar, tabBarView(explorer ? withExplorerTab(marked) : marked, layout.tabBar.cols), { slotFocused, error, theme: CLASSIC });
    drawFooter(frame, layout.footer, { mode: '[sidebar] ↑↓ move · Enter open', breadcrumb: { project: 'p1', tab: explorer ? 'tasks' : activeTab }, hints: FOOTER_HINTS, theme: CLASSIC });
    return serialiseFrame(frame);
  }

  it('projects focused: every project state, the cursor row, a notice; a permission tab active with the slot unfocused', () => {
    const sidebar = model({ projects, agents, notice: 'coordinator restarting', status: { coordinator: 'connecting', workers: null, attention: 4 } });
    expect(draw(sidebar, 'projects', { box: 'projects', projectKey: 'p5', agentKey: null }, 'a-permission_prompt', false, null)).toMatchSnapshot();
  });

  it('agents focused: every attention kind, the cursor on an attention agent; a question tab active and focused', () => {
    const sidebar = model({ projects: projects.slice(0, 2), agents, status: { coordinator: 'stale', workers: { used: 4, total: 4 }, attention: 1 } });
    expect(draw(sidebar, 'agents', { box: 'agents', projectKey: null, agentKey: 'p1/a-stalled' }, 'a-question', true, null)).toMatchSnapshot();
  });

  it('a stale agent list with the cursor on a plain agent; stalled and no-progress tabs with an error line', () => {
    const sidebar = model({ projects: projects.slice(0, 1), agents: [agents[4], agents[2], agents[3]], agentsStale: true, status: { coordinator: 'incompatible', workers: { used: 0, total: 2 }, attention: 0 } });
    expect(draw(sidebar, 'agents', { box: 'agents', projectKey: null, agentKey: 'p1/plain' }, 'a-stalled', true, 'The master tab stays open.')).toMatchSnapshot();
  });

  it('no focus, a stopped coordinator with no agents; the explorer tab shown', () => {
    const sidebar = model({ projects: [project('p1', { state: 'stopped', connection: 'stopped', active: true })], agents: [], status: { coordinator: 'stopped', workers: null, attention: 0 } });
    expect(draw(sidebar, null, INITIAL_SIDEBAR_NAV, 'a-no_progress', false, null, true)).toMatchSnapshot();
  });
});

describe('drawing with amber, the running cockpit theme', () => {
  const AMBER = BUILT_IN_THEMES.amber;
  /** The cell where `part` starts in `frame` (the first match, top to bottom). */
  const cellOf = (frame: Frame, part: string) => {
    for (let y = 0; y < frame.rows; y += 1) {
      for (let x = 0; x < frame.cols; x += 1) {
        if (rowText(frame, y, x).startsWith(part)) return frame.cells[y * frame.cols + x];
      }
    }
    throw new Error(`${part} not drawn`);
  };

  it('draws borders, badges and counts from the amber roles', () => {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    const view = sidebarView(model(), layout.sidebar.rows, INITIAL_SIDEBAR_NAV);
    drawSidebar(frame, layout.sidebar, view, { focus: 'projects', theme: AMBER });
    expect(cellOf(frame, '╭─ Projects').style).toEqual(styleOf(AMBER, 'chrome.borderFocus'));
    expect(cellOf(frame, '1 needs you').style).toEqual(styleOf(AMBER, 'status.attention.badge'));
    expect(cellOf(frame, 'QUESTION').style).toEqual(styleOf(AMBER, 'status.attention.badge'));
  });

  it('keeps the state colours on the cursor row, the rest in row.cursor', () => {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    const view = sidebarView(model(), layout.sidebar.rows, INITIAL_SIDEBAR_NAV);
    drawSidebar(frame, layout.sidebar, view, { focus: 'agents', theme: AMBER }); // the cursor on the question agent
    const badge = styleOf(AMBER, 'status.attention.badge');
    expect(cellOf(frame, 'QUESTION').style).toEqual({ ...badge, bold: true });
    const cursor = styleOf(AMBER, 'row.cursor');
    expect(cellOf(frame, EMOJI_AGENT).style).toMatchObject({ fg: cursor.fg, bg: cursor.bg, bold: true });
  });

  it('fills the cursor bar under a project state, which keeps its colour', () => {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    const view = sidebarView(model(), layout.sidebar.rows, INITIAL_SIDEBAR_NAV);
    drawSidebar(frame, layout.sidebar, view, { focus: 'projects', theme: AMBER }); // the cursor on the active project
    const y = Array.from({ length: frame.rows }, (_, row) => row).find((row) => rowText(frame, row).includes(CJK_PROJECT))!;
    const x = rowText(frame, y).indexOf('running');
    const cursor = styleOf(AMBER, 'row.cursor');
    // The cell's index: rowText joins cell texts, and the CJK name's continuation cells add nothing.
    const cells = frame.cells.slice(y * frame.cols, (y + 1) * frame.cols);
    let seen = 0;
    const state = cells.find((cell) => { const at = seen; seen += cell.text.length; return at === x; })!;
    expect(state.text).toBe('r');
    expect(state.style).toMatchObject({ fg: styleOf(AMBER, 'status.active').fg, bg: cursor.bg, bold: true });
    expect(cellOf(frame, '1 needs you').style.bg).toEqual(styleOf(AMBER, 'status.attention.badge').bg);
  });
});
