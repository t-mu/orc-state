import { describe, expect, it } from 'vitest';
import { stringWidth } from '../cellWidth.ts';
import type { SidebarAgent, SidebarModel, SidebarProject } from '../tui/sidebar.ts';
import { CLOSE_MARKER, buildTabBarModel, tabBarClickTarget, type TabBarState } from '../tui/tabBarModel.ts';
import { computeLayout } from './app.ts';
import { createFrame, type Frame } from './frame.ts';
import {
  EXPLORER_TAB, INITIAL_SIDEBAR_NAV, TYPING_MARK, VIEW_MARK, drawSidebar, drawTabBar, navigateSidebar, sidebarClick, sidebarView, tabBarButtonAt,
  tabBarView, withExplorerTab, withModeMarks, type SidebarNav, type TabBarButton,
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

describe('tab bar buttons and the explorer tab', () => {
  const BUTTONS: TabBarButton[] = [{ action: 'explorer', text: 'tasks' }, { action: 'attention', text: '! 2' }];

  for (const [cols, rows] of [[80, 24], [200, 60]] as const) {
    it(`draws the tasks entry and the attention badge left of the quit hint and hit-tests them at ${cols}x${rows}`, () => {
      const layout = computeLayout(cols, rows);
      const frame = createFrame(cols, rows);
      const bar = tabBarView(buildTabBarModel(TABS), layout.tabBar.cols, 'Ctrl-q: quit', BUTTONS);
      drawTabBar(frame, layout.tabBar, bar, { slotFocused: true, error: null });
      const line = rowText(frame, 1, layout.tabBar.x, layout.tabBar.cols);
      expect(line.endsWith(' tasks ! 2 Ctrl-q: quit')).toBe(true);
      expect(stringWidth(line)).toBe(layout.tabBar.cols);
      // The tabs end before the buttons.
      const used = stringWidth(bar.layout.leftMarker) + bar.layout.cells.reduce((sum, cell) => sum + cell.width, 0) + stringWidth(bar.layout.rightMarker);
      expect(used).toBeLessThan(bar.buttons[0].x);
      const tasks = bar.buttons[0].x;
      const badge = bar.buttons[1].x;
      expect([tasks, tasks + 4].map((x) => tabBarButtonAt(bar, x))).toEqual(['explorer', 'explorer']);
      expect([badge, badge + 2].map((x) => tabBarButtonAt(bar, x))).toEqual(['attention', 'attention']);
      expect(tabBarButtonAt(bar, tasks - 1)).toBeNull();
      expect(tabBarButtonAt(bar, layout.tabBar.cols - 1)).toBeNull(); // the quit hint
      expect(frame.cells[1 * cols + layout.tabBar.x + badge].style.inverse).toBe(true);
    });
  }

  it('drops the buttons, the first given first, before the quit hint on a narrow bar, and has none without a project', () => {
    expect(tabBarView(buildTabBarModel(TABS), 40, 'Ctrl-q: quit', BUTTONS).buttons.map((button) => button.action)).toEqual(['attention']);
    expect(tabBarView(buildTabBarModel(TABS), 37, 'Ctrl-q: quit', [BUTTONS[0]])).toMatchObject({ buttons: [], hint: 'Ctrl-q: quit' });
    expect(tabBarView(buildTabBarModel(TABS), 36, 'Ctrl-q: quit', BUTTONS)).toMatchObject({ buttons: [], hint: null });
    expect(tabBarView(buildTabBarModel({ activeProject: null, projects: [] }), 46, 'x', BUTTONS).buttons).toEqual([]);
  });

  it('shows the explorer as the active, closable tab after the project\'s tabs', () => {
    const model = withExplorerTab(buildTabBarModel(TABS));
    expect(model.tabs.map((tab) => [tab.label, tab.active])).toEqual([['master', false], [CJK_AGENT, false], [EMOJI_AGENT, false], ['w3', false], ['tasks', true]]);
    expect(model.tabs.at(-1)).toMatchObject({ agentId: EXPLORER_TAB, number: 5, closable: true });
    const bar = tabBarView(model, 200, null);
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
  const BUTTONS: TabBarButton[] = [{ action: 'explorer', text: 'tasks' }, { action: 'attention', text: '! 4' }];

  function draw(sidebar: SidebarModel, focus: 'projects' | 'agents' | null, nav: SidebarNav, activeTab: string, slotFocused: boolean, error: string | null, explorer = false): string[] {
    const layout = computeLayout(80, 24);
    const frame = createFrame(80, 24);
    drawSidebar(frame, layout.sidebar, sidebarView(sidebar, layout.sidebar.rows, nav), { focus, footer: '[sidebar] ↑↓ move · Enter open' });
    const tabs = buildTabBarModel({ activeProject: 'p1', projects: [{ projectId: 'p1', tabs: tabAgents, active: activeTab }] }, tabAttention);
    const marked = withModeMarks(tabs, (id) => id === 'a-question');
    drawTabBar(frame, layout.tabBar, tabBarView(explorer ? withExplorerTab(marked) : marked, layout.tabBar.cols, 'Ctrl-q: quit', BUTTONS), { slotFocused, error });
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
