import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringWidth } from '../cellWidth.ts';
import type { SidebarAgent, SidebarModel, SidebarProject } from '../tui/sidebar.ts';
import { computeLayout } from './app.ts';
import { createFrame, type Frame } from './frame.ts';
import {
  INITIAL_SIDEBAR_NAV, agentStatusRole, drawSidebarCards, navigateSidebar, pruneExpanded, sidebarCardClick, sidebarCardTarget, sidebarCardsLayout, sidebarCursor,
  type CardLayout, type SidebarCard, type SidebarCardsLayout, type SidebarNav,
} from './sidebarCards.ts';
import { BUILT_IN_THEMES, styleOf } from './theme.ts';

const CLASSIC = BUILT_IN_THEMES.classic;
const AMBER = BUILT_IN_THEMES.amber;
const COLS = 34;
const CJK_PROJECT = '日本語プロジェクト';
const EMOJI_AGENT = 'agent-🚀-rocket';

function project(id: string, overrides: Partial<SidebarProject> = {}): SidebarProject {
  return {
    project_id: id, name: id, state_dir: `/state/${id}`, target_repo_root: `/repo/${id}`,
    connection: 'running', state: 'running', error: null, attention: 0, active: false, ...overrides,
  };
}

function agent(id: string, overrides: Partial<SidebarAgent> = {}): SidebarAgent {
  return { key: `p1/${id}`, agent_id: id, role: 'worker', phase: 'implement', elapsed: '12m', detail: `working on ${id}`, attention: null, ...overrides };
}

/** `others` other projects after the active p1, and `agents` agents, every third needing attention. */
function model(others = 1, agents = 3, overrides: Partial<SidebarModel> = {}): SidebarModel {
  return {
    status: { coordinator: 'running', workers: { used: 2, total: 4 }, attention: 1 },
    projects: [
      project('p1', { name: 'orc-state', active: true }),
      ...Array.from({ length: others }, (_, index) => project(`o${index + 1}`, { state: 'stopped', connection: 'stopped', attention: index === 0 ? 2 : 0 })),
    ],
    activeProjectId: 'p1',
    agents: Array.from({ length: agents }, (_, index) => agent(`a${index + 1}`, index % 3 === 0 ? { attention: 'question', detail: `? question ${index + 1}` } : {})),
    agentsStale: false,
    notice: null,
    ...overrides,
  };
}

const card = (layout: SidebarCardsLayout, name: SidebarCard): CardLayout | undefined => layout.cards.find((each) => each.card === name);
const rowsOf = (layout: SidebarCardsLayout) => layout.cards.map((each) => each.rows);

/** Row `y` of `frame` from column `x`, `cols` wide, as text (a wide grapheme's continuation cell adds nothing). */
const rowText = (frame: Frame, y: number, x = 0, cols = frame.cols) =>
  frame.cells.slice(y * frame.cols + x, y * frame.cols + x + cols).map((cell) => cell.text).join('');

function render(sidebar: SidebarModel, options: { rows?: number; focus?: 'projects' | 'agents' | null; nav?: SidebarNav; theme?: typeof CLASSIC } = {}) {
  const rows = options.rows ?? 22;
  const frame = createFrame(COLS, rows);
  const layout = sidebarCardsLayout(sidebar, rows, options.nav ?? INITIAL_SIDEBAR_NAV, COLS);
  drawSidebarCards(frame, { x: 0, y: 0, cols: COLS, rows }, layout, { focus: options.focus ?? null, theme: options.theme ?? CLASSIC });
  const lines = Array.from({ length: rows }, (_, y) => rowText(frame, y));
  return { frame, layout, lines };
}

/** The sidebar row `line` of `name` is on, or -1 when it is not shown. */
function rowOfLine(layout: SidebarCardsLayout, name: SidebarCard, match: (line: CardLayout['lines'][number]) => boolean): number {
  const target = card(layout, name);
  if (!target) return -1;
  const offset = target.lines.slice(0, Math.max(0, target.rows - 2)).findIndex(match);
  return offset < 0 ? -1 : target.y + 1 + offset;
}

describe('sidebarCardsLayout', () => {
  it('gives the 80x24 sidebar (22 rows) with one other project 5, 3 and 14 rows', () => {
    expect(computeLayout(80, 24).sidebar.rows).toBe(22);
    for (const agents of [0, 1, 3, 8]) expect(rowsOf(sidebarCardsLayout(model(1, agents), 22, INITIAL_SIDEBAR_NAV, COLS))).toEqual([5, 3, 14]);
  });

  it('leaves Other projects out with no other project, and lists every row when they fit', () => {
    const layout = sidebarCardsLayout(model(0, 2), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect(layout.cards.map((each) => each.card)).toEqual(['project', 'agents']);
    expect(rowsOf(layout)).toEqual([5, 17]);
    expect(card(layout, 'project')?.lines).toEqual([{ kind: 'coordinator' }, { kind: 'workers' }, { kind: 'notice' }]);
    expect(card(layout, 'agents')?.lines).toEqual([{ kind: 'agent', index: 0 }, { kind: 'detail', index: 0 }, { kind: 'agent', index: 1 }]);
    expect(card(sidebarCardsLayout(model(0, 0), 22, INITIAL_SIDEBAR_NAV, COLS), 'agents')?.lines).toEqual([{ kind: 'empty' }]);
  });

  it('shrinks Other projects to a `+N more` line before Agents loses rows', () => {
    // 5 others want 7 rows; 8 agents (3 needing attention) want 11 body rows, 13 in all.
    const fits = sidebarCardsLayout(model(5, 8), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(fits)).toEqual([5, 4, 13]); // every agent; the others get what is left
    expect(card(fits, 'otherProjects')?.lines).toEqual([{ kind: 'project', index: 1 }, { kind: 'more', count: 4 }]);
    expect(card(fits, 'agents')?.lines.filter((line) => line.kind === 'agent')).toHaveLength(8);
    const short = sidebarCardsLayout(model(5, 8), 20, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(short)).toEqual([5, 3, 12]); // the others down to their `+N more` line, then Agents loses rows
    expect(card(short, 'otherProjects')?.lines).toEqual([{ kind: 'more', count: 5 }]);
    expect(card(short, 'agents')?.lines.at(-1)).toEqual({ kind: 'more', count: 2 });
    expect(card(sidebarCardsLayout(model(5, 8), 25, INITIAL_SIDEBAR_NAV, COLS), 'otherProjects')?.rows).toBe(7);
    expect(card(sidebarCardsLayout(model(5, 2), 22, INITIAL_SIDEBAR_NAV, COLS), 'otherProjects')?.rows).toBe(7);
  });

  // Every height, number of other projects and agents, cursor box and cursor position.
  for (const rows of [8, 14, 22, 40]) {
    for (const others of [0, 1, 5]) {
      it(`keeps the cards in ${rows} rows with ${others} other projects and 0-8 agents, the cursor row in view`, () => {
        for (let agents = 0; agents <= 8; agents += 1) {
          const sidebar = model(others, agents);
          const navs: SidebarNav[] = [
            ...sidebar.agents.map((each) => ({ ...INITIAL_SIDEBAR_NAV, box: 'agents' as const, projectKey: null, agentKey: each.key })),
            ...sidebar.projects.map((each) => ({ ...INITIAL_SIDEBAR_NAV, box: 'projects' as const, projectKey: each.project_id, agentKey: null })),
          ];
          for (const nav of navs) {
            const layout = sidebarCardsLayout(sidebar, rows, nav, COLS);
            const where = `${agents} agents, ${JSON.stringify(nav)}: ${JSON.stringify(rowsOf(layout))}`;
            // The cards fill the rows exactly, top to bottom, and each has room for its lines.
            expect(rowsOf(layout).reduce((sum, each) => sum + each, 0), where).toBe(rows);
            layout.cards.forEach((each, index) => {
              expect(each.y, where).toBe(layout.cards.slice(0, index).reduce((sum, before) => sum + before.rows, 0));
              expect(each.lines.length, where).toBeLessThanOrEqual(Math.max(0, each.rows - 2));
            });
            // The cursor's row is drawn.
            const cursorRow = nav.box === 'agents'
              ? rowOfLine(layout, 'agents', (line) => line.kind === 'agent' && line.index === layout.agentIndex)
              : layout.cursorCard === 'project'
                ? rowOfLine(layout, 'project', (line) => line.kind === 'coordinator')
                : rowOfLine(layout, 'otherProjects', (line) => line.kind === 'project' && line.index === layout.projectIndex);
            expect(cursorRow, where).toBeGreaterThanOrEqual(0);
            // Agents lose rows only once Other projects is down to its least.
            const agentsCard = card(layout, 'agents')!;
            const shownAgents = agentsCard.lines.filter((line) => line.kind === 'agent').length;
            const other = card(layout, 'otherProjects');
            if (shownAgents < agents && other) {
              expect(other.lines.length, where).toBeLessThanOrEqual(nav.box === 'projects' && layout.cursorCard === 'otherProjects' && others > 1 ? 2 : 1);
            }
            // A cut list says how many are left out.
            if (shownAgents < agents && agentsCard.rows - 2 >= 2) {
              expect(agentsCard.lines.at(-1), where).toEqual({ kind: 'more', count: agents - shownAgents });
            }
          }
        }
      });
    }
  }

  it('drops Other projects before the Agents card loses its last body row, unless the cursor is in it', () => {
    expect(rowsOf(sidebarCardsLayout(model(5, 8), 8, INITIAL_SIDEBAR_NAV, COLS))).toEqual([3, 5]);
    const inOthers = sidebarCardsLayout(model(5, 8), 8, { ...INITIAL_SIDEBAR_NAV, box: 'projects', projectKey: 'o4', agentKey: null }, COLS);
    expect(rowsOf(inOthers)).toEqual([3, 4, 1]);
    expect(card(inOthers, 'otherProjects')?.lines).toEqual([{ kind: 'project', index: 4 }, { kind: 'more', count: 4 }]);
  });
});

describe('sidebar navigation (keys move in the projects and agents boxes)', () => {
  const view = (nav: SidebarNav) => sidebarCardsLayout(model(1, 3), 22, nav, COLS);

  it('moves the cursor with up and down, stopping at either end', () => {
    let nav: SidebarNav = INITIAL_SIDEBAR_NAV;
    nav = navigateSidebar(view(nav), nav, 'up').nav;
    expect(nav.agentKey).toBe('p1/a1');
    for (let i = 0; i < 5; i += 1) nav = navigateSidebar(view(nav), nav, 'down').nav;
    expect(nav.agentKey).toBe('p1/a3');
  });

  it('switches boxes with Tab, opens with Enter and returns to the pane with Esc', () => {
    let nav: SidebarNav = INITIAL_SIDEBAR_NAV;
    let step = navigateSidebar(view(nav), nav, 'down');
    expect(step.command).toBeNull();
    nav = step.nav;
    step = navigateSidebar(view(nav), nav, 'open');
    expect(step.command).toEqual({ type: 'openAgent', projectId: 'p1', agentId: 'a2' });

    step = navigateSidebar(view(nav), nav, 'switchBox');
    expect(step.nav.box).toBe('projects');
    expect(view(step.nav).cursorCard).toBe('project'); // the projects cursor starts on the active project
    expect(navigateSidebar(view(step.nav), step.nav, 'open').command).toEqual({ type: 'openProject', projectId: 'p1' });
    nav = navigateSidebar(view(step.nav), step.nav, 'down').nav;
    expect(view(nav).cursorCard).toBe('otherProjects');
    step = navigateSidebar(view(nav), nav, 'open');
    expect(step.command).toEqual({ type: 'openProject', projectId: 'o1' });
    expect(step.nav.agentKey).toBeNull(); // another project's agents start at the top

    expect(navigateSidebar(view(nav), nav, 'back')).toEqual({ nav, command: { type: 'focusSlot' } });
    expect(navigateSidebar(view(nav), { ...nav, box: 'projects' }, 'switchBox').nav.box).toBe('agents');
  });

  it('moves through the projects in drawn order when the active project is not first in the model', () => {
    // Registry order a, b (active), c: drawn as b on the Project card, then a and c in Other projects.
    const shuffled = model(0, 1, {
      projects: [project('a'), project('b', { active: true }), project('c')],
      activeProjectId: 'b',
    });
    const at = (nav: SidebarNav) => sidebarCardsLayout(shuffled, 22, nav, COLS);
    let nav: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'projects' };
    const visited = [at(nav).projectIndex];
    for (let i = 0; i < 3; i += 1) {
      nav = navigateSidebar(at(nav), nav, 'down').nav;
      visited.push(at(nav).projectIndex);
    }
    expect(visited.map((index) => shuffled.projects[index].project_id)).toEqual(['b', 'a', 'c', 'c']);
    for (let i = 0; i < 3; i += 1) nav = navigateSidebar(at(nav), nav, 'up').nav;
    expect(nav.projectKey).toBe('b');
    expect(at(nav).cursorCard).toBe('project');
    // The rows a click hits are the projects drawn there.
    const others = card(at(nav), 'otherProjects')!;
    expect([1, 2].map((row) => shuffled.projects[sidebarCardTarget(at(nav), 2, others.y + row)!.index].project_id)).toEqual(['a', 'c']);
  });

  it('opens nothing in an empty box', () => {
    const empty = sidebarCursor(model(1, 0), INITIAL_SIDEBAR_NAV);
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'open').command).toBeNull();
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'down').nav).toEqual(INITIAL_SIDEBAR_NAV);
  });
});

describe('sidebarCardTarget and sidebarCardClick', () => {
  const { layout, lines } = render(model(2, 3));
  const rowOf = (part: string) => lines.findIndex((line) => line.includes(part));

  it('hits each card\'s rows: the active project on its coordinator and workers rows, each other project, each agent on both its rows', () => {
    expect(sidebarCardTarget(layout, 5, rowOf('coordinator'))).toEqual({ card: 'project', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 5, rowOf('workers'))).toEqual({ card: 'project', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 5, rowOf('o1 '))).toEqual({ card: 'otherProjects', index: 1, onMarker: false });
    expect(sidebarCardTarget(layout, 30, rowOf('o2 '))).toEqual({ card: 'otherProjects', index: 2, onMarker: false });
    expect(sidebarCardTarget(layout, 10, rowOf('a1 '))).toEqual({ card: 'agents', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 10, rowOf('? question 1'))).toEqual({ card: 'agents', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 10, rowOf('a3 '))).toEqual({ card: 'agents', index: 2, onMarker: false });
  });

  it('says when a click hits the collapse marker, and only on the agent\'s first row', () => {
    const y = rowOf('a2 ');
    expect(lines[y].slice(2, 5)).toBe('[+]');
    expect([1, 2, 3, 4, 5].map((x) => sidebarCardTarget(layout, x, y)?.onMarker)).toEqual([false, true, true, true, false]);
    expect(sidebarCardTarget(layout, 3, rowOf('? question 1'))?.onMarker).toBe(false);
  });

  it('hits nothing on borders, blank rows, the notice row and `+N more` lines', () => {
    expect(sidebarCardTarget(layout, 5, 0)).toBeNull(); // the Project card's top border
    expect(sidebarCardTarget(layout, 0, rowOf('coordinator'))).toBeNull(); // the left border
    expect(sidebarCardTarget(layout, COLS - 1, rowOf('coordinator'))).toBeNull(); // the right border
    expect(sidebarCardTarget(layout, 5, rowOf('coordinator') + 2)).toBeNull(); // the empty notice row
    expect(sidebarCardTarget(layout, 5, rowOf('OTHER PROJECTS'))).toBeNull();
    expect(sidebarCardTarget(layout, 5, rowOf('a3 ') + 1)).toBeNull(); // a blank row of the Agents card
    expect(sidebarCardTarget(layout, 5, 21)).toBeNull(); // its bottom border
    const none = sidebarCardsLayout(model(0, 0, { projects: [], activeProjectId: null, notice: 'no registered projects' }), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect([1, 2].map((y) => sidebarCardTarget(none, 5, y))).toEqual([null, null]); // `(none)` and the notice
    const cut = sidebarCardsLayout(model(5, 8), 22, INITIAL_SIDEBAR_NAV, COLS);
    const more = rowOfLine(cut, 'otherProjects', (line) => line.kind === 'more');
    expect(sidebarCardTarget(cut, 5, more)).toBeNull();
  });

  it('opens what a click hits; the cursor box follows', () => {
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, rowOf('coordinator'))).toEqual({
      nav: { ...INITIAL_SIDEBAR_NAV, box: 'projects', projectKey: 'p1', agentKey: null }, command: { type: 'openProject', projectId: 'p1' },
    });
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, rowOf('o2 '))?.command).toEqual({ type: 'openProject', projectId: 'o2' });
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 8, rowOf('a2 '))).toEqual({
      nav: { ...INITIAL_SIDEBAR_NAV, box: 'agents', projectKey: null, agentKey: 'p1/a2' }, command: { type: 'openAgent', projectId: 'p1', agentId: 'a2' },
    });
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, 0)).toBeNull();
  });
});

describe('drawSidebarCards', () => {
  it('draws the Project, Other projects and Agents cards at 80x24, wide names in their display width', () => {
    const sidebar = model(1, 2, {
      projects: [project('p1', { name: CJK_PROJECT, active: true }), project('o1', { state: 'stopped', connection: 'stopped', attention: 2 })],
      agents: [agent(EMOJI_AGENT, { attention: 'permission_prompt', detail: '? may I run npm test' }), agent('thrall', { phase: 'review', elapsed: '8m' })],
    });
    const { lines } = render(sidebar);
    expect(lines.slice(0, 13)).toEqual([
      `┌─ [ ${CJK_PROJECT} ] ${'─'.repeat(COLS - 9 - stringWidth(CJK_PROJECT))}┐`,
      '│ coordinator          [RUNNING] │',
      '│ workers 2/4                    │',
      '│                                │',
      '└────────────────────────────────┘',
      '┌─ [ OTHER PROJECTS ] ──────── 1 ┐',
      '│ o1                [STOPPED] !2 │',
      '└────────────────────────────────┘',
      '┌─ [ AGENTS ] ─────────── 2 live ┐',
      '│ [+] agent-🚀… 12m [PERMISSION] │',
      '│     ? may I run npm test       │',
      '│ [+] thrall worker  8m [REVIEW] │',
      '│                                │',
    ]);
    expect(lines[21]).toBe('└────────────────────────────────┘');
    for (const line of lines) expect(stringWidth(line)).toBe(COLS);
  });

  it('shows the project state once, as the Project card\'s badge, and no Status box', () => {
    const { lines } = render(model(1, 2));
    const text = lines.join('\n');
    expect(text.match(/\[RUNNING\]/g)).toHaveLength(1);
    expect(text).not.toMatch(/Status|STATUS|needs? you/);
    expect(render(model(1, 2, { status: { coordinator: null, workers: null, attention: 0 }, projects: [], activeProjectId: null, agents: [], notice: 'no registered projects' })).lines.slice(0, 4))
      .toEqual(['┌─ [ PROJECT ] ──────────────────┐', '│ (none)                         │', '│ no registered projects         │', '│                                │']);
  });

  it('keeps the question or reason row only for agents needing attention', () => {
    const { lines } = render(model(0, 4));
    const agentRows = lines.slice(lines.findIndex((line) => line.includes('AGENTS')) + 1);
    expect(agentRows.slice(0, 6).map((line) => line.trim())).toEqual([
      '│ [+] a1 worker 12m [QUESTION] │', '│     ? question 1 │', '│ [+] a2 worker 12m [IMPLEMENT] │', '│ [+] a3 worker 12m [IMPLEMENT] │',
      '│ [+] a4 worker 12m [QUESTION] │', '│     ? question 4 │',
    ].map((line) => expect.stringMatching(new RegExp(`^${line.replace(/[[\]+?|]/g, '\\$&').replace(/ /g, ' +')}$`))));
  });

  it('says why there are no agents and dims a stale list', () => {
    const stopped = model(0, 0, { projects: [project('p1', { active: true, state: 'stopped', connection: 'stopped' })] });
    expect(render(stopped).lines.join('\n')).toContain('(coordinator not running)');
    expect(render(model(0, 0)).lines.join('\n')).toContain('(no live agents)');
    const stale = render(model(0, 2, { agentsStale: true }), { theme: AMBER });
    expect(stale.lines.join('\n')).toContain('2 stale');
    const y = stale.lines.findIndex((line) => line.includes('a2 '));
    expect(stale.frame.cells[y * COLS + 6].style.dim).toBe(true);
    expect(stale.frame.cells[y * COLS + stale.lines[y].indexOf('[IMPLEMENT]')].style).toEqual({ ...styleOf(AMBER, 'status.active.badge'), dim: true });
  });

  it('draws the focused card\'s border in chrome.borderFocus and the cursor row in row.cursor, on the Project card for the active project', () => {
    const onActive = render(model(1, 3), { focus: 'projects', theme: AMBER });
    const coordinator = onActive.lines.findIndex((line) => line.includes('coordinator'));
    expect(onActive.frame.cells[0].style).toEqual(styleOf(AMBER, 'chrome.borderFocus'));
    expect(onActive.frame.cells[coordinator * COLS + 2].style).toMatchObject({ bg: styleOf(AMBER, 'row.cursor').bg, bold: true });
    expect(onActive.frame.cells[coordinator * COLS + 1].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg); // the bar spans the padding
    const other = onActive.lines.findIndex((line) => line.includes('o1 '));
    expect(onActive.frame.cells[(other - 1) * COLS].style).toEqual(styleOf(AMBER, 'chrome.border'));
    expect(onActive.frame.cells[other * COLS + 2].style.bg).toEqual({ type: 'default' });

    const onOther = render(model(1, 3), { focus: 'projects', nav: { ...INITIAL_SIDEBAR_NAV, box: 'projects', projectKey: 'o1', agentKey: null }, theme: AMBER });
    expect(onOther.frame.cells[0].style).toEqual(styleOf(AMBER, 'chrome.border'));
    expect(onOther.frame.cells[(other - 1) * COLS].style).toEqual(styleOf(AMBER, 'chrome.borderFocus'));
    expect(onOther.frame.cells[other * COLS + 2].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(onOther.frame.cells[coordinator * COLS + 2].style.bg).toEqual({ type: 'default' });
    // The badge keeps its own style on the cursor row.
    const badgeX = onOther.lines[other].indexOf('[STOPPED]');
    expect(onOther.frame.cells[other * COLS + badgeX].style).toEqual(styleOf(AMBER, 'status.warn.badge'));

    const agents = render(model(1, 3), { focus: 'agents', nav: { ...INITIAL_SIDEBAR_NAV, box: 'agents', projectKey: null, agentKey: 'p1/a2' }, theme: AMBER });
    const a2 = agents.lines.findIndex((line) => line.includes('a2 '));
    const agentsTop = agents.lines.findIndex((line) => line.includes('AGENTS'));
    expect(agents.frame.cells[agentsTop * COLS].style).toEqual(styleOf(AMBER, 'chrome.borderFocus'));
    expect(agents.frame.cells[a2 * COLS + 6].style).toMatchObject({ bg: styleOf(AMBER, 'row.cursor').bg, bold: true });
    expect(agents.frame.cells[(a2 - 2) * COLS + 6].style.bg).toEqual({ type: 'default' });
    // Unfocused: no focus border and no cursor bar.
    const none = render(model(1, 3), { theme: AMBER });
    expect(none.frame.cells.filter((cell) => cell.style.bg.type !== 'default' && cell.text === ' ')).toHaveLength(0);
  });

  it('draws badges and counts in their amber status roles', () => {
    const { frame, lines } = render(model(1, 3), { theme: AMBER });
    const at = (part: string) => {
      const y = lines.findIndex((line) => line.includes(part));
      return frame.cells[y * COLS + lines[y].indexOf(part)];
    };
    expect(at('[RUNNING]').style).toEqual(styleOf(AMBER, 'status.active.badge'));
    expect(at('[STOPPED]').style).toEqual(styleOf(AMBER, 'status.warn.badge'));
    expect(at('!2').style).toEqual(styleOf(AMBER, 'status.attention.badge'));
    expect(at('[QUESTION]').style).toEqual(styleOf(AMBER, 'status.attention.badge'));
    expect(at('[IMPLEMENT]').style).toEqual(styleOf(AMBER, 'status.active.badge'));
    expect(at('? question 1').style).toEqual(styleOf(AMBER, 'status.attention'));
    expect(at('a2').style).toEqual(styleOf(AMBER, 'text.accent'));
  });

  it('draws the same text under every built-in theme', () => {
    const sidebar = model(5, 8, { notice: 'registry error: boom', agentsStale: true });
    for (const rows of [8, 22]) {
      const text = (theme: typeof CLASSIC) => render(sidebar, { rows, focus: 'agents', theme }).lines;
      expect(text(BUILT_IN_THEMES.mono)).toEqual(text(AMBER));
      expect(text(CLASSIC)).toEqual(text(AMBER));
    }
  });

  it('fits a narrow sidebar: badges and times give way to names, nothing spills', () => {
    for (const cols of [10, 16, 24]) {
      const frame = createFrame(cols + 4, 22);
      const layout = sidebarCardsLayout(model(2, 4), 22, INITIAL_SIDEBAR_NAV, cols);
      drawSidebarCards(frame, { x: 0, y: 0, cols, rows: 22 }, layout, { focus: 'agents', theme: AMBER });
      for (let y = 0; y < 22; y += 1) {
        expect(stringWidth(rowText(frame, y, 0, cols))).toBe(cols);
        expect(rowText(frame, y, cols, 4)).toBe('    ');
      }
    }
  });
});

describe('expanded agents', () => {
  const MONO = BUILT_IN_THEMES.mono;
  const at = (agentKey: string, expanded: string[], box: 'agents' | 'projects' = 'agents'): SidebarNav => ({ ...INITIAL_SIDEBAR_NAV, box, agentKey, expanded: new Set(expanded) });
  /** 3 other projects; 4 agents with a task and provider, a1 asking a question long enough to wrap past two lines. */
  const details = (others = 3) => model(others, 4, {
    agents: model(others, 4).agents.map((each, index) => ({
      ...each, task_ref: 'cockpit-style/foo', provider: 'claude',
      ...(index === 0 ? { detail: '? may I run npm test and then a much longer question that wraps over more than two lines' } : {}),
    })),
  });
  const blockRows = (layout: SidebarCardsLayout, index: number) =>
    card(layout, 'agents')!.lines.slice(0, card(layout, 'agents')!.rows - 2).filter((line) => line.kind === 'block' && line.index === index);

  it('toggles the cursor agent with Space, and nothing in the projects box or with no agents', () => {
    const view = (nav: SidebarNav) => sidebarCursor(details(), nav);
    let nav = at('p1/a2', []);
    nav = navigateSidebar(view(nav), nav, 'toggle').nav;
    expect([...nav.expanded]).toEqual(['p1/a2']);
    nav = navigateSidebar(view(nav), nav, 'down').nav;
    nav = navigateSidebar(view(nav), nav, 'toggle').nav;
    expect([...nav.expanded].sort()).toEqual(['p1/a2', 'p1/a3']);
    nav = navigateSidebar(view(nav), nav, 'toggle').nav;
    expect([...nav.expanded]).toEqual(['p1/a2']);
    expect(navigateSidebar(view(nav), nav, 'toggle').command).toBeNull();
    const projects = at('p1/a2', ['p1/a2'], 'projects');
    expect(navigateSidebar(view(projects), projects, 'toggle')).toEqual({ nav: projects, command: null });
    expect(navigateSidebar(sidebarCursor(model(1, 0), INITIAL_SIDEBAR_NAV), INITIAL_SIDEBAR_NAV, 'toggle').nav).toBe(INITIAL_SIDEBAR_NAV);
    // Opening keeps what is expanded.
    expect([...navigateSidebar(view(nav), { ...nav, box: 'projects' }, 'open').nav.expanded]).toEqual(['p1/a2']);
  });

  it('drops the key of an agent that left the model', () => {
    const nav = at('p1/a2', ['p1/a2', 'p1/a4']);
    const pruned = pruneExpanded(nav, details(1));
    expect(pruned).toBe(nav);
    const gone = pruneExpanded(nav, { ...details(1), agents: details(1).agents.filter((each) => each.agent_id !== 'a4') });
    expect([...gone.expanded]).toEqual(['p1/a2']);
    expect(gone.agentKey).toBe('p1/a2');
    expect(pruneExpanded(nav, { ...details(1), agents: [] }).expanded.size).toBe(0);
    // Without the project's status (before its first load or while it reconnects) no agent is listed: nothing is dropped.
    const unloaded = { ...details(1), agents: [], status: { ...details(1).status, workers: null } };
    expect(pruneExpanded(nav, unloaded)).toBe(nav);
  });

  it('gives a lone expanded agent every body row (no row held for a `+N more` line)', () => {
    const lone = details(0);
    lone.agents = lone.agents.slice(1, 2); // a2: a one-line activity, a 6-row block
    const nav = at('p1/a2', ['p1/a2']);
    for (const rows of [8, 10]) {
      const layout = sidebarCardsLayout(lone, rows, nav, COLS);
      const agents = card(layout, 'agents')!;
      expect(agents.lines.length, `${rows} rows`).toBe(Math.min(6, agents.rows - 2));
    }
  });

  it('gives the Project card back the rows of a dropped Other projects', () => {
    const one = details(3);
    one.agents = one.agents.slice(1, 2);
    const layout = sidebarCardsLayout(one, 12, at('p1/a2', ['p1/a2']), COLS);
    expect(rowsOf(layout)).toEqual([4, 8]);
    expect(card(layout, 'project')!.lines.map((line) => line.kind)).toEqual(['coordinator', 'workers']);
  });

  it('leaves out the activity line when it only repeats the task', () => {
    const fallback = details(0);
    fallback.agents = [{ ...fallback.agents[1], detail: 'cockpit-style/foo' }];
    const layout = sidebarCardsLayout(fallback, 22, at('p1/a2', ['p1/a2']), COLS);
    expect(blockRows(layout, 0).map((line) => (line.kind === 'block' ? line.part : ''))).toEqual(['top', 'task', 'phase', 'hint', 'bottom']);
  });

  it('lays out the block: the row, task, phase and provider, at most two activity lines, the open hint', () => {
    const layout = sidebarCardsLayout(details(0), 22, at('p1/a1', ['p1/a1']), COLS);
    expect(blockRows(layout, 0).map((line) => (line.kind === 'block' ? line.part : ''))).toEqual(['top', 'task', 'phase', 'detail', 'detail', 'hint', 'bottom']);
    const { lines } = render(details(0), { nav: at('p1/a1', ['p1/a1']), focus: 'agents' });
    const top = lines.findIndex((line) => line.includes('[-] a1'));
    expect(lines.slice(top, top + 7).map((line) => line.trimEnd())).toEqual([
      '│┌ [-] a1 worker 12m [QUESTION] ┐│',
      '││ task  cockpit-style/foo      ││',
      '││ implement · claude           ││',
      '││ ? may I run npm test and     ││',
      '││ then a much longer question… ││',
      '││ Enter: open tab              ││',
      '│└──────────────────────────────┘│',
    ]);
    for (const line of lines) expect(stringWidth(line)).toBe(COLS);
    // The other agents stay collapsed rows.
    expect(lines.some((line) => line.includes('[+] a2'))).toBe(true);
  });

  for (const rows of [22, 12, 8]) {
    it(`keeps the cursor's whole block in view at ${rows} rows with mixed expanded and collapsed agents, Other projects shrinking first`, () => {
      for (const cursorAgent of ['a1', 'a2', 'a3', 'a4']) {
        const nav = at(`p1/${cursorAgent}`, ['p1/a1', 'p1/a3']);
        const layout = sidebarCardsLayout(details(), rows, nav, COLS);
        const where = `${rows} rows, cursor ${cursorAgent}: ${JSON.stringify(rowsOf(layout))}`;
        expect(rowsOf(layout).reduce((sum, each) => sum + each, 0), where).toBe(rows);
        const index = layout.agentIndex;
        const expanded = nav.expanded.has(`p1/${cursorAgent}`);
        const height = expanded ? (cursorAgent === 'a1' ? 7 : 6) : 1; // a1's question wraps to two lines
        // A block fits when the Agents card can hold it (and a `+N more` line) below the Project card's coordinator row.
        const fits = rows - 3 - 2 >= height + 1;
        const shown = expanded ? blockRows(layout, index).length : card(layout, 'agents')!.lines.filter((line) => line.kind === 'agent' && line.index === index).length;
        expect(shown, where).toBe(fits ? height : Math.min(height, rows - 3 - 2 - 1));
        if (expanded && fits) expect(blockRows(layout, index).map((line) => (line.kind === 'block' ? line.part : '')), where).toContain('bottom');
        // Agents lose rows only once Other projects is down to a `+N more` line (or gone) and the Project card shrinks after it.
        const other = card(layout, 'otherProjects');
        const projectRows = card(layout, 'project')!.rows;
        if (projectRows < 5) expect(other?.rows ?? 0, where).toBeLessThanOrEqual(3);
      }
    });
  }

  it('fits the cursor block at 12 rows by shrinking Other projects, then the Project card, then dropping Other projects', () => {
    const layout = sidebarCardsLayout(details(), 12, at('p1/a3', ['p1/a1', 'p1/a3']), COLS);
    expect(rowsOf(layout)).toEqual([3, 9]);
    expect(card(layout, 'agents')!.lines.at(-1)).toEqual({ kind: 'more', count: 3 });
    // At 22 the shrunk Other projects takes back the rows the Agents window leaves.
    expect(rowsOf(sidebarCardsLayout(details(), 22, at('p1/a3', ['p1/a1', 'p1/a3']), COLS))).toEqual([5, 5, 12]);
    // With the cursor collapsed, the layout is the collapsed one's.
    expect(rowsOf(sidebarCardsLayout(details(), 12, at('p1/a2', ['p1/a1', 'p1/a3']), COLS))).toEqual(rowsOf(sidebarCardsLayout(details(), 12, at('p1/a2', []), COLS)));
  });

  it('toggles on a click on the marker, also on a block\'s top row; a click elsewhere opens the agent', () => {
    const nav = at('p1/a1', ['p1/a3']);
    const { layout, lines } = render(details(0), { nav });
    const collapsed = lines.findIndex((line) => line.includes('[+] a2'));
    const block = lines.findIndex((line) => line.includes('[-] a3'));
    expect(lines[block].slice(3, 6)).toBe('[-]');
    expect([2, 3, 4, 5, 6].map((x) => sidebarCardTarget(layout, x, block)?.onMarker)).toEqual([false, true, true, true, false]);
    expect(sidebarCardClick(layout, nav, 3, block)).toEqual({ nav: { ...nav, agentKey: 'p1/a3', expanded: new Set() }, command: null });
    expect(sidebarCardClick(layout, nav, 2, collapsed)).toEqual({ nav: { ...nav, agentKey: 'p1/a2', expanded: new Set(['p1/a3', 'p1/a2']) }, command: null });
    for (const y of [block, block + 1, block + 3, block + 5]) {
      expect(sidebarCardClick(layout, nav, 10, y)?.command, `row ${y}`).toEqual({ type: 'openAgent', projectId: 'p1', agentId: 'a3' });
    }
  });

  it('frames the block in the agent\'s status role, its text the same under mono', () => {
    const sidebar = details(0);
    const nav = at('p1/a2', ['p1/a1', 'p1/a2']);
    const amber = render(sidebar, { nav, theme: AMBER });
    const mono = render(sidebar, { nav, theme: MONO });
    expect(mono.lines).toEqual(amber.lines);
    expect(render(sidebar, { nav, theme: CLASSIC }).lines).toEqual(amber.lines);
    for (const [name, index] of [['a1', 0], ['a2', 1]] as const) {
      const role = agentStatusRole(sidebar.agents[index]);
      expect(role).toBe(name === 'a1' ? 'status.attention' : 'status.active');
      const top = amber.lines.findIndex((line) => line.includes(`[-] ${name}`));
      const bottom = top + blockRows(amber.layout, index).length - 1;
      for (const [x, y] of [[1, top], [COLS - 2, top], [1, top + 1], [COLS - 2, top + 2], [1, bottom], [10, bottom]]) {
        expect(amber.frame.cells[y * COLS + x].style, `${name} ${x},${y}`).toEqual(styleOf(AMBER, role));
      }
    }
    // A stale list dims the block's border and text too.
    const stale = render({ ...sidebar, agentsStale: true }, { nav, theme: AMBER });
    const top = stale.lines.findIndex((line) => line.includes('[-] a2'));
    expect(stale.frame.cells[top * COLS + 1].style).toEqual({ ...styleOf(AMBER, 'status.active'), dim: true });
    expect(stale.frame.cells[(top + 1) * COLS + 3].style.dim).toBe(true);
  });

  it('puts the cursor bar on the block\'s top row', () => {
    const nav = at('p1/a2', ['p1/a2']);
    const { frame, lines } = render(details(0), { nav, focus: 'agents', theme: AMBER });
    const top = lines.findIndex((line) => line.includes('[-] a2'));
    expect(frame.cells[top * COLS + 3].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(frame.cells[(top + 1) * COLS + 3].style.bg).not.toEqual(styleOf(AMBER, 'row.cursor').bg);
  });
});

describe('no rounded corners in lib/cockpit2', () => {
  it('uses square box glyphs only', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => /\.(ts|snap)$/.test(name));
    const rounded = files.filter((name) => /[\u256D\u256E\u256F\u2570]/.test(readFileSync(join(dir, name), 'utf8')));
    expect(rounded).toEqual([]);
  });
});
