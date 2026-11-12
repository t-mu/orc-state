import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringWidth } from '../cellWidth.ts';
import type { SidebarAgent, SidebarModel, SidebarProject } from '../tui/sidebar.ts';
import { computeLayout } from './app.ts';
import { createFrame, type Frame } from './frame.ts';
import {
  INITIAL_SIDEBAR_NAV, LOCAL_NOTE, agentStatusRole, drawSidebarCards, localAgentKey, navigateSidebar, pruneExpanded, sidebarCardClick, sidebarCardTarget, sidebarCardsLayout, sidebarCursor,
  type CardLayout, type LocalAgent, type SidebarCard, type SidebarCardsLayout, type SidebarNav,
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
/** The agents whose title row a card shows (in its box or, in a window too short for the box, alone), in order. */
const titles = (each: CardLayout): number[] => each.lines.flatMap((line) => ((line.kind === 'block' && line.part === 'title') || line.kind === 'agent' ? [line.index] : []));

/** Row `y` of `frame` from column `x`, `cols` wide, as text (a wide grapheme's continuation cell adds nothing). */
const rowText = (frame: Frame, y: number, x = 0, cols = frame.cols) =>
  frame.cells.slice(y * frame.cols + x, y * frame.cols + x + cols).map((cell) => cell.text).join('');

function render(sidebar: SidebarModel, options: { rows?: number; focus?: 'projects' | 'project' | 'agents' | null; nav?: SidebarNav; theme?: typeof CLASSIC; locals?: LocalAgent[] } = {}) {
  const rows = options.rows ?? 22;
  const frame = createFrame(COLS, rows);
  const layout = sidebarCardsLayout(sidebar, rows, options.nav ?? INITIAL_SIDEBAR_NAV, COLS, options.locals);
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

/** The rows no card covers: the blank gaps between cards. */
const gapRows = (layout: SidebarCardsLayout) =>
  Array.from({ length: layout.rows }, (_, y) => y).filter((y) => !layout.cards.some((each) => y >= each.y && y < each.y + each.rows));

describe('sidebarCardsLayout', () => {
  it('stacks Projects, Project and Agents with a blank row between them, equal in height while the content fits: 6, 6 and 8 rows in the 80x24 sidebar (22 rows)', () => {
    expect(computeLayout(80, 24).sidebar.rows).toBe(22);
    for (const agents of [0, 1]) {
      const layout = sidebarCardsLayout(model(0, agents), 22, INITIAL_SIDEBAR_NAV, COLS);
      expect(layout.cards.map((each) => each.card)).toEqual(['projects', 'project', 'agents']);
      expect(layout.cards.map((each) => [each.y, each.rows])).toEqual([[0, 6], [7, 6], [14, 8]]); // the remainder to Agents
      expect(gapRows(layout)).toEqual([6, 13]);
    }
    // 3 agents (boxes of 4, 3 and 3 rows) or 8 need more room: the others shrink to their content (Projects its row and
    // button, the Project card its three rows).
    for (const agents of [3, 8]) {
      expect(sidebarCardsLayout(model(0, agents), 22, INITIAL_SIDEBAR_NAV, COLS).cards.map((each) => [each.y, each.rows])).toEqual([[0, 4], [5, 5], [11, 11]]);
    }
    // The Project card never grows past its share: with a notice and the tasks row it drops the tasks row.
    const full = sidebarCardsLayout(model(0, 1, { notice: 'coordinator not running', tasks: { todo: 1 } }), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(full)).toEqual([6, 6, 8]);
    expect(card(full, 'project')?.lines.map((line) => line.kind)).toEqual(['coordinator', 'workers', 'notice', 'settings']);
  });

  it('splits the rows equally at 30 and 40 rows (the remainder to Agents) and pins each card\'s button to its last body row', () => {
    for (const [rows, sizes] of [[22, [6, 6, 8]], [30, [9, 9, 10]], [40, [12, 12, 14]]] as const) {
      const { layout, lines } = render(model(1, 1), { rows });
      expect(rowsOf(layout), `${rows}`).toEqual(sizes);
      for (const [name, label] of [['projects', '[ + ADD PROJECT ]'], ['project', '[ SETTINGS ]'], ['agents', '[ + NEW AGENT ]']] as const) {
        const each = card(layout, name)!;
        const last = each.y + each.rows - 2; // the row above the bottom border
        expect(lines[last].slice(2, 2 + label.length), `${rows} ${name}`).toBe(label);
        expect(lines[last + 1].startsWith('└'), `${rows} ${name}`).toBe(true);
        expect(lines.filter((line) => line.includes(label)), `${rows} ${name}`).toHaveLength(1);
      }
    }
  });

  it('pins the buttons to the last body rows at 22, 30 and 40 rows when Agents needs more room, its list scrolling above its button', () => {
    for (const rows of [22, 30, 40]) {
      const { layout, lines } = render(model(5, 20), { rows });
      for (const [name, label] of [['projects', '[ + ADD PROJECT ]'], ['project', '[ SETTINGS ]'], ['agents', '[ + NEW AGENT ]']] as const) {
        const each = card(layout, name)!;
        expect(lines[each.y + each.rows - 2].slice(2, 2 + label.length), `${rows} ${name}`).toBe(label);
      }
      const agents = card(layout, 'agents')!;
      // A window of whole boxes may leave blank rows between its `+N more` and the button.
      expect(agents.lines.filter((line) => line.kind !== 'blank').at(-2)?.kind, `${rows}`).toBe('more');
      expect(agents.lines.at(-1), `${rows}`).toEqual({ kind: 'newAgent' });
    }
  });

  it('grows Agents when its content needs more room, the others keeping their content, then Projects down to its least', () => {
    // 40 rows: shares of 12, 12 and 14; 4 agents want 14 rows (their boxes) and a button. Projects gives up three of its
    // blank rows (it holds 3 projects and a button).
    const grown = sidebarCardsLayout(model(2, 4), 40, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(grown)).toEqual([9, 12, 17]);
    expect(titles(card(grown, 'agents')!)).toEqual([0, 1, 2, 3]);
    // 22 rows: Projects goes down to the active project, `+N more` and its button; the Project card keeps its three rows.
    const short = sidebarCardsLayout(model(5, 12), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(short)).toEqual([5, 5, 10]);
    expect(card(short, 'projects')!.lines).toEqual([{ kind: 'project', index: 0 }, { kind: 'more', count: 5 }, { kind: 'addProject' }]);
    expect(card(short, 'project')!.lines.map((line) => line.kind)).toEqual(['coordinator', 'workers', 'settings']);
    // Never more than the equal share for Projects and the Project card, however many projects.
    const many = sidebarCardsLayout(model(20, 1), 40, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(many)).toEqual([12, 12, 14]);
  });

  it('lists every project in the Projects card, the active one marked, and the Project card titled with the active project', () => {
    const { layout, lines } = render(model(2, 1, { status: { coordinator: 'running', workers: { used: 2, total: 4 }, attention: 2 } }));
    expect(card(layout, 'projects')?.lines).toEqual([{ kind: 'project', index: 0 }, { kind: 'project', index: 1 }, { kind: 'project', index: 2 }, { kind: 'addProject' }]);
    expect(lines.slice(0, 14)).toEqual([
      '┌─ [ PROJECTS ] ────────────── 3 ┐',
      '│ ▸ orc-state          [RUNNING] │',
      '│   o1              [STOPPED] !2 │',
      '│   o2                 [STOPPED] │',
      '│ [ + ADD PROJECT ]              │',
      '└────────────────────────────────┘',
      ' '.repeat(COLS),
      '┌─ [ ORC-STATE ] ────────────────┐',
      '│ coordinator          [RUNNING] │',
      '│                                │',
      '│ workers 2/4                    │',
      '│ [ SETTINGS ]                   │',
      '└────────────────────────────────┘',
      ' '.repeat(COLS),
    ]);
  });

  it('gives the Project card its tasks row with the status (open counts, or no open tasks) and its notice row only while there is a notice', () => {
    const projectRows = (overrides: Partial<SidebarModel>) => {
      const { layout, lines } = render(model(0, 1, overrides));
      const project = card(layout, 'project')!;
      // The card's body rows without the blank ones between its rows and its button.
      return lines.slice(project.y + 1, project.y + project.rows - 1).map((line) => line.slice(2, -2).trimEnd()).filter((line) => line !== '');
    };
    expect(projectRows({})).toEqual(['coordinator          [RUNNING]', 'workers 2/4', '[ SETTINGS ]']);
    expect(projectRows({ tasks: { todo: 3, in_progress: 1, done: 9 } })).toEqual(['coordinator          [RUNNING]', 'workers 2/4', 'tasks 3 todo · 1 in progress', '[ SETTINGS ]']);
    expect(projectRows({ tasks: { todo: 0, in_progress: 2 } })[2]).toBe('tasks 2 in progress');
    expect(projectRows({ tasks: { todo: 4 } })[2]).toBe('tasks 4 todo');
    expect(projectRows({ tasks: { done: 5 } })[2]).toBe('no open tasks');
    expect(projectRows({ tasks: null })).not.toContain('no open tasks');
    expect(projectRows({ notice: 'coordinator not running' })).toEqual(['coordinator          [RUNNING]', 'workers 2/4', 'coordinator not running', '[ SETTINGS ]']);
  });

  it('shrinks Projects to a `+N more` window before Agents loses rows, keeping the active project in view', () => {
    // 6 projects want 9 rows with their button; 4 agents (2 needing attention) want 14 body rows and a button, 17 in all.
    const fits = sidebarCardsLayout(model(5, 4), 31, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(fits)).toEqual([7, 5, 17]); // every agent; the projects get what is left
    expect(card(fits, 'projects')?.lines).toEqual([...[0, 1, 2].map((index) => ({ kind: 'project', index })), { kind: 'more', count: 3 }, { kind: 'addProject' }]);
    expect(titles(card(fits, 'agents')!)).toEqual([0, 1, 2, 3]);
    const short = sidebarCardsLayout(model(5, 8), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect(rowsOf(short)).toEqual([5, 5, 10]); // the projects down to the active one and `+N more`, then Agents loses rows
    expect(card(short, 'projects')?.lines).toEqual([{ kind: 'project', index: 0 }, { kind: 'more', count: 5 }, { kind: 'addProject' }]);
    expect(card(short, 'agents')?.lines.filter((line) => line.kind !== 'blank').slice(-2)).toEqual([{ kind: 'more', count: 7 }, { kind: 'newAgent' }]);
    expect(card(sidebarCardsLayout(model(5, 4), 33, INITIAL_SIDEBAR_NAV, COLS), 'projects')?.rows).toBe(9);
    // The active project stays in view when it is not first; the window follows the cursor while the keys are in it.
    const late = model(0, 8, { projects: model(5, 0).projects.map((each, index) => ({ ...each, active: index === 4 })), activeProjectId: 'o4' });
    expect(card(sidebarCardsLayout(late, 22, INITIAL_SIDEBAR_NAV, COLS), 'projects')?.lines).toEqual([{ kind: 'project', index: 4 }, { kind: 'more', count: 5 }, { kind: 'addProject' }]);
    const onO1 = { ...INITIAL_SIDEBAR_NAV, box: 'projects' as const, projectKey: 'o1' };
    expect(card(sidebarCardsLayout(late, 22, onO1, COLS), 'projects')?.lines).toEqual([{ kind: 'project', index: 1 }, { kind: 'more', count: 5 }, { kind: 'addProject' }]);
  });

  // The height budget at 80x24 (22), a short (14) and a very short (8) sidebar, with 1 and 6 projects.
  it.each([
    [22, 0, [[0, 4], [5, 5], [11, 11]], [4, 10]],
    [22, 5, [[0, 5], [6, 5], [12, 10]], [5, 11]],
    [14, 0, [[0, 4], [4, 4], [8, 6]], []], // the gaps go before Agents is down to its least (its cursor row, `+N more` and its button)
    [14, 5, [[0, 5], [5, 4], [9, 5]], []],
    [8, 0, [[0, 4], [4, 4]], []], // Projects goes, the Project card keeps its coordinator row and its button
    [8, 5, [[0, 4], [4, 4]], []],
  ] as const)('lays out %i rows with %i other projects and 8 agents', (rows, others, cards, gaps) => {
    const layout = sidebarCardsLayout(model(others, 8), rows, INITIAL_SIDEBAR_NAV, COLS);
    expect(layout.cards.map((each) => [each.y, each.rows])).toEqual(cards);
    expect(gapRows(layout)).toEqual(gaps);
    const { lines } = render(model(others, 8), { rows });
    for (const y of gaps) expect(lines[y]).toBe(' '.repeat(COLS));
  });

  it('keeps the gaps in a short sidebar while every card keeps its rows', () => {
    const one = sidebarCardsLayout(model(0, 1), 15, INITIAL_SIDEBAR_NAV, COLS);
    expect(one.cards.map((each) => [each.y, each.rows])).toEqual([[0, 4], [5, 4], [10, 5]]);
    expect(gapRows(one)).toEqual([4, 9]);
    const few = sidebarCardsLayout(model(0, 1), 12, INITIAL_SIDEBAR_NAV, COLS);
    expect(few.cards.map((each) => [each.y, each.rows])).toEqual([[0, 4], [4, 4], [8, 4]]); // the gaps go before Projects goes
    expect(gapRows(few)).toEqual([]);
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
            { ...INITIAL_SIDEBAR_NAV, box: 'project' as const },
            { ...INITIAL_SIDEBAR_NAV, box: 'projects' as const, onButton: true as const },
            { ...INITIAL_SIDEBAR_NAV, box: 'agents' as const, agentKey: sidebar.agents.at(-1)?.key ?? null, onButton: true as const },
          ];
          for (const nav of navs) {
            const layout = sidebarCardsLayout(sidebar, rows, nav, COLS);
            const where = `${agents} agents, ${JSON.stringify(nav)}: ${JSON.stringify(layout.cards.map((each) => [each.y, each.rows]))}`;
            // The cards fill the rows exactly, top to bottom, at most one gap row between two, and each has room for its lines.
            const last = layout.cards.at(-1)!;
            expect(last.y + last.rows, where).toBe(rows);
            layout.cards.forEach((each, index) => {
              const before = index === 0 ? 0 : layout.cards[index - 1].y + layout.cards[index - 1].rows;
              expect(each.y - before, where).toBeGreaterThanOrEqual(0);
              expect(each.y - before, where).toBeLessThanOrEqual(1);
              expect(each.lines.length, where).toBeLessThanOrEqual(Math.max(0, each.rows - 2));
            });
            // The cursor's row is drawn: an item, or the button it is on.
            const cursorRow = nav.box === 'agents'
              ? layout.onButton
                ? rowOfLine(layout, 'agents', (line) => line.kind === 'newAgent')
                : rowOfLine(layout, 'agents', (line) => (line.kind === 'agent' || (line.kind === 'block' && line.part === 'title')) && line.index === layout.agentIndex)
              : nav.box === 'project'
                ? rowOfLine(layout, 'project', (line) => line.kind === 'settings')
                : layout.onButton
                  ? rowOfLine(layout, 'projects', (line) => line.kind === 'addProject')
                  : rowOfLine(layout, 'projects', (line) => line.kind === 'project' && line.index === layout.projectIndex);
            expect(cursorRow, where).toBeGreaterThanOrEqual(0);
            // A card with two body rows or more has its button on its last body row.
            for (const [name, button] of [['projects', 'addProject'], ['project', 'settings'], ['agents', 'newAgent']] as const) {
              const each = card(layout, name);
              if (!each || each.rows - 2 < 2) continue;
              expect(each.lines.length, `${where} ${name}`).toBe(each.rows - 2);
              expect(each.lines.at(-1)?.kind, `${where} ${name}`).toBe(button);
            }
            // Agents lose rows only once Projects is down to its least.
            const agentsCard = card(layout, 'agents')!;
            const shownAgents = titles(agentsCard).length;
            const projects = card(layout, 'projects');
            const listed = (lines: CardLayout['lines']) => lines.filter((line) => !['blank', 'addProject', 'newAgent'].includes(line.kind));
            if (shownAgents < agents && projects) expect(listed(projects.lines).length, where).toBeLessThanOrEqual(2);
            // A cut list says how many are left out.
            if (shownAgents < agents && agentsCard.rows - 2 >= 3) {
              expect(listed(agentsCard.lines).at(-1), where).toEqual({ kind: 'more', count: agents - shownAgents });
            }
          }
        }
      });
    }
  }

  describe('padding and row spacing', () => {
    const BUTTONS = ['addProject', 'settings', 'newAgent'];
    /** A card's list items (an agent's rows are one item), the blank rows before the first, between items and after the last. */
    function shape(each: CardLayout) {
      const lines = each.lines;
      const button = lines.length > 0 && BUTTONS.includes(lines.at(-1)!.kind) ? 1 : 0;
      const body = lines.slice(0, lines.length - button);
      const firstItem = body.findIndex((line) => line.kind !== 'blank');
      const lastItem = body.length - 1 - [...body].reverse().findIndex((line) => line.kind !== 'blank');
      const items: string[] = [];
      const between: number[] = [];
      let blanks = 0;
      body.slice(firstItem, lastItem + 1).forEach((line) => {
        if (line.kind === 'blank') { blanks += 1; return; }
        const key = 'index' in line && ['agent', 'block'].includes(line.kind) ? `agent:${line.index}` : `${line.kind}:${items.length}`;
        if (items.at(-1) !== key || blanks > 0) {
          if (items.length > 0) between.push(blanks);
          items.push(key);
        }
        blanks = 0;
      });
      // Two agent boxes side by side take no spacing row: their borders set them apart.
      const pairs = items.slice(1).filter((item, index) => !(item.startsWith('agent:') && items[index].startsWith('agent:'))).length;
      return {
        button: button === 1, items: items.length, pairs, between, top: Math.max(0, firstItem), after: body.length - 1 - lastItem,
        more: lines.some((line) => line.kind === 'more'), spare: lines.filter((line) => line.kind === 'blank').length,
      };
    }

    const few = () => model(1, 2, { tasks: { todo: 1 } });
    const many = () => model(20, 20, { tasks: { todo: 1 } });
    const expandedNav = (sidebar: SidebarModel): SidebarNav => ({ ...INITIAL_SIDEBAR_NAV, agentKey: sidebar.agents[1].key, expanded: new Set([sidebar.agents[1].key]) });

    for (const rows of [14, 22, 30, 40]) {
      for (const [name, make, expand] of [['few', few, false], ['many', many, false], ['few, one expanded', few, true], ['many, one expanded', many, true]] as const) {
        it(`pads and spaces each card in ${rows} rows (${name}) only with the rows it has spare, never half-spaced`, () => {
          const sidebar = make();
          const nav = expand ? expandedNav(sidebar) : INITIAL_SIDEBAR_NAV;
          const layout = sidebarCardsLayout(sidebar, rows, nav, COLS);
          for (const each of layout.cards) {
            const where = `${rows} ${name} ${each.card}: ${JSON.stringify(each.lines)}`;
            const got = shape(each);
            // A list never looks half-spaced: no blank row between any two items, or one between every two.
            expect(new Set(got.between).size, where).toBeLessThanOrEqual(1);
            expect(got.between.every((blank) => blank <= 1), where).toBe(true);
            const spaced = got.between.length > 0 && got.between[0] === 1;
            if (got.more) {
              // Items behind `+N more`: no padding and no spacing (a window of whole blocks may leave a row above the button).
              expect([spaced, got.top], where).toEqual([false, 0]);
              continue;
            }
            // Every item shown: spacing first, then the rest below the list, as the spare rows allow; never a blank row
            // above the first item (the body starts with it).
            const spacing = got.pairs;
            expect(spaced, where).toBe(spacing > 0 && got.spare >= spacing);
            const rest = got.spare - (spaced ? spacing : 0);
            if (got.items > 0) expect(each.lines[0].kind, where).not.toBe('blank');
            expect(got.top, where).toBe(0);
            expect(got.after, where).toBe(rest);
            // Blank rows target nothing.
            each.lines.forEach((line, offset) => {
              if (line.kind === 'blank') expect(sidebarCardTarget(layout, 5, each.y + 1 + offset), where).toBeNull();
            });
          }
          // The cursor's row stays in view, with its bar (only the item row is the cursor's).
          const cursorRow = rowOfLine(layout, 'agents', (line) => (line.kind === 'agent' || (line.kind === 'block' && line.part === 'title')) && line.index === layout.agentIndex);
          expect(cursorRow).toBeGreaterThan(0);
          const { frame } = render(sidebar, { rows, nav, focus: 'agents' });
          const { frame: unfocused } = render(sidebar, { rows, nav, focus: null });
          const style = (each: Frame, y: number) => JSON.stringify(each.cells[y * COLS + 5].style);
          // The focused card's borders change too: only its body rows count.
          const agentsCard = card(layout, 'agents')!;
          const barRows = Array.from({ length: agentsCard.rows - 2 }, (_, offset) => agentsCard.y + 1 + offset).filter((y) => style(frame, y) !== style(unfocused, y));
          expect(barRows).toEqual([cursorRow]);
        });
      }
    }

    it('pads and spaces every card at 40 rows with few items', () => {
      const { lines } = render(few(), { rows: 40 });
      const empty = (count: number) => Array.from({ length: count }, () => '│                                │');
      expect(lines.slice(0, 13)).toEqual([
        '┌─ [ PROJECTS ] ────────────── 2 ┐',
        '│ ▸ orc-state          [RUNNING] │', // no blank row above the first item
        ...empty(1), // the spacing
        '│   o1              [STOPPED] !2 │',
        ...empty(6), // the rows the list leaves, below it
        '│ [ + ADD PROJECT ]              │',
        '└────────────────────────────────┘',
        ' '.repeat(COLS),
      ]);
      expect(lines.slice(13, 26)).toEqual([
        '┌─ [ ORC-STATE ] ────────────────┐',
        '│ coordinator          [RUNNING] │',
        ...empty(1),
        '│ workers 2/4                    │',
        ...empty(1),
        '│ tasks 1 todo                   │',
        ...empty(4),
        '│ [ SETTINGS ]                   │',
        '└────────────────────────────────┘',
        ' '.repeat(COLS),
      ]);
      const agents = card(sidebarCardsLayout(few(), 40, INITIAL_SIDEBAR_NAV, COLS), 'agents')!;
      // Two boxes take no spacing row between them: their borders set them apart; the first box starts the body.
      const box = (index: number, ...parts: string[]) => parts.map((part) => ({ kind: 'block', index, part }));
      expect(agents.lines.slice(0, 8)).toEqual([
        ...box(0, 'top', 'title', 'question', 'bottom'), ...box(1, 'top', 'title', 'bottom'), { kind: 'blank' },
      ]);
    });

    it('drops the blank rows below the list, then the spacing, before an item goes behind `+N more`', () => {
      // Projects with 3 projects: list 3, button 1; its body rows decide.
      const projectsAt = (body: number) => {
        const sidebar = model(2, 0);
        // The Projects card takes its share: a third of the rows less the gaps.
        for (let rows = 8; rows <= 60; rows += 1) {
          const layout = sidebarCardsLayout(sidebar, rows, INITIAL_SIDEBAR_NAV, COLS);
          const each = card(layout, 'projects');
          if (each && each.rows - 2 === body) return each.lines.map((line) => line.kind);
        }
        throw new Error(`no height gives ${body} body rows`);
      };
      expect(projectsAt(8)).toEqual(['project', 'blank', 'project', 'blank', 'project', 'blank', 'blank', 'addProject']);
      expect(projectsAt(7)).toEqual(['project', 'blank', 'project', 'blank', 'project', 'blank', 'addProject']); // one row less below the list
      expect(projectsAt(6)).toEqual(['project', 'blank', 'project', 'blank', 'project', 'addProject']); // none below it
      expect(projectsAt(5)).toEqual(['project', 'project', 'project', 'blank', 'addProject']); // spacing whole or not at all; the row goes below the list
      expect(projectsAt(4)).toEqual(['project', 'project', 'project', 'addProject']);
    });

    it('never lets spacing make the Agents card grow: its need is its content, padding and spacing take only rows it has', () => {
      // 3 agents (boxes of 4, 3 and 3 rows) and the button need 13 rows: the others shrink to their content.
      for (const rows of [22, 30, 40]) {
        const flat = sidebarCardsLayout(model(0, 3), rows, INITIAL_SIDEBAR_NAV, COLS);
        const share = Math.floor((rows - 2) / 3);
        const [projects, project, agents] = flat.cards;
        expect(projects.rows, `${rows}`).toBeLessThanOrEqual(share);
        expect(project.rows, `${rows}`).toBeLessThanOrEqual(share);
        // Agents takes at most its content's rows beyond its share, whatever the spacing would want.
        expect(agents.rows, `${rows}`).toBeLessThanOrEqual(Math.max(rows - 2 - 2 * share, 2 + 10 + 1));
      }
      expect(rowsOf(sidebarCardsLayout(model(0, 3), 22, INITIAL_SIDEBAR_NAV, COLS))).toEqual([4, 5, 11]);
      // At 24 rows the Agents content (13 rows) fits after the others give up their spare rows: no spacing, no padding.
      const at24 = card(sidebarCardsLayout(model(0, 3), 24, INITIAL_SIDEBAR_NAV, COLS), 'agents')!;
      expect(at24.rows).toBe(13);
      expect(at24.lines.some((line) => line.kind === 'blank')).toBe(false);
    });

    it('keeps an expanded block whole: no spacing goes between two boxes or inside one', () => {
      const sidebar = few();
      const layout = sidebarCardsLayout(sidebar, 40, expandedNav(sidebar), COLS);
      const lines = card(layout, 'agents')!.lines;
      const top = lines.findIndex((line) => line.kind === 'block' && line.part === 'top');
      const bottom = lines.findIndex((line) => line.kind === 'block' && line.part === 'bottom');
      expect(lines.slice(top, bottom + 1).every((line) => line.kind === 'block')).toBe(true);
      expect(lines[0]).toEqual({ kind: 'block', index: 0, part: 'top' }); // no blank row above the first box
      const expandedTop = lines.findIndex((line) => line.kind === 'block' && line.index === 1 && line.part === 'top');
      expect(lines[expandedTop - 1]).toEqual({ kind: 'block', index: 0, part: 'bottom' });
      // A click on a blank row below the boxes hits nothing.
      const agents = card(layout, 'agents')!;
      const blankRow = agents.y + 1 + lines.findIndex((line) => line.kind === 'blank');
      expect(blankRow).toBeGreaterThan(agents.y + 1);
      expect(sidebarCardTarget(layout, 5, blankRow)).toBeNull();
      expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, blankRow)).toBeNull();
    });
  });

  it('drops Projects before the Agents card loses its last body row, unless the cursor is in it', () => {
    expect(rowsOf(sidebarCardsLayout(model(5, 8), 7, INITIAL_SIDEBAR_NAV, COLS))).toEqual([4, 3]);
    const inProjects = sidebarCardsLayout(model(5, 8), 10, { ...INITIAL_SIDEBAR_NAV, box: 'projects', projectKey: 'o4', agentKey: null }, COLS);
    expect(rowsOf(inProjects)).toEqual([5, 4, 1]);
    expect(card(inProjects, 'projects')?.lines).toEqual([{ kind: 'project', index: 4 }, { kind: 'more', count: 5 }, { kind: 'addProject' }]);
  });

  it('keeps the settings button when the Project card is down to one body row with the cursor on it, else the coordinator row', () => {
    const shrunk = (box: SidebarNav['box']) => card(sidebarCardsLayout(model(0, 8), 3, { ...INITIAL_SIDEBAR_NAV, box }, COLS), 'project')!.lines;
    expect(shrunk('project')).toEqual([{ kind: 'settings' }]);
    expect(shrunk('agents')).toEqual([{ kind: 'coordinator' }]);
  });
});

describe('sidebar navigation (keys move in the projects, project and agents boxes)', () => {
  const view = (nav: SidebarNav) => sidebarCardsLayout(model(1, 3), 22, nav, COLS);

  it('moves the cursor with up and down, stopping at either end', () => {
    let nav: SidebarNav = INITIAL_SIDEBAR_NAV;
    nav = navigateSidebar(view(nav), nav, 'up').nav;
    expect(nav.agentKey).toBe('p1/a1');
    for (let i = 0; i < 5; i += 1) nav = navigateSidebar(view(nav), nav, 'down').nav;
    expect(nav.agentKey).toBe('p1/a3');
  });

  it('cycles the projects, project and agents boxes with Tab, back with Shift-Tab', () => {
    let nav: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'projects' };
    const boxes = [nav.box];
    for (let i = 0; i < 3; i += 1) {
      nav = navigateSidebar(view(nav), nav, 'switchBox').nav;
      boxes.push(nav.box);
    }
    expect(boxes).toEqual(['projects', 'project', 'agents', 'projects']);
    for (let i = 0; i < 3; i += 1) {
      nav = navigateSidebar(view(nav), nav, 'prevBox').nav;
      boxes.push(nav.box);
    }
    expect(boxes.slice(4)).toEqual(['agents', 'project', 'projects']);
    expect(view({ ...nav, box: 'project' }).cursorCard).toBe('project');
  });

  it('moves over every project in model order, the active one included, and opens the one under the cursor', () => {
    // Registry order a, b (active), c: drawn in that order.
    const shuffled = model(0, 1, { projects: [project('a'), project('b', { active: true }), project('c')], activeProjectId: 'b' });
    const at = (nav: SidebarNav) => sidebarCardsLayout(shuffled, 22, nav, COLS);
    let nav: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'projects' };
    expect(at(nav).projectIndex).toBe(1); // the projects cursor starts on the active project
    expect(navigateSidebar(at(nav), nav, 'open').command).toEqual({ type: 'openProject', projectId: 'b' });
    const visited: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      nav = navigateSidebar(at(nav), nav, 'down').nav;
      visited.push(nav.projectKey!);
    }
    expect(visited).toEqual(['c', 'c', 'c']);
    for (let i = 0; i < 3; i += 1) nav = navigateSidebar(at(nav), nav, 'up').nav;
    expect(nav.projectKey).toBe('a');
    const step = navigateSidebar(at(nav), nav, 'open');
    expect(step.command).toEqual({ type: 'openProject', projectId: 'a' });
    expect(step.nav.agentKey).toBeNull(); // another project's agents start at the top
    // The rows a click hits are the projects drawn there, in order.
    const projects = card(at(nav), 'projects')!;
    expect([1, 2, 3].map((row) => shuffled.projects[sidebarCardTarget(at(nav), 4, projects.y + row)!.index].project_id)).toEqual(['a', 'b', 'c']);
    expect(sidebarCardClick(at(nav), INITIAL_SIDEBAR_NAV, 4, projects.y + 3)?.command).toEqual({ type: 'openProject', projectId: 'c' });
  });

  it('expands the cursor agent with expand and collapses it with collapse, each a no-op when it already is', () => {
    const nav: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'agents' };
    const v = view(nav);
    const key = v.model.agents[v.agentIndex].key;
    const opened = navigateSidebar(v, nav, 'expand');
    expect(opened.nav.expanded.has(key)).toBe(true);
    expect(navigateSidebar(view(opened.nav), opened.nav, 'expand')).toEqual({ nav: opened.nav, command: null });
    const closed = navigateSidebar(view(opened.nav), opened.nav, 'collapse');
    expect(closed.nav.expanded.has(key)).toBe(false);
    expect(navigateSidebar(view(closed.nav), closed.nav, 'collapse')).toEqual({ nav: closed.nav, command: null });
    const project: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'project' };
    expect(navigateSidebar(view(project), project, 'expand')).toEqual({ nav: project, command: null });
  });

  it('opens the active project\'s settings with Enter in the project box; up and down stay on the button', () => {
    const nav: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'project' };
    expect(navigateSidebar(view(nav), nav, 'open')).toEqual({ nav, command: { type: 'openSettings', projectId: 'p1' } });
    expect(navigateSidebar(view(nav), nav, 'down')).toEqual({ nav, command: null });
    expect(navigateSidebar(view(nav), nav, 'toggle')).toEqual({ nav, command: null });
    const none = sidebarCursor(model(0, 0, { projects: [], activeProjectId: null, notice: 'no registered projects' }), nav);
    expect(navigateSidebar(none, nav, 'open').command).toBeNull();
  });

  it('expands and collapses an agent with Enter, never opening its tab, and returns to the pane with Esc', () => {
    const nav = navigateSidebar(view(INITIAL_SIDEBAR_NAV), INITIAL_SIDEBAR_NAV, 'down').nav;
    const expanded = navigateSidebar(view(nav), nav, 'open');
    expect(expanded.command).toBeNull();
    expect([...expanded.nav.expanded]).toEqual(['p1/a2']);
    const collapsed = navigateSidebar(view(expanded.nav), expanded.nav, 'open');
    expect(collapsed.command).toBeNull();
    expect(collapsed.nav.expanded.size).toBe(0);
    expect(navigateSidebar(view(nav), nav, 'back')).toEqual({ nav, command: { type: 'focusSlot' } });
  });

  it('puts the cursor of an empty box on its button; without an active project the agents box opens nothing', () => {
    const empty = sidebarCursor(model(1, 0), INITIAL_SIDEBAR_NAV);
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'open').command).toEqual({ type: 'newAgent', projectId: 'p1' });
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'down').nav).toEqual(INITIAL_SIDEBAR_NAV);
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'toggle').command).toBeNull();
    expect(navigateSidebar(empty, INITIAL_SIDEBAR_NAV, 'kill').command).toBeNull();
    const none = model(0, 0, { projects: [], activeProjectId: null, notice: 'no registered projects' });
    expect(navigateSidebar(sidebarCursor(none, INITIAL_SIDEBAR_NAV), INITIAL_SIDEBAR_NAV, 'open').command).toBeNull();
    const projects: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'projects' };
    expect(navigateSidebar(sidebarCursor(none, projects), projects, 'open').command).toEqual({ type: 'addProject' });
    // No active project: no new-agent button to land on.
    expect(card(sidebarCardsLayout(none, 22, INITIAL_SIDEBAR_NAV, COLS), 'agents')!.lines.some((line) => line.kind === 'newAgent')).toBe(false);
  });

  it('moves down past the last project onto [ + ADD PROJECT ] and past the last agent onto [ + NEW AGENT ]; Enter presses them', () => {
    let nav: SidebarNav = { ...INITIAL_SIDEBAR_NAV, box: 'projects' };
    for (let i = 0; i < 2; i += 1) nav = navigateSidebar(view(nav), nav, 'down').nav;
    expect(nav).toMatchObject({ box: 'projects', projectKey: 'o1', onButton: true });
    expect(view(nav).onButton).toBe(true);
    expect(navigateSidebar(view(nav), nav, 'down').nav).toBe(nav); // the button is the end
    expect(navigateSidebar(view(nav), nav, 'open')).toEqual({ nav, command: { type: 'addProject' } });
    // Up returns to the last project, and Enter opens it again.
    const back = navigateSidebar(view(nav), nav, 'up').nav;
    expect(back.onButton).toBeUndefined();
    expect(back.projectKey).toBe('o1');
    expect(navigateSidebar(view(back), back, 'open').command).toEqual({ type: 'openProject', projectId: 'o1' });

    nav = INITIAL_SIDEBAR_NAV;
    for (let i = 0; i < 3; i += 1) nav = navigateSidebar(view(nav), nav, 'down').nav;
    expect(nav).toMatchObject({ box: 'agents', agentKey: 'p1/a3', onButton: true });
    expect(navigateSidebar(view(nav), nav, 'open')).toEqual({ nav, command: { type: 'newAgent', projectId: 'p1' } });
    // On the button Space and the kill key do nothing; Tab leaves it.
    expect(navigateSidebar(view(nav), nav, 'toggle')).toEqual({ nav, command: null });
    expect(navigateSidebar(view(nav), nav, 'kill')).toEqual({ nav, command: null });
    expect(navigateSidebar(view(nav), nav, 'switchBox').nav.onButton).toBeUndefined();
    const up = navigateSidebar(view(nav), nav, 'up').nav;
    expect(up).toMatchObject({ agentKey: 'p1/a3' });
    expect(up.onButton).toBeUndefined();
  });

  it('draws the cursor bar on the button the cursor is on, not on the item before it', () => {
    const nav: SidebarNav = { ...INITIAL_SIDEBAR_NAV, agentKey: 'p1/a3', onButton: true };
    const { frame, layout, lines } = render(model(1, 3), { focus: 'agents', nav, theme: AMBER });
    const button = lines.findIndex((line) => line.includes('[ + NEW AGENT ]'));
    const a3 = lines.findIndex((line) => line.includes('a3 '));
    expect(button).toBe(card(layout, 'agents')!.y + card(layout, 'agents')!.rows - 2);
    expect(frame.cells[button * COLS + 25].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(frame.cells[button * COLS + 2].style).toMatchObject({ fg: styleOf(AMBER, 'button').fg });
    expect(frame.cells[a3 * COLS + 6].style.bg).toEqual({ type: 'default' });
  });
});

describe('sidebarCardTarget and sidebarCardClick', () => {
  const ROWS = 30;
  const { layout, lines } = render(model(2, 3, { tasks: { todo: 1 } }), { rows: ROWS });
  const rowOf = (part: string) => lines.findIndex((line) => line.includes(part));

  it('hits each card\'s rows: each project, the active project on its coordinator, workers and tasks rows, each agent on both its rows', () => {
    expect(sidebarCardTarget(layout, 5, rowOf('orc-state'))).toEqual({ card: 'projects', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 5, rowOf('o1 '))).toEqual({ card: 'projects', index: 1, onMarker: false });
    expect(sidebarCardTarget(layout, 30, rowOf('o2 '))).toEqual({ card: 'projects', index: 2, onMarker: false });
    for (const part of ['coordinator', 'workers', 'tasks 1 todo']) expect(sidebarCardTarget(layout, 5, rowOf(part))).toEqual({ card: 'project', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 10, rowOf('a1 '))).toEqual({ card: 'agents', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 10, rowOf('? question 1'))).toEqual({ card: 'agents', index: 0, onMarker: false });
    expect(sidebarCardTarget(layout, 10, rowOf('a3 '))).toEqual({ card: 'agents', index: 2, onMarker: false });
    // An agent's box borders hit the agent too: its top and bottom rows and its sides.
    expect(sidebarCardTarget(layout, 10, rowOf('a2 ') - 1)).toEqual({ card: 'agents', index: 1, onMarker: false });
    expect(sidebarCardTarget(layout, 10, rowOf('a2 ') + 1)).toEqual({ card: 'agents', index: 1, onMarker: false });
    expect(sidebarCardTarget(layout, 1, rowOf('a2 '))).toEqual({ card: 'agents', index: 1, onMarker: false });
    expect(sidebarCardTarget(layout, COLS - 2, rowOf('a2 '))).toEqual({ card: 'agents', index: 1, onMarker: false });
  });

  it('hits the settings button on its columns only, and a click on it opens the active project\'s settings', () => {
    const y = rowOf('[ SETTINGS ]');
    expect(lines[y].slice(2, 14)).toBe('[ SETTINGS ]');
    expect([1, 2, 13, 14].map((x) => sidebarCardTarget(layout, x, y)?.settings ?? null)).toEqual([null, true, true, null]);
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 8, y)).toEqual({ nav: { ...INITIAL_SIDEBAR_NAV, box: 'project' }, command: { type: 'openSettings', projectId: 'p1' } });
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 20, y)).toBeNull();
  });

  it('hits [ + ADD PROJECT ] and [ + NEW AGENT ] on their columns only; a click asks for a new project or a new agent of the active project', () => {
    for (const [label, action, box, command] of [
      ['[ + ADD PROJECT ]', 'addProject', 'projects', { type: 'addProject' }],
      ['[ + NEW AGENT ]', 'newAgent', 'agents', { type: 'newAgent', projectId: 'p1' }],
    ] as const) {
      const y = rowOf(label);
      const each = card(layout, box)!;
      expect(y, label).toBe(each.y + each.rows - 2); // the card's last body row
      expect(lines[y].slice(2, 2 + label.length)).toBe(label);
      expect([1, 2, 1 + label.length, 2 + label.length].map((x) => sidebarCardTarget(layout, x, y)?.action ?? null)).toEqual([null, action, action, null]);
      expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 6, y)).toEqual({ nav: { ...INITIAL_SIDEBAR_NAV, box, onButton: true }, command });
      expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 25, y)).toBeNull();
    }
    // A click on an item after one on a button puts the cursor back on the item.
    const onButton: SidebarNav = { ...INITIAL_SIDEBAR_NAV, onButton: true };
    expect(sidebarCardClick(layout, onButton, 8, rowOf('a2 '))?.nav.onButton).toBeUndefined();
    // Gap rows stay untargetable next to the buttons.
    for (const y of gapRows(layout)) expect(sidebarCardTarget(layout, 5, y)).toBeNull();
  });

  it('says when a click hits the collapse marker, and only on the agent\'s first row', () => {
    const y = rowOf('a2 ');
    expect(lines[y].slice(3, 6)).toBe('[+]');
    expect([2, 3, 4, 5, 6].map((x) => sidebarCardTarget(layout, x, y)?.onMarker)).toEqual([false, true, true, true, false]);
    expect(sidebarCardTarget(layout, 4, rowOf('? question 1'))?.onMarker).toBe(false);
    expect(sidebarCardTarget(layout, 4, y - 1)?.onMarker).toBe(false); // the box's top border
  });

  it('hits nothing on borders, gap rows, blank rows, the notice row and `+N more` lines', () => {
    expect(sidebarCardTarget(layout, 5, 0)).toBeNull(); // the Projects card's top border
    expect(sidebarCardTarget(layout, 0, rowOf('coordinator'))).toBeNull(); // the left border
    expect(sidebarCardTarget(layout, COLS - 1, rowOf('coordinator'))).toBeNull(); // the right border
    for (const y of gapRows(layout)) {
      for (const x of [0, 5, COLS - 1]) expect(sidebarCardTarget(layout, x, y)).toBeNull();
      expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, y)).toBeNull();
    }
    expect(gapRows(layout)).toHaveLength(2);
    expect(sidebarCardTarget(layout, 5, rowOf('[ PROJECTS ]'))).toBeNull();
    expect(sidebarCardTarget(layout, 5, rowOfLine(layout, 'agents', (line) => line.kind === 'blank'))).toBeNull(); // a blank row of the Agents card
    expect(sidebarCardTarget(layout, 5, ROWS - 1)).toBeNull(); // its bottom border
    const noticed = render(model(0, 1, { notice: 'registry error: boom' }));
    expect(sidebarCardTarget(noticed.layout, 5, noticed.lines.findIndex((line) => line.includes('registry error')))).toBeNull();
    const none = sidebarCardsLayout(model(0, 0, { projects: [], activeProjectId: null, notice: 'no registered projects' }), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect([2, 9].map((y) => sidebarCardTarget(none, 5, y))).toEqual([null, null]); // `(none)` and the notice, each below its card's padding
    const blank = rowOfLine(none, 'projects', (line) => line.kind === 'blank');
    expect(blank).toBeGreaterThan(0);
    expect(sidebarCardTarget(none, 5, blank)).toBeNull(); // a blank row above the Projects card's button
    const cut = sidebarCardsLayout(model(5, 8), 22, INITIAL_SIDEBAR_NAV, COLS);
    expect(sidebarCardTarget(cut, 5, rowOfLine(cut, 'projects', (line) => line.kind === 'more'))).toBeNull();
  });

  it('opens the project a click hits and expands the agent; the cursor box follows', () => {
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, rowOf('coordinator'))).toEqual({
      nav: { ...INITIAL_SIDEBAR_NAV, box: 'projects', projectKey: 'p1', agentKey: null }, command: { type: 'openProject', projectId: 'p1' },
    });
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, rowOf('o2 '))?.command).toEqual({ type: 'openProject', projectId: 'o2' });
    // A click on an agent's row expands it (only its OPEN opens its tab).
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 8, rowOf('a2 '))).toEqual({
      nav: { ...INITIAL_SIDEBAR_NAV, box: 'agents', projectKey: null, agentKey: 'p1/a2', expanded: new Set(['p1/a2']) }, command: null,
    });
    expect(sidebarCardClick(layout, INITIAL_SIDEBAR_NAV, 5, 0)).toBeNull();
  });
});

describe('drawSidebarCards', () => {
  it('draws the Projects, Project and Agents cards at 80x24, wide names in their display width', () => {
    const sidebar = model(1, 2, {
      projects: [project('p1', { name: CJK_PROJECT, active: true }), project('o1', { state: 'stopped', connection: 'stopped', attention: 2 })],
      agents: [agent(EMOJI_AGENT, { attention: 'permission_prompt', detail: '? may I run npm test' }), agent('thrall', { phase: 'review', elapsed: '8m' })],
      tasks: { todo: 2, in_progress: 1 },
    });
    const { lines } = render(sidebar);
    expect(lines).toEqual([
      '┌─ [ PROJECTS ] ────────────── 2 ┐',
      `│ ▸ ${CJK_PROJECT} [RUNNING] │`,
      '│   o1              [STOPPED] !2 │',
      '│ [ + ADD PROJECT ]              │',
      '└────────────────────────────────┘',
      ' '.repeat(COLS),
      `┌─ [ ${CJK_PROJECT} ] ${'─'.repeat(COLS - 9 - stringWidth(CJK_PROJECT))}┐`,
      '│ coordinator          [RUNNING] │',
      '│ workers 2/4                    │',
      '│ tasks 2 todo · 1 in progress   │',
      '│ [ SETTINGS ]                   │',
      '└────────────────────────────────┘',
      ' '.repeat(COLS),
      '┌─ [ AGENTS ] ─────────── 2 live ┐',
      // Two boxes and the button need a row more than the Agents card has: the second agent goes behind `+1 more`.
      '│┌──────────────────────────────┐│',
      '││ [+] agent-… 12m [PERMISSION] ││',
      '││     ? may I run npm test     ││',
      '│└──────────────────────────────┘│',
      '│ +1 more                        │',
      '│                                │',
      '│ [ + NEW AGENT ]                │',
      '└────────────────────────────────┘',
    ]);
    for (const line of lines) expect(stringWidth(line)).toBe(COLS);
  });

  it('shows the coordinator state once on the Project card, and says when there is no project', () => {
    const { layout: twoAgents, lines } = render(model(0, 2));
    const projectCard = card(twoAgents, 'project')!;
    expect(lines.slice(projectCard.y, projectCard.y + projectCard.rows).join('\n').match(/\[RUNNING\]/g)).toHaveLength(1);
    expect(lines.join('\n')).not.toMatch(/Status|STATUS|needs? you/);
    // No project: Projects still offers its button; the Project card has no settings and the Agents card no new-agent button.
    const none = render(model(1, 2, { status: { coordinator: null, workers: null, attention: 0 }, projects: [], activeProjectId: null, agents: [], notice: 'no registered projects' })).lines;
    expect(none.slice(0, 13)).toEqual([
      '┌─ [ PROJECTS ] ─────────────────┐', '│ (none)                         │', '│                                │', '│                                │',
      '│ [ + ADD PROJECT ]              │', '└────────────────────────────────┘', ' '.repeat(COLS),
      '┌─ [ PROJECT ] ──────────────────┐', '│ no registered projects         │', '│                                │', '│                                │',
      '│                                │', '└────────────────────────────────┘',
    ]);
    expect(none.join('\n')).not.toMatch(/SETTINGS|NEW AGENT/);
  });

  it('keeps the question or reason row only for agents needing attention', () => {
    const { lines } = render(model(0, 4), { rows: 40 });
    const agentRows = lines.slice(lines.findIndex((line) => line.includes('AGENTS')) + 1);
    const top = '│┌──────────────────────────────┐│';
    const bottom = '│└──────────────────────────────┘│';
    // Every agent is a box; the question row sits inside it, under the name.
    expect(agentRows.slice(0, 14)).toEqual([
      top, '││ [+] a1 worker 12m [QUESTION] ││', '││     ? question 1             ││', bottom,
      top, '││ [+] a2       12m [IMPLEMENT] ││', bottom,
      top, '││ [+] a3       12m [IMPLEMENT] ││', bottom,
      top, '││ [+] a4 worker 12m [QUESTION] ││', '││     ? question 4             ││', bottom,
    ]);
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

  it('draws the focused card\'s border in chrome.borderFocus and the cursor row in row.cursor, in each of the three boxes', () => {
    const onActive = render(model(1, 3), { focus: 'projects', theme: AMBER });
    const active = onActive.lines.findIndex((line) => line.includes('orc-state'));
    const other = onActive.lines.findIndex((line) => line.includes('o1 '));
    const settings = onActive.lines.findIndex((line) => line.includes('[ SETTINGS ]'));
    const projectTop = onActive.lines.findIndex((line) => line.includes('[ ORC-STATE ]'));
    expect(onActive.frame.cells[0].style).toEqual(styleOf(AMBER, 'chrome.borderFocus'));
    expect(onActive.frame.cells[projectTop * COLS].style).toEqual(styleOf(AMBER, 'chrome.border'));
    expect(onActive.frame.cells[active * COLS + 4].style).toMatchObject({ bg: styleOf(AMBER, 'row.cursor').bg, bold: true });
    expect(onActive.frame.cells[active * COLS + 1].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg); // the bar spans the padding
    expect(onActive.frame.cells[other * COLS + 4].style.bg).toEqual({ type: 'default' });
    // The active project's name and mark are in text.accent, the others in text.primary.
    const plainActive = render(model(1, 3), { theme: AMBER });
    expect(plainActive.frame.cells[active * COLS + 2].style).toEqual(styleOf(AMBER, 'text.accent'));
    expect(plainActive.frame.cells[active * COLS + 4].style).toEqual(styleOf(AMBER, 'text.accent'));
    expect(plainActive.frame.cells[other * COLS + 4].style).toEqual(styleOf(AMBER, 'text.primary'));
    expect(plainActive.frame.cells[settings * COLS + 2].style).toEqual(styleOf(AMBER, 'button'));

    const onOther = render(model(1, 3), { focus: 'projects', nav: { ...INITIAL_SIDEBAR_NAV, box: 'projects', projectKey: 'o1', agentKey: null }, theme: AMBER });
    expect(onOther.frame.cells[other * COLS + 4].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(onOther.frame.cells[active * COLS + 4].style.bg).toEqual({ type: 'default' });
    // The badge keeps its own style on the cursor row.
    const badgeX = onOther.lines[other].indexOf('[STOPPED]');
    expect(onOther.frame.cells[other * COLS + badgeX].style).toEqual(styleOf(AMBER, 'status.warn.badge'));

    const onSettings = render(model(1, 3), { focus: 'project', nav: { ...INITIAL_SIDEBAR_NAV, box: 'project' }, theme: AMBER });
    expect(onSettings.frame.cells[0].style).toEqual(styleOf(AMBER, 'chrome.border'));
    expect(onSettings.frame.cells[projectTop * COLS].style).toEqual(styleOf(AMBER, 'chrome.borderFocus'));
    expect(onSettings.frame.cells[settings * COLS + 1].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(onSettings.frame.cells[settings * COLS + 20].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(onSettings.frame.cells[(settings - 1) * COLS + 2].style.bg).toEqual({ type: 'default' });

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
    const { frame, lines } = render(model(1, 3), { theme: AMBER, rows: 30 });
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
    const sidebar = model(5, 8, { notice: 'registry error: boom', agentsStale: true, tasks: { todo: 2 } });
    for (const rows of [8, 22]) {
      const text = (theme: typeof CLASSIC) => render(sidebar, { rows, focus: 'agents', theme }).lines;
      expect(text(BUILT_IN_THEMES.mono)).toEqual(text(AMBER));
      expect(text(CLASSIC)).toEqual(text(AMBER));
    }
  });

  it('drops an agent row\'s role whole when it does not fit, never cutting it to `…`', () => {
    const sidebar = model(0, 1, { agents: [agent('thrall', { role: 'reviewer' })] });
    const agentRow = (cols: number) => {
      const frame = createFrame(cols, 14);
      drawSidebarCards(frame, { x: 0, y: 0, cols, rows: 14 }, sidebarCardsLayout(sidebar, 14, INITIAL_SIDEBAR_NAV, cols), { focus: null, theme: CLASSIC });
      return Array.from({ length: 14 }, (_, y) => rowText(frame, y)).find((line) => line.includes('[+]'))!;
    };
    // The row is the title row inside the agent's box: its border a column more on each side.
    expect(agentRow(41)).toBe('││ [+] thrall reviewer 12m [IMPLEMENT] ││');
    expect(agentRow(40)).toBe('││ [+] thrall         12m [IMPLEMENT] ││');
    expect(agentRow(32)).toBe('││ [+] thrall 12m [IMPLEMENT] ││');
    for (let cols = 32; cols < 41; cols += 1) {
      const row = agentRow(cols);
      expect(row, `${cols}`).toMatch(/^││ \[\+\] thrall +12m \[IMPLEMENT\] ││$/);
    }
    // Narrower still, the name itself is cut as before.
    expect(agentRow(31)).toBe('││ [+] thra… 12m [IMPLEMENT] ││');
  });

  it('fits a narrow sidebar: badges and times give way to names, nothing spills', () => {
    for (const cols of [10, 16, 24]) {
      const frame = createFrame(cols + 4, 22);
      const layout = sidebarCardsLayout(model(2, 4, { tasks: { todo: 12, in_progress: 3 } }), 22, INITIAL_SIDEBAR_NAV, cols);
      drawSidebarCards(frame, { x: 0, y: 0, cols, rows: 22 }, layout, { focus: 'agents', theme: AMBER });
      const gaps = gapRows(layout);
      for (let y = 0; y < 22; y += 1) {
        expect(stringWidth(rowText(frame, y, 0, cols))).toBe(cols);
        if (gaps.includes(y)) expect(rowText(frame, y, 0, cols)).toBe(' '.repeat(cols));
        expect(rowText(frame, y, cols, 4)).toBe('    ');
      }
    }
  });
});

describe('expanded agents', () => {
  const MONO = BUILT_IN_THEMES.mono;
  const at = (agentKey: string, expanded: string[], box: 'agents' | 'projects' = 'agents'): SidebarNav => ({ ...INITIAL_SIDEBAR_NAV, box, agentKey, expanded: new Set(expanded) });
  /** 3 other projects; 4 agents with a task, provider and model, a1 asking a question long enough to wrap past two lines. */
  const details = (others = 3) => model(others, 4, {
    agents: model(others, 4).agents.map((each, index) => ({
      ...each, task_ref: 'cockpit-style/foo', provider: 'claude', model: 'opus',
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
    // Down from an expanded agent goes to its buttons first, then to the next agent.
    nav = navigateSidebar(view(nav), nav, 'down').nav;
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

  it('gives the Project card back the rows of a dropped Projects card', () => {
    const one = details(3);
    one.agents = one.agents.slice(1, 2);
    const layout = sidebarCardsLayout(one, 12, at('p1/a2', ['p1/a2']), COLS);
    expect(rowsOf(layout)).toEqual([4, 8]);
    expect(card(layout, 'project')!.lines.map((line) => line.kind)).toEqual(['coordinator', 'settings']);
    // Two expanded agents, the cursor on the second: the window shows its block and `+1 more`, the row it leaves goes to the Project card.
    const two = details(1);
    two.agents = two.agents.slice(1, 3);
    const both = sidebarCardsLayout(two, 13, at('p1/a3', ['p1/a2', 'p1/a3']), COLS);
    expect(rowsOf(both)).toEqual([4, 9]);
    expect(card(both, 'agents')!.lines.length).toBe(7);
  });

  const parts = (layout: SidebarCardsLayout, index = 0) => blockRows(layout, index).map((line) => (line.kind === 'block' ? line.part : ''));

  it('leaves out the activity line when it only repeats the task, the role or the phase the badge shows', () => {
    for (const detail of ['cockpit-style/foo', 'worker', 'implement', 'IMPLEMENT', null, '']) {
      const fallback = details(0);
      fallback.agents = [{ ...fallback.agents[1], detail }];
      const layout = sidebarCardsLayout(fallback, 22, at('p1/a2', ['p1/a2']), COLS);
      expect(parts(layout), String(detail)).toEqual(['top', 'title', 'model', 'task', 'buttons', 'bottom']);
    }
  });

  it('lays out a worker\'s block: the row, labelled provider · model and task, at most two unlabelled lines of its question, the buttons', () => {
    const layout = sidebarCardsLayout(details(0), 22, at('p1/a1', ['p1/a1']), COLS);
    expect(parts(layout)).toEqual(['top', 'title', 'model', 'task', 'detail', 'detail', 'buttons', 'bottom']);
    const { lines } = render(details(0), { nav: at('p1/a1', ['p1/a1']), focus: 'agents' });
    const top = lines.findIndex((line) => line.includes('[-] a1')) - 1;
    expect(lines.slice(top, top + 8).map((line) => line.trimEnd())).toEqual([
      '│┌──────────────────────────────┐│',
      '││ [-] a1 worker 12m [QUESTION] ││',
      '││ model  claude · opus         ││',
      '││ task   cockpit-style/foo     ││',
      '││ ? may I run npm test and     ││',
      '││ then a much longer question… ││',
      '││ [ OPEN ] [ KILL ]            ││',
      '│└──────────────────────────────┘│',
    ]);
    for (const line of lines) expect(stringWidth(line)).toBe(COLS);
    // The other agents stay collapsed boxes.
    const tall = render(details(0), { nav: at('p1/a1', ['p1/a1']), rows: 30 }).lines;
    const a2 = tall.findIndex((line) => line.includes('[+] a2'));
    expect(tall.slice(a2 - 1, a2 + 2).map((line) => line.replace(/[^│┌┐└┘]/g, ''))).toEqual(['│┌┐│', '││││', '│└┘│']);
  });

  it('shows a worker\'s activity when it says something, and no phase or provider row repeating the badge', () => {
    const { lines } = render(details(0), { nav: at('p1/a2', ['p1/a2']) });
    const top = lines.findIndex((line) => line.includes('[-] a2'));
    expect(lines.slice(top + 1, top + 5).map((line) => line.trimEnd())).toEqual([
      '││ model  claude · opus         ││',
      '││ task   cockpit-style/foo     ││',
      '││ doing  working on a2         ││',
      '││ [ OPEN ] [ KILL ]            ││',
    ]);
    expect(lines.some((line) => line.includes('implement ·'))).toBe(false);
  });

  it('draws the labels in text.muted and the values in text.primary; a long activity wraps beside its label', () => {
    const sidebar = details(0);
    sidebar.agents = [{ ...sidebar.agents[1], detail: 'editing lib/cockpit2/sidebarCards.ts and its tests for labels' }];
    const { frame, lines } = render(sidebar, { nav: at('p1/a2', ['p1/a2']), theme: AMBER });
    const top = lines.findIndex((line) => line.includes('[-] a2'));
    expect(lines.slice(top + 1, top + 5).map((line) => line.trimEnd())).toEqual([
      '││ model  claude · opus         ││',
      '││ task   cockpit-style/foo     ││',
      '││ doing  editing               ││',
      '││        lib/cockpit2/sidebar… ││',
    ]);
    const style = (x: number, y: number) => frame.cells[y * COLS + x].style;
    for (const row of [top + 1, top + 2, top + 3]) {
      expect(style(3, row), `label ${row}`).toEqual(styleOf(AMBER, 'text.muted'));
      expect(style(10, row), `value ${row}`).toEqual(styleOf(AMBER, 'text.primary'));
    }
    expect(style(16, top + 1)).toEqual(styleOf(AMBER, 'text.muted')); // the ` · ` between provider and model
  });

  it('gives a scout its brief instead of a task row, no `scout` or state row; an unknown provider is `-`, an unknown model `default`', () => {
    const sidebar = details(0);
    sidebar.agents = [agent('s1', { role: 'scout', phase: 'running', detail: 'scout', task_ref: null, provider: 'codex', model: null, brief: null })];
    expect(parts(sidebarCardsLayout(sidebar, 22, at('p1/s1', ['p1/s1']), COLS))).toEqual(['top', 'title', 'model', 'buttons', 'bottom']);
    sidebar.agents = [{ ...sidebar.agents[0], brief: 'find the errors in docs/contracts.md and docs/cli.md' }];
    expect(parts(sidebarCardsLayout(sidebar, 22, at('p1/s1', ['p1/s1']), COLS))).toEqual(['top', 'title', 'model', 'brief', 'buttons', 'bottom']);
    const { lines } = render(sidebar, { nav: at('p1/s1', ['p1/s1']) });
    const top = lines.findIndex((line) => line.includes('[-] s1')) - 1;
    expect(lines.slice(top, top + 6).map((line) => line.trimEnd())).toEqual([
      '│┌──────────────────────────────┐│',
      '││ [-] s1 scout   12m [RUNNING] ││',
      '││ model  codex · default       ││',
      '││ brief  find the errors in d… ││',
      '││ [ OPEN ] [ KILL ]            ││',
      '│└──────────────────────────────┘│',
    ]);
    const unknown = details(0);
    unknown.agents = [{ ...unknown.agents[1], provider: null, model: null }];
    expect(render(unknown, { nav: at('p1/a2', ['p1/a2']) }).lines.some((line) => line.includes('││ model  - · default   '))).toBe(true);
  });

  it('draws a running scout\'s badge and block in status.active, as a working worker\'s', () => {
    const scout = agent('s1', { role: 'scout', phase: 'running', detail: 'scout', task_ref: null, provider: 'claude', model: 'sonnet' });
    expect(agentStatusRole(scout)).toBe('status.active');
    expect(agentStatusRole({ ...scout, phase: 'idle' })).toBe('status.idle');
  });

  it('draws OPEN in tab.active and KILL in button.danger, filled, one column apart', () => {
    for (const theme of [AMBER, BUILT_IN_THEMES.orc, CLASSIC]) {
      const { frame, lines } = render(details(0), { nav: at('p1/a2', ['p1/a2']), theme });
      const y = lines.findIndex((line) => line.includes('[ OPEN ]'));
      expect(lines[y].indexOf('[ OPEN ] [ KILL ]')).toBe(3);
      for (let x = 3; x < 11; x += 1) expect(frame.cells[y * COLS + x].style).toEqual(styleOf(theme, 'tab.active'));
      expect(frame.cells[y * COLS + 11].style).not.toEqual(styleOf(theme, 'button.danger'));
      for (let x = 12; x < 20; x += 1) expect(frame.cells[y * COLS + x].style).toEqual(styleOf(theme, 'button.danger'));
    }
  });

  it('hits the buttons on their columns: OPEN opens the agent, KILL asks to kill it (a worker with its task, a scout without)', () => {
    const sidebar = details(0);
    sidebar.agents = [...sidebar.agents.slice(0, 2), agent('s1', { role: 'scout', phase: 'running', detail: 'scout', task_ref: null, provider: 'codex', model: null })];
    const nav = at('p1/a1', ['p1/a2', 'p1/s1']);
    const { layout, lines } = render(sidebar, { nav, rows: 30 });
    const y = lines.findIndex((line) => line.includes('[ OPEN ]'));
    expect([2, 3, 10, 11, 12, 19, 20].map((x) => sidebarCardTarget(layout, x, y)?.button)).toEqual([undefined, 'open', 'open', undefined, 'kill', 'kill', undefined]);
    // The cursor goes to the button pressed.
    expect(sidebarCardClick(layout, nav, 5, y)).toEqual({ nav: { ...nav, agentKey: 'p1/a2', agentButton: 'open' }, command: { type: 'openAgent', projectId: 'p1', agentId: 'a2' } });
    expect(sidebarCardClick(layout, nav, 14, y)).toEqual({
      nav: { ...nav, agentKey: 'p1/a2', agentButton: 'kill' }, command: { type: 'killAgent', projectId: 'p1', agentId: 'a2', kind: 'worker', taskRef: 'cockpit-style/foo' },
    });
    // Off the buttons the row only moves the cursor to the agent, as the rest of the block does.
    expect(sidebarCardClick(layout, nav, 25, y)).toEqual({ nav: { ...nav, agentKey: 'p1/a2' }, command: null });
    const scoutRow = lines.findIndex((line, index) => index > y && line.includes('[ KILL ]'));
    expect(sidebarCardClick(layout, nav, 14, scoutRow)?.command).toEqual({ type: 'killAgent', projectId: 'p1', agentId: 's1', kind: 'scout', taskRef: null });
  });

  it('asks to kill the cursor agent with the kill key, only in the agents box', () => {
    const sidebar = details(0);
    const nav = at('p1/a2', []);
    expect(navigateSidebar(sidebarCursor(sidebar, nav), nav, 'kill')).toEqual({
      nav, command: { type: 'killAgent', projectId: 'p1', agentId: 'a2', kind: 'worker', taskRef: 'cockpit-style/foo' },
    });
    const projects = at('p1/a2', [], 'projects');
    expect(navigateSidebar(sidebarCursor(sidebar, projects), projects, 'kill')).toEqual({ nav: projects, command: null });
    expect(navigateSidebar(sidebarCursor(model(1, 0), INITIAL_SIDEBAR_NAV), INITIAL_SIDEBAR_NAV, 'kill').command).toBeNull();
  });

  for (const rows of [22, 16, 12, 8]) {
    it(`keeps the cursor's whole block in view at ${rows} rows with mixed expanded and collapsed agents, Projects shrinking first`, () => {
      for (const cursorAgent of ['a1', 'a2', 'a3', 'a4']) {
        const nav = at(`p1/${cursorAgent}`, ['p1/a1', 'p1/a3']);
        const layout = sidebarCardsLayout(details(), rows, nav, COLS);
        const where = `${rows} rows, cursor ${cursorAgent}: ${JSON.stringify(layout.cards.map((each) => [each.y, each.rows]))}`;
        expect(layout.cards.at(-1)!.y + layout.cards.at(-1)!.rows, where).toBe(rows);
        const index = layout.agentIndex;
        const expanded = nav.expanded.has(`p1/${cursorAgent}`);
        // a1's question wraps to two lines; collapsed, a4's question row is inside its box.
        const height = expanded ? (cursorAgent === 'a1' ? 8 : 7) : cursorAgent === 'a4' ? 4 : 3;
        const lone = card(layout, 'agents')!.lines.filter((line) => line.kind === 'agent' && line.index === index).length;
        if (expanded) {
          // A block fits when the Agents list can hold it (and a `+N more` line) below the Project card at its least
          // (its coordinator row and its button) and above the Agents card's button.
          const list = rows - 4 - 2 - 1;
          const fits = list >= height + 1;
          const shown = blockRows(layout, index).length + lone;
          expect(shown, where).toBe(fits ? height : Math.min(height, list >= 2 ? list - 1 : list));
          if (fits) expect(blockRows(layout, index).map((line) => (line.kind === 'block' ? line.part : '')), where).toContain('bottom');
        } else {
          // A collapsed cursor agent shows its whole box, or, in a window too short for it, its title row alone.
          expect([blockRows(layout, index).length, lone], where).toEqual(lone === 1 ? [0, 1] : [height, 0]);
        }
        // The Project card shrinks only once Projects is down to its window (or gone).
        const projects = card(layout, 'projects');
        if (card(layout, 'project')!.rows < 5) expect(projects?.rows ?? 0, where).toBeLessThanOrEqual(5); // 5: coordinator, workers, settings; a window of 2 and the button
      }
    });
  }

  it('fits the cursor block at 15 rows by shrinking Projects, then the Project card, then dropping Projects', () => {
    const layout = sidebarCardsLayout(details(), 15, at('p1/a3', ['p1/a1', 'p1/a3']), COLS);
    expect(rowsOf(layout)).toEqual([4, 11]);
    expect(card(layout, 'agents')!.lines.slice(-2)).toEqual([{ kind: 'more', count: 3 }, { kind: 'newAgent' }]);
    expect(blockRows(layout, 2).map((line) => (line.kind === 'block' ? line.part : ''))).toContain('bottom');
    // At 22 every card is shown: Projects down to its window, the Project card keeping its content.
    const at22 = sidebarCardsLayout(details(), 22, at('p1/a3', ['p1/a1', 'p1/a3']), COLS);
    expect(rowsOf(at22)).toEqual([5, 6, 11]);
    expect(blockRows(at22, 2).map((line) => (line.kind === 'block' ? line.part : ''))).toEqual(['top', 'title', 'model', 'task', 'detail', 'buttons', 'bottom']);
    // With the cursor collapsed at 12 rows the Agents card keeps its box, a `+N more` line and its button; Projects goes.
    const collapsed = sidebarCardsLayout(details(), 12, at('p1/a2', ['p1/a1', 'p1/a3']), COLS);
    expect(rowsOf(collapsed)).toEqual([4, 7]);
    expect(card(collapsed, 'agents')!.lines).toEqual([
      ...['top', 'title', 'bottom'].map((part) => ({ kind: 'block', index: 1, part })), { kind: 'more', count: 3 }, { kind: 'newAgent' },
    ]);
    expect(rowsOf(sidebarCardsLayout(details(), 12, at('p1/a2', []), COLS))).toEqual([4, 7]);
  });

  it('toggles on a click anywhere in an agent\'s box, its borders included; off the buttons on the buttons row a click only moves the cursor to it', () => {
    const nav = at('p1/a1', ['p1/a3']);
    const { layout, lines } = render(details(0), { nav, rows: 30 });
    const collapsed = lines.findIndex((line) => line.includes('[+] a2'));
    const block = lines.findIndex((line) => line.includes('[-] a3'));
    expect(lines[block].slice(3, 6)).toBe('[-]');
    expect([2, 3, 4, 5, 6].map((x) => sidebarCardTarget(layout, x, block)?.onMarker)).toEqual([false, true, true, true, false]);
    expect(sidebarCardClick(layout, nav, 3, block)).toEqual({ nav: { ...nav, agentKey: 'p1/a3', expanded: new Set() }, command: null });
    expect(sidebarCardClick(layout, nav, 2, collapsed)).toEqual({ nav: { ...nav, agentKey: 'p1/a2', expanded: new Set(['p1/a3', 'p1/a2']) }, command: null });
    expect(sidebarCardClick(layout, nav, 10, block)).toEqual({ nav: { ...nav, agentKey: 'p1/a3', expanded: new Set() }, command: null });
    expect(sidebarCardClick(layout, nav, 20, collapsed)).toEqual({ nav: { ...nav, agentKey: 'p1/a2', expanded: new Set(['p1/a3', 'p1/a2']) }, command: null });
    // An attention agent's question row is part of its row.
    const question = lines.findIndex((line) => line.includes('? may I'));
    expect(sidebarCardClick(layout, nav, 10, question)).toEqual({ nav: { ...nav, agentKey: 'p1/a1', expanded: new Set(['p1/a3', 'p1/a1']) }, command: null });
    expect(lines[block - 1]).toMatch(/^│┌─+┐│$/);
    // The expanded box's borders, sides and labelled rows collapse it.
    const buttons = lines.findIndex((line, y) => y > block && line.includes('[ OPEN ]'));
    for (const [x, y] of [[10, block - 1], [10, block + 1], [10, block + 3], [1, block], [COLS - 2, block + 2], [10, buttons + 1]]) {
      expect(sidebarCardClick(layout, nav, x, y), `${x},${y}`).toEqual({ nav: { ...nav, agentKey: 'p1/a3', expanded: new Set() }, command: null });
    }
    // A collapsed box's top and bottom borders and its sides expand it.
    for (const [x, y] of [[10, collapsed - 1], [10, collapsed + 1], [1, collapsed], [COLS - 2, collapsed]]) {
      expect(sidebarCardClick(layout, nav, x, y), `${x},${y}`).toEqual({ nav: { ...nav, agentKey: 'p1/a2', expanded: new Set(['p1/a3', 'p1/a2']) }, command: null });
    }
    // The buttons row off its buttons only moves the cursor.
    expect(sidebarCardClick(layout, nav, 25, buttons)).toEqual({ nav: { ...nav, agentKey: 'p1/a3' }, command: null });
  });

  it('frames the block in the agent\'s status role, its text the same under mono', () => {
    const sidebar = details(0);
    const nav = at('p1/a2', ['p1/a1', 'p1/a2']);
    const amber = render(sidebar, { nav, theme: AMBER, rows: 30 });
    const mono = render(sidebar, { nav, theme: MONO, rows: 30 });
    expect(mono.lines).toEqual(amber.lines);
    expect(render(sidebar, { nav, theme: CLASSIC, rows: 30 }).lines).toEqual(amber.lines);
    for (const [name, index] of [['a1', 0], ['a2', 1]] as const) {
      const role = agentStatusRole(sidebar.agents[index]);
      expect(role).toBe(name === 'a1' ? 'status.attention' : 'status.active');
      // The top border is a row of its own above the title row, drawn whole in the role.
      const top = amber.lines.findIndex((line) => line.includes(`[-] ${name}`)) - 1;
      const bottom = top + blockRows(amber.layout, index).length - 1;
      expect(amber.lines[top].slice(1, COLS - 1)).toBe(`┌${'─'.repeat(COLS - 4)}┐`);
      for (const [x, y] of [[1, top], [10, top], [COLS - 2, top], [1, top + 1], [COLS - 2, top + 2], [1, bottom], [10, bottom]]) {
        expect(amber.frame.cells[y * COLS + x].style, `${name} ${x},${y}`).toEqual(styleOf(AMBER, role));
      }
    }
    // A stale list dims the block's border and text too.
    const stale = render({ ...sidebar, agentsStale: true }, { nav, theme: AMBER, rows: 30 });
    const top = stale.lines.findIndex((line) => line.includes('[-] a2'));
    expect(stale.frame.cells[top * COLS + 1].style).toEqual({ ...styleOf(AMBER, 'status.active'), dim: true });
    expect(stale.frame.cells[(top + 1) * COLS + 3].style.dim).toBe(true);
  });

  it('puts the cursor bar on the block\'s title row, inside its borders, and leaves the top border visible', () => {
    const nav = at('p1/a2', ['p1/a2']);
    const { frame, lines } = render(details(0), { nav, focus: 'agents', theme: AMBER });
    const title = lines.findIndex((line) => line.includes('[-] a2'));
    expect(frame.cells[title * COLS + 3].style.bg).toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(frame.cells[(title + 1) * COLS + 3].style.bg).not.toEqual(styleOf(AMBER, 'row.cursor').bg);
    expect(lines[title - 1].slice(1, COLS - 1)).toBe(`┌${'─'.repeat(COLS - 4)}┐`);
    for (const x of [1, 3, COLS - 2]) expect(frame.cells[(title - 1) * COLS + x].style).toEqual(styleOf(AMBER, 'status.active'));
    expect(lines[title][1]).toBe('│');
    expect(frame.cells[title * COLS + 1].style).toEqual(styleOf(AMBER, 'status.active'));
  });

  describe('the buttons by keyboard', () => {
    type Key = Parameters<typeof navigateSidebar>[2];
    const step = (nav: SidebarNav, key: Key) => navigateSidebar(sidebarCursor(details(0), nav), nav, key);
    const keys = (nav: SidebarNav, ...sequence: Key[]): SidebarNav => sequence.reduce((current, key) => step(current, key).nav, nav);

    it('goes down from an expanded agent\'s row onto OPEN, → and ← between OPEN and KILL, up back to its row, down on to the next agent', () => {
      const row = at('p1/a2', ['p1/a2']);
      const open = keys(row, 'down');
      expect(open).toMatchObject({ agentKey: 'p1/a2', agentButton: 'open' });
      expect(keys(open, 'expand')).toMatchObject({ agentKey: 'p1/a2', agentButton: 'kill' });
      expect(keys(open, 'expand', 'expand').agentButton).toBe('kill');
      expect(keys(open, 'expand', 'collapse').agentButton).toBe('open');
      // ← on OPEN stays there: on the buttons it never collapses the agent.
      expect(keys(open, 'collapse')).toMatchObject({ agentButton: 'open', expanded: new Set(['p1/a2']) });
      expect(keys(open, 'up')).toEqual(row);
      expect(keys(open, 'down')).toEqual(at('p1/a3', ['p1/a2']));
      expect(keys(open, 'expand', 'down').agentButton).toBeUndefined();
      // A collapsed agent's row goes straight to the next agent.
      expect(keys(at('p1/a1', ['p1/a2']), 'down')).toEqual(at('p1/a2', ['p1/a2']));
    });

    it('lands on an expanded agent\'s buttons by ↑ from the next agent and from [ + NEW AGENT ]', () => {
      expect(keys(at('p1/a3', ['p1/a2']), 'up')).toMatchObject({ agentKey: 'p1/a2', agentButton: 'open' });
      expect(keys(at('p1/a2', ['p1/a1']), 'up')).toMatchObject({ agentKey: 'p1/a1', agentButton: 'open' });
      expect(keys(at('p1/a3', []), 'up').agentButton).toBeUndefined();
      const last = keys(at('p1/a4', ['p1/a4']), 'down', 'down');
      expect(last).toMatchObject({ agentKey: 'p1/a4', onButton: true });
      expect(last.agentButton).toBeUndefined();
      expect(keys(last, 'up')).toMatchObject({ agentKey: 'p1/a4', agentButton: 'open' });
      expect(keys(last, 'up').onButton).toBeUndefined();
    });

    it('presses the focused button with Enter: OPEN opens the agent\'s tab, KILL asks to kill it; x kills from the buttons too', () => {
      const open = keys(at('p1/a2', ['p1/a2']), 'down');
      expect(step(open, 'open')).toEqual({ nav: open, command: { type: 'openAgent', projectId: 'p1', agentId: 'a2' } });
      const kill = keys(open, 'expand');
      const killCommand = { type: 'killAgent', projectId: 'p1', agentId: 'a2', kind: 'worker', taskRef: 'cockpit-style/foo' };
      expect(step(kill, 'open')).toEqual({ nav: kill, command: killCommand });
      expect(step(open, 'kill')).toEqual({ nav: open, command: killCommand });
      expect(step(at('p1/a2', ['p1/a2']), 'kill').command).toEqual(killCommand);
    });

    it('clears the button when the agent collapses (Space, Enter on its row, a click) and ignores a stale one on a collapsed agent', () => {
      const open = keys(at('p1/a2', ['p1/a2']), 'down');
      expect(keys(open, 'toggle')).toEqual(at('p1/a2', []));
      expect(keys(open, 'up', 'open')).toEqual(at('p1/a2', []));
      expect(keys(open, 'up', 'collapse')).toEqual(at('p1/a2', []));
      const { layout, lines } = render(details(0), { nav: open, rows: 30 });
      expect(layout.agentButton).toBe('open');
      const top = lines.findIndex((line) => line.includes('[-] a2'));
      expect(sidebarCardClick(layout, open, 3, top)?.nav).toEqual(at('p1/a2', []));
      // A button left on a collapsed agent is no button: the keys act on its row.
      const stale: SidebarNav = { ...at('p1/a2', []), agentButton: 'kill' };
      expect(sidebarCardsLayout(details(0), 30, stale, COLS).agentButton).toBeNull();
      expect(step(stale, 'open').command).toBeNull();
      expect(step(stale, 'down').nav).toEqual(at('p1/a3', []));
    });

    it('marks the focused button with ▸ and bold, the cursor bar off the block\'s top row, only while the sidebar has the keys', () => {
      for (const theme of [AMBER, MONO]) {
        const open = keys(at('p1/a2', ['p1/a2']), 'down');
        const { frame, lines } = render(details(0), { nav: open, focus: 'agents', theme });
        const y = lines.findIndex((line) => line.includes('[ OPEN ]'));
        expect(lines[y].slice(2, 20)).toBe('▸[ OPEN ] [ KILL ]');
        expect(frame.cells[y * COLS + 2].style).toEqual(styleOf(theme, 'text.accent'));
        expect(frame.cells[y * COLS + 3].style).toEqual({ ...styleOf(theme, 'tab.active'), bold: true });
        expect(frame.cells[y * COLS + 12].style).toEqual(styleOf(theme, 'button.danger'));
        const top = lines.findIndex((line) => line.includes('[-] a2'));
        const unfocused = render(details(0), { nav: open, theme });
        // Inside the card's borders (the focused card's own are in chrome.borderFocus).
        expect(frame.cells.slice(top * COLS + 1, (top + 1) * COLS - 1).map((cell) => cell.style))
          .toEqual(unfocused.frame.cells.slice(top * COLS + 1, (top + 1) * COLS - 1).map((cell) => cell.style));
        const kill = render(details(0), { nav: keys(open, 'expand'), focus: 'agents', theme });
        expect(kill.lines[y].slice(2, 21)).toBe(' [ OPEN ]▸[ KILL ] ');
        expect(kill.frame.cells[y * COLS + 12].style).toEqual({ ...styleOf(theme, 'button.danger'), bold: true });
        // Without the keys no marker, as no cursor bar.
        expect(unfocused.lines[y].slice(2, 20)).toBe(' [ OPEN ] [ KILL ]');
      }
    });

    it('keeps the buttons row in view when the block is taller than the Agents window', () => {
      const nav = keys(at('p1/a1', ['p1/a1']), 'down');
      for (const rows of [8, 9, 10]) {
        const layout = sidebarCardsLayout(details(), rows, nav, COLS);
        const shown = card(layout, 'agents')!.lines.slice(0, card(layout, 'agents')!.rows - 2);
        expect(shown.some((line) => line.kind === 'block' && line.index === 0 && line.part === 'buttons'), `${rows}`).toBe(true);
      }
    });
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

describe('agent boxes (every agent, collapsed or expanded)', () => {
  const nav = (agentKey: string | null, expanded: string[] = []): SidebarNav => ({ ...INITIAL_SIDEBAR_NAV, agentKey, expanded: new Set(expanded) });
  /** The sidebar rows from `y`, its box drawing only (text dropped), to compare the box shape. */
  const frameOf = (lines: string[], from: number, count: number) => lines.slice(from, from + count).map((line) => line.replace(/[^│┌┐└┘─]/g, '').replace(/─+/g, '─'));

  it('draws a collapsed worker, scout, attention agent and local session each as a box in its status role', () => {
    const sidebar = model(0, 0, {
      agents: [
        agent('w1'),
        agent('s1', { role: 'scout', phase: 'running', detail: 'scout' }),
        agent('q1', { attention: 'question', detail: '? may I push' }),
      ],
    });
    const session: LocalAgent = { tabId: 'agent:1', label: 'claude 1', provider: 'claude', variant: 'fresh', agentName: null, alive: true, elapsed: '2m' };
    const { frame, lines } = render(sidebar, { rows: 40, locals: [session], theme: AMBER });
    const row = (part: string) => lines.findIndex((line) => line.includes(part));
    for (const [part, height] of [['[+] w1', 3], ['[+] s1', 3], ['[+] q1', 4], ['[+] ◇ claude 1', 3]] as const) {
      const title = row(part);
      expect(title, part).toBeGreaterThan(0);
      expect(frameOf(lines, title - 1, height), part).toEqual(['│┌─┐│', ...Array.from({ length: height - 2 }, () => '││││'), '│└─┘│']);
    }
    expect(lines.slice(row('[+] w1') - 1, row('[+] w1') + 2)).toEqual([
      '│┌──────────────────────────────┐│', '││ [+] w1       12m [IMPLEMENT] ││', '│└──────────────────────────────┘│',
    ]);
    expect(lines[row('[+] s1')]).toBe('││ [+] s1 scout   12m [RUNNING] ││');
    expect(lines[row('[+] q1') + 1]).toBe('││     ? may I push             ││'); // the question row inside the box
    // Each border in the agent's status role: the phase's, the attention kind's, status.local.
    const border = (part: string) => frame.cells[(row(part) - 1) * COLS + 1].style;
    expect(border('[+] w1')).toEqual(styleOf(AMBER, agentStatusRole(sidebar.agents[0])));
    expect(border('[+] s1')).toEqual(styleOf(AMBER, agentStatusRole(sidebar.agents[1])));
    expect(border('[+] q1')).toEqual(styleOf(AMBER, 'status.attention'));
    expect(border('[+] ◇ claude 1')).toEqual(styleOf(AMBER, 'status.local'));
    // A stale list dims the borders.
    const stale = render({ ...sidebar, agentsStale: true }, { rows: 40, theme: AMBER });
    const y = stale.lines.findIndex((line) => line.includes('[+] w1')) - 1;
    expect(stale.frame.cells[y * COLS + 1].style.dim).toBe(true);
  });

  it('expands inside the box: the title row stays on its screen row and nothing above it moves', () => {
    // While the Agents card has the rows for the expanded box (it keeps its size).
    for (const [rows, count] of [[40, 1], [40, 2], [30, 1]] as const) {
      const sidebar = model(0, count);
      for (const target of sidebar.agents) {
        const before = render(sidebar, { rows, nav: nav(target.key), focus: 'agents' });
        const after = render(sidebar, { rows, nav: nav(target.key, [target.key]), focus: 'agents' });
        const where = `${rows} rows, ${count} agents, ${target.agent_id}`;
        const title = before.lines.findIndex((line) => line.includes(`[+] ${target.agent_id} `));
        expect(title, where).toBeGreaterThan(0);
        expect(after.lines[title], where).toContain(`[-] ${target.agent_id} `);
        // Every row above the title row (the cards above, the boxes above, the box's top border) is unchanged.
        expect(after.lines.slice(0, title), where).toEqual(before.lines.slice(0, title));
        // The body rows and the buttons go inside the box, below its title row.
        expect(after.lines[title + 1], where).toMatch(/^││ model /);
        expect(after.lines.findIndex((line, y) => y > title && line.includes('[ OPEN ] [ KILL ]')), where).toBeGreaterThan(title);
      }
    }
  });

  for (const rows of [8, 14, 22, 40]) {
    it(`keeps the cursor agent's box in view at ${rows} rows with 1, 3 and 8 agents, \`+N more\` counting the agents not shown`, () => {
      for (const count of [1, 3, 8]) {
        const sidebar = model(0, count);
        for (const [index, each] of sidebar.agents.entries()) {
          for (const expanded of [false, true]) {
            for (const onButtons of expanded ? [false, true] : [false]) {
              const cursorNav: SidebarNav = { ...nav(each.key, expanded ? [each.key] : []), ...(onButtons ? { agentButton: 'open' as const } : {}) };
              const layout = sidebarCardsLayout(sidebar, rows, cursorNav, COLS);
              const agents = card(layout, 'agents')!;
              const where = `${rows} rows, ${count} agents, cursor ${each.agent_id}${expanded ? ' expanded' : ''}${onButtons ? ' on its buttons' : ''}: ${JSON.stringify(agents.lines)}`;
              const shown = agents.lines.slice(0, Math.max(0, agents.rows - 2));
              const box = shown.filter((line) => line.kind === 'block' && line.index === index);
              const lone = shown.filter((line) => line.kind === 'agent' && line.index === index);
              const height = expanded ? 6 : index % 3 === 0 ? 4 : 3;
              if (onButtons) {
                // On its buttons their row is in view, the box's rows above it as far as they fit.
                expect(box.some((line) => line.kind === 'block' && line.part === 'buttons'), where).toBe(true);
              } else if (box.length > 0) {
                // The whole box, or (an expanded box taller than the window) its rows from its top border.
                expect(box[0], where).toEqual({ kind: 'block', index, part: 'top' });
                expect(box.some((line) => line.kind === 'block' && line.part === 'title'), where).toBe(true);
                if (!expanded) expect(box.length, where).toBe(height);
              } else {
                // Too short for even its box: its title row alone.
                expect(lone, where).toHaveLength(1);
              }
              // `+N more` counts the agents whose title row is not shown.
              const more = shown.find((line) => line.kind === 'more');
              const hidden = count - titles({ ...agents, lines: shown }).length;
              if (more?.kind === 'more') expect(more.count, where).toBe(hidden);
              else if (agents.rows - 2 >= 3) expect(hidden, where).toBe(0);
              // Only whole boxes besides the cursor's: every other agent shown has its top and bottom border.
              for (const other of new Set(shown.flatMap((line) => (line.kind === 'block' && line.index !== index ? [line.index] : [])))) {
                const parts = shown.flatMap((line) => (line.kind === 'block' && line.index === other ? [line.part] : []));
                expect([parts[0], parts.at(-1)], where).toEqual(['top', 'bottom']);
              }
            }
          }
        }
      }
    });
  }

  it('draws the cursor bar on the box\'s title row only, and the cursor agent\'s title row alone when its box does not fit', () => {
    const sidebar = model(0, 3);
    const { frame, layout, lines } = render(sidebar, { rows: 40, nav: nav(sidebar.agents[1].key), focus: 'agents', theme: AMBER });
    const title = lines.findIndex((line) => line.includes('[+] a2 '));
    const cursorBg = styleOf(AMBER, 'row.cursor').bg;
    const agents = card(layout, 'agents')!;
    const bar = Array.from({ length: agents.rows - 2 }, (_, offset) => agents.y + 1 + offset).filter((y) => JSON.stringify(frame.cells[y * COLS + 5].style.bg) === JSON.stringify(cursorBg));
    expect(bar).toEqual([title]);
    expect(frame.cells[title * COLS + 1].style.bg).toEqual({ type: 'default' }); // the box's side keeps its own style
    // At 8 rows the Agents card has no room for a box: the cursor agent's title row alone, with the bar across the card.
    const short = render(sidebar, { rows: 8, nav: nav(sidebar.agents[1].key), focus: 'agents', theme: AMBER });
    const lone = short.lines.findIndex((line) => line.includes('[+] a2'));
    expect(card(short.layout, 'agents')!.lines[lone - card(short.layout, 'agents')!.y - 1]).toEqual({ kind: 'agent', index: 1 });
    expect(short.lines[lone]).toMatch(/^│ \[\+\] a2 .*\[IMPLEMENT\] │$/);
    expect(short.frame.cells[lone * COLS + 1].style.bg).toEqual(cursorBg);
    // A click on it toggles the agent.
    expect(sidebarCardClick(short.layout, nav(null), 10, lone)?.nav.expanded).toEqual(new Set([sidebar.agents[1].key]));
  });
});

describe('local agent sessions (the cockpit\'s own, not the coordinator\'s)', () => {
  const fresh: LocalAgent = { tabId: 'agent:1', label: 'claude 1', provider: 'claude', variant: 'fresh', agentName: null, alive: true, elapsed: '2m' };
  const custom: LocalAgent = { tabId: 'agent:2', label: 'critic · claude', provider: 'claude', variant: 'custom', agentName: 'critic', alive: true };
  const LOCALS = [fresh, custom];
  const navAt = (agentKey: string | null, expanded: string[] = [], box: SidebarNav['box'] = 'agents'): SidebarNav => ({ box, projectKey: null, agentKey, expanded: new Set(expanded) });
  const K1 = localAgentKey('p1', 'agent:1');
  const K2 = localAgentKey('p1', 'agent:2');
  const blockRows = (layout: SidebarCardsLayout, index: number) =>
    card(layout, 'agents')!.lines.slice(0, card(layout, 'agents')!.rows - 2).filter((line) => line.kind === 'block' && line.index === index);

  it('keys a session apart from every coordinator agent', () => {
    expect(K1).toBe('local:p1/agent:1');
    expect(K1).not.toBe(agent('agent:1').key);
  });

  it('lists the sessions after the coordinator\'s agents, the card\'s count telling them apart', () => {
    const { layout, lines } = render(model(0, 2), { locals: LOCALS, rows: 40 });
    expect(titles(card(layout, 'agents')!)).toEqual([0, 1, 2, 3]);
    const at = (part: string) => lines.findIndex((line) => line.includes(part));
    expect(at('[+] a2 ')).toBeLessThan(at('[+] ◇ claude 1'));
    expect(at('[+] ◇ claude 1')).toBeLessThan(at('[+] ◇ critic · clau'));
    expect(lines[at('◇ claude 1')]).toMatch(/││ \[\+\] ◇ claude 1 +2m \[LOCAL\] ││/);
    expect(lines[at('◇ critic')]).toBe('││ [+] ◇ critic · clau… [LOCAL] ││'); // the box's sides take a column each
    // A collapsed session is a box too.
    expect(lines[at('◇ claude 1') - 1]).toMatch(/^│┌─+┐│$/);
    expect(lines[at('◇ claude 1') + 1]).toMatch(/^│└─+┘│$/);
    expect(lines.find((line) => line.includes('[ AGENTS ]'))).toContain('2 live · 2 local');
    // Only sessions: the count names them alone, and no empty-state line.
    const only = render(model(0, 0), { locals: [fresh] });
    expect(only.lines.find((line) => line.includes('[ AGENTS ]'))).toMatch(/─ 1 local ┐$/);
    expect(only.lines.some((line) => line.includes('(no live agents)'))).toBe(false);
  });

  it('draws the marker muted, the label in text.accent, [LOCAL] in status.local.badge and [ENDED] in status.idle.badge', () => {
    for (const theme of [AMBER, BUILT_IN_THEMES.orc, CLASSIC, BUILT_IN_THEMES.mono]) {
      const { frame, lines } = render(model(0, 1), { locals: [fresh, { ...custom, alive: false }], theme, rows: 30 });
      const cell = (part: string, offset = 0) => {
        const y = lines.findIndex((line) => line.includes(part));
        return frame.cells[y * COLS + lines[y].indexOf(part) + offset].style;
      };
      expect(cell('◇ claude')).toEqual(styleOf(theme, 'text.muted'));
      expect(cell('claude 1')).toEqual(styleOf(theme, 'text.accent'));
      expect(cell('[LOCAL]')).toEqual(styleOf(theme, 'status.local.badge'));
      expect(cell('[ENDED]')).toEqual(styleOf(theme, 'status.idle.badge'));
    }
  });

  it('moves the cursor into the sessions; Enter or Space expands a session, its OPEN opens its tab, the kill key asks to close it', () => {
    const sidebar = model(0, 1);
    const step = (nav: SidebarNav, key: Parameters<typeof navigateSidebar>[2]) => navigateSidebar(sidebarCursor(sidebar, nav, LOCALS), nav, key);
    expect(step(navAt('p1/a1'), 'down').nav.agentKey).toBe(K1);
    expect(step(navAt(K1), 'down').nav.agentKey).toBe(K2);
    expect(step(navAt(K2), 'down').nav.onButton).toBe(true);
    expect(step(navAt(K2), 'open').command).toBeNull();
    expect([...step(navAt(K2), 'open').nav.expanded]).toEqual([K2]);
    expect(step({ ...navAt(K2, [K2]), agentButton: 'open' }, 'open').command).toEqual({ type: 'openAgent', projectId: 'p1', agentId: 'agent:2' });
    expect([...step(navAt(K1), 'toggle').nav.expanded]).toEqual([K1]);
    expect(step(navAt(K1), 'kill').command).toEqual({ type: 'killAgent', projectId: 'p1', agentId: 'agent:1', kind: 'local', taskRef: null });
    // With no coordinator agents the cursor starts on the first session, not the button.
    const none = navigateSidebar(sidebarCursor(model(0, 0), INITIAL_SIDEBAR_NAV, [fresh]), INITIAL_SIDEBAR_NAV, 'open');
    expect(none).toEqual({ nav: { ...INITIAL_SIDEBAR_NAV, agentKey: K1, expanded: new Set([K1]) }, command: null });
  });

  it('expands into its block: provider · default, type or agent, the note (wrapped), the buttons, framed in status.local', () => {
    const nav = navAt(K1, [K1, K2]);
    const { frame, layout, lines } = render(model(0, 0), { locals: LOCALS, nav, theme: AMBER, rows: 40 });
    expect(blockRows(layout, 0).map((line) => (line.kind === 'block' ? line.part : ''))).toEqual(['top', 'title', 'model', 'type', 'note', 'note', 'buttons', 'bottom']);
    const top = lines.findIndex((line) => line.includes('[-] ◇ claude 1'));
    expect(lines.slice(top - 1, top + 7)).toEqual([
      '│┌──────────────────────────────┐│',
      '││ [-] ◇ claude 1    2m [LOCAL] ││',
      '││ model  claude · default      ││',
      '││ type   fresh session         ││',
      '││ not managed by the           ││',
      '││ coordinator                  ││',
      '││ [ OPEN ] [ KILL ]            ││',
      '│└──────────────────────────────┘│',
    ]);
    expect(LOCAL_NOTE).toBe('not managed by the coordinator');
    expect(lines.find((line) => line.includes('agent  critic'))).toBe('││ agent  critic                ││');
    for (const [x, y] of [[1, top - 1], [10, top - 1], [1, top], [COLS - 2, top + 1], [1, top + 6]]) expect(frame.cells[y * COLS + x].style).toEqual(styleOf(AMBER, 'status.local'));
    expect(frame.cells[(top + 1) * COLS + 3].style).toEqual(styleOf(AMBER, 'text.muted'));
    expect(frame.cells[(top + 1) * COLS + 10].style).toEqual(styleOf(AMBER, 'text.primary'));
    expect(frame.cells[(top + 3) * COLS + 3].style).toEqual(styleOf(AMBER, 'text.muted'));
    expect(frame.cells[(top + 5) * COLS + 3].style).toEqual(styleOf(AMBER, 'tab.active'));
    expect(frame.cells[(top + 5) * COLS + 12].style).toEqual(styleOf(AMBER, 'button.danger'));
    // A wide card keeps the note on one row.
    const wide = sidebarCardsLayout(model(0, 0), 40, nav, 40, LOCALS);
    expect(blockRows(wide, 0).filter((line) => line.kind === 'block' && line.part === 'note')).toHaveLength(1);
    // An ended session's block is framed in status.idle.
    const ended = render(model(0, 0), { locals: [{ ...fresh, alive: false }], nav, theme: AMBER, rows: 40 });
    const endedTop = ended.lines.findIndex((line) => line.includes('[ENDED]'));
    expect(ended.frame.cells[endedTop * COLS + 1].style).toEqual(styleOf(AMBER, 'status.idle'));
  });

  it('hits a session\'s rows: the marker and the row toggle it, OPEN opens its tab, KILL asks to close it', () => {
    const nav = navAt('p1/a1', [K2]);
    const { layout, lines } = render(model(0, 1), { locals: LOCALS, nav, rows: 40 });
    const row = lines.findIndex((line) => line.includes('[+] ◇ claude 1'));
    expect(sidebarCardClick(layout, nav, 3, row)).toEqual({ nav: { ...nav, agentKey: K1, expanded: new Set([K2, K1]) }, command: null });
    expect(sidebarCardClick(layout, nav, 12, row)).toEqual({ nav: { ...nav, agentKey: K1, expanded: new Set([K2, K1]) }, command: null });
    const top = lines.findIndex((line) => line.includes('[-] ◇ critic'));
    expect(sidebarCardClick(layout, nav, 3, top)?.nav.expanded).toEqual(new Set());
    const buttons = lines.findIndex((line, index) => index > top && line.includes('[ OPEN ]'));
    expect(sidebarCardClick(layout, nav, 5, buttons)?.command).toEqual({ type: 'openAgent', projectId: 'p1', agentId: 'agent:2' });
    expect(sidebarCardClick(layout, nav, 14, buttons)?.command).toEqual({ type: 'killAgent', projectId: 'p1', agentId: 'agent:2', kind: 'local', taskRef: null });
  });

  it('keeps the cursor session\'s whole block in view in a short sidebar, the other agents behind `+N more`', () => {
    // 16: the block (8), a `+N more` line, the button and the borders, and the Project card at its least (4).
    for (const rows of [22, 17, 16]) {
      const layout = sidebarCardsLayout(model(0, 3), rows, navAt(K2, [K2]), COLS, LOCALS);
      const agents = card(layout, 'agents')!;
      expect(agents.y + agents.rows, `${rows}`).toBe(rows);
      expect(blockRows(layout, 4).map((line) => (line.kind === 'block' ? line.part : '')), `${rows}`).toEqual(['top', 'title', 'model', 'type', 'note', 'note', 'buttons', 'bottom']);
      expect(agents.lines.some((line) => line.kind === 'more'), `${rows}`).toBe(true);
      expect(agents.lines.at(-1)).toEqual({ kind: 'newAgent' });
    }
  });

  it('prunes the expanded key of a session whose tab closed, even before the project\'s status loaded', () => {
    const nav = navAt(K1, [K1, K2, 'p1/a1']);
    expect(pruneExpanded(nav, model(0, 1), [fresh]).expanded).toEqual(new Set([K1, 'p1/a1']));
    const unloaded = model(0, 0, { status: { coordinator: null, workers: null, attention: 0 } });
    expect(pruneExpanded(nav, unloaded, []).expanded).toEqual(new Set(['p1/a1']));
    expect(pruneExpanded(nav, model(0, 1), LOCALS)).toBe(nav);
  });
});
