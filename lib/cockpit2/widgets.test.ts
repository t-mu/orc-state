import { describe, expect, it } from 'vitest';
import { stringWidth } from '../cellWidth.ts';
import type { SidebarAgent, SidebarModel, SidebarProject } from '../tui/sidebar.ts';
import { CLOSE_MARKER, buildTabBarModel, tabBarClickTarget, type TabBarState } from '../tui/tabBarModel.ts';
import { computeLayout } from './app.ts';
import { createFrame, type Frame } from './frame.ts';
import {
  INITIAL_SIDEBAR_NAV, TYPING_MARK, VIEW_MARK, drawSidebar, drawTabBar, navigateSidebar, sidebarClick, sidebarView, tabBarView, withModeMarks,
  type SidebarNav,
} from './widgets.ts';

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
  drawSidebar(frame, layout.sidebar, view, { focus, footer: '[master] keys go to the master' });
  const lines = Array.from({ length: rows }, (_, y) => rowText(frame, y, 0, layout.sidebar.cols));
  return { frame, layout, view, lines };
}

describe('drawSidebar', () => {
  for (const [cols, rows] of [[80, 24], [200, 60]] as const) {
    it(`draws the status, projects and agents boxes and the footer at ${cols}x${rows}, wide names in their display width`, () => {
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
      expect(lines[rows - 1]).toBe('[master] keys go to the master    ');
      // Every box row ends on the right border and takes exactly the sidebar's width: no wide character was split or overflowed.
      for (let y = 0; y < 16; y += 1) {
        expect([...lines[y]].at(-1)).toMatch(/[╮│╯]/);
        expect(stringWidth(lines[y])).toBe(width);
        expect(frame.cells[y * cols + width].text).toBe(' '); // nothing spilled into the slot
      }
    });
  }

  it('marks the focused box: its title reversed, its border coloured, the cursor row reversed', () => {
    const projectsFocused = renderSidebar(80, 24, model(), 'projects');
    const titleCell = projectsFocused.frame.cells[4 * 80 + 3]; // `P` of `Projects`
    expect(titleCell.text).toBe('P');
    expect(titleCell.style.inverse).toBe(true);
    expect(projectsFocused.frame.cells[5 * 80 + 2].style.inverse).toBe(true); // the active project's row is the cursor
    expect(projectsFocused.frame.cells[8 * 80 + 3].style.inverse).toBe(false); // agents title

    const agentsFocused = renderSidebar(80, 24, model(), 'agents', { ...INITIAL_SIDEBAR_NAV, agentKey: `p1/${CJK_AGENT}` });
    expect(agentsFocused.frame.cells[4 * 80 + 3].style.inverse).toBe(false);
    expect(agentsFocused.frame.cells[8 * 80 + 3].style.inverse).toBe(true);
    expect(agentsFocused.frame.cells[11 * 80 + 1].style.inverse).toBe(true); // the cursor agent's first row
    expect(agentsFocused.frame.cells[9 * 80 + 1].style.inverse).toBe(false);

    const unfocused = renderSidebar(80, 24, model(), null);
    expect(unfocused.frame.cells.slice(0, 34 * 24).some((cell) => cell.style.inverse && cell.text !== ' ' && cell.text !== '')).toBe(true); // the attention badge only
    expect(unfocused.frame.cells[4 * 80 + 3].style.inverse).toBe(false);
  });

  it('keeps a `+N more` row and the cursor in view when the agents do not fit 80x24', () => {
    const agents = Array.from({ length: 20 }, (_, index) => agent(`w${index + 1}`));
    const nav = { ...INITIAL_SIDEBAR_NAV, agentKey: 'p1/w15' };
    const { lines, view } = renderSidebar(80, 24, model({ agents }), 'agents', nav);
    expect(lines.some((line) => /\+\d+ more/.test(line))).toBe(true);
    expect(view.layout.agents).toContain(14);
    expect(lines.some((line) => line.includes('w15 '))).toBe(true);
    expect(lines[23]).toContain('[master]');
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
      expect(sidebarClick(view, INITIAL_SIDEBAR_NAV, rows - 1)).toBeNull(); // the footer
    });
  }
});

// ── tab bar ──────────────────────────────────────────────────────────────────

const TABS: TabBarState = { activeProject: 'p1', projects: [{ projectId: 'p1', tabs: [CJK_AGENT, EMOJI_AGENT, 'w3'], active: CJK_AGENT }] };

function renderTabBar(cols: number, rows: number, state: TabBarState = TABS, slotFocused = true, typing = new Set([EMOJI_AGENT])) {
  const layout = computeLayout(cols, rows);
  const frame = createFrame(cols, rows);
  const bar = tabBarView(withModeMarks(buildTabBarModel(state, new Map([['w3', 'permission_prompt' as const]])), (id) => typing.has(id)), layout.tabBar.cols, 'Ctrl-q: quit');
  drawTabBar(frame, layout.tabBar, bar, { slotFocused, error: null });
  const lines = [0, 1, 2].map((y) => rowText(frame, y, layout.tabBar.x, layout.tabBar.cols));
  return { frame, layout, bar, lines };
}

describe('drawTabBar', () => {
  it('draws every tab at 200x60 with mode marks, badges and close markers, wide names in their display width', () => {
    const { lines, bar, layout } = renderTabBar(200, 60);
    expect(lines[1]).toContain(` 1 master │`);
    expect(lines[1]).toContain(` 2 ${VIEW_MARK} ${CJK_AGENT} ${CLOSE_MARKER} │`);
    expect(lines[1]).toContain(` 3 ${TYPING_MARK} ${EMOJI_AGENT} ${CLOSE_MARKER} │`);
    expect(lines[1]).toContain(` 4 ${VIEW_MARK} w3 PERMISSION ${CLOSE_MARKER} │`);
    expect(lines[1].trimEnd().endsWith('Ctrl-q: quit')).toBe(true);
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
    expect(focused.frame.cells[2 * 200 + x].text).toBe('╯');
    expect(focused.frame.cells[1 * 200 + x + 2].style.inverse).toBe(true); // its label
    expect(focused.frame.cells[1 * 200 + x].style.bold).toBe(true); // its border
    const unfocused = renderTabBar(200, 60, TABS, false);
    expect(unfocused.frame.cells[1 * 200 + x + 2].style.inverse).toBe(false);
    expect(unfocused.frame.cells[1 * 200 + x + 2].style.bold).toBe(true); // still the active tab
  });

  it('fits 80x24 with overflow markers, the active tab always shown and the quit hint kept in view', () => {
    const { lines, bar } = renderTabBar(80, 24);
    expect(bar.layout.hiddenLeft + bar.layout.hiddenRight).toBeGreaterThan(0);
    expect(bar.layout.cells.some((cell) => cell.index === 1)).toBe(true);
    expect(lines[1]).toMatch(/^‹ 1 .* 2 › +Ctrl-q: quit$/); // the master tab left of the shown one, two tabs right of it
    for (const line of lines) expect(stringWidth(line)).toBe(46);
    expect(lines[1].endsWith(' Ctrl-q: quit')).toBe(true);
    expect(lines[1]).not.toContain('│Ctrl-q'); // the tabs end before it
    // A bar too narrow for both keeps the tabs.
    expect(tabBarView(buildTabBarModel(TABS), 30, 'Ctrl-q: quit').hint).toBeNull();
  });

  it('shows the error on the bottom row and a notice without tabs', () => {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    drawTabBar(frame, layout.tabBar, tabBarView(buildTabBarModel(TABS), 46), { slotFocused: true, error: 'The master tab stays open.' });
    expect(rowText(frame, 2, 34, 46).trimEnd()).toBe('The master tab stays open.');
    const empty = createFrame(80, 24);
    drawTabBar(empty, layout.tabBar, tabBarView(buildTabBarModel({ activeProject: null, projects: [] }), 46, 'x'), { slotFocused: true, error: null });
    expect(rowText(empty, 1, 34, 46)).toContain('No project is open');
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
