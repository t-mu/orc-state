/**
 * lib/cockpit2/sidebarCards.ts — the cockpit sidebar as three square cards
 * (Plan 7 Step 8), drawn from the sidebar model of lib/tui/sidebar.ts:
 *
 *   ┌─ [ ORC-STATE ] ──────────────┐   Project: the active project, its state as one
 *   │ coordinator        [RUNNING] │   badge, its worker capacity and the notice
 *   │ workers 2/4                  │
 *   │                              │
 *   └──────────────────────────────┘
 *   ┌─ [ OTHER PROJECTS ] ───── 1 ─┐   Other projects: one row each, state badge and
 *   │ arek-on-trail         [IDLE] │   `!N` when its agents need a human
 *   └──────────────────────────────┘
 *   ┌─ [ AGENTS ] ─────── 3 live ──┐   Agents: one collapsed row each; an agent
 *   │ [+] grommash worker [PERMI…] │   needing attention keeps its question or
 *   │     ? may I run npm test     │   reason on a second row
 *   └──────────────────────────────┘
 *
 * The keys move in two boxes, as before: projects (the active one is the
 * Project card's coordinator row, the others their Other projects rows) and
 * agents. The layout (`sidebarCardsLayout`) is pure: it sizes the cards to the
 * rows (Other projects shrinks to a `+N more` line before Agents loses rows),
 * keeps the cursor's row in view and lists every body row, which drawing
 * (`drawSidebarCards`) and clicks (`sidebarCardTarget`) both read.
 */
import { stringWidth } from '../cellWidth.ts';
import { ATTENTION_BADGE, fitRow, fitText, type SidebarAgent, type SidebarModel } from '../tui/sidebar.ts';
import { windowStart } from '../tui/taskList.ts';
import { collapseMarker, drawBadge, drawBox } from './chrome.ts';
import type { SidebarKey } from './dispatch.ts';
import { fillRect, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { attentionRole, badgeRole, phaseRole, projectStateRole, styleOf, type StatusRole, type Theme } from './theme.ts';
import { drawRuns, type Run } from './widgets.ts';

// ── navigation ───────────────────────────────────────────────────────────────

/** The two boxes the sidebar keys move in: every project, or the active project's agents. */
export type SidebarBox = 'projects' | 'agents';

/** The sidebar's cursor: the box the keys move in and the selected project and agent (by key, so a reorder keeps them). */
export interface SidebarNav {
  box: SidebarBox;
  projectKey: string | null;
  agentKey: string | null;
}

export const INITIAL_SIDEBAR_NAV: SidebarNav = Object.freeze({ box: 'agents', projectKey: null, agentKey: null });

/** What navigation needs: the model and the cursor's indices into its projects and agents (0 for an empty list). */
export interface SidebarCursor {
  model: SidebarModel;
  projectIndex: number;
  agentIndex: number;
}

/** What a sidebar key or click asks the app to do. */
export type SidebarCommand =
  | { type: 'openProject'; projectId: string }
  | { type: 'openAgent'; projectId: string; agentId: string }
  | { type: 'focusSlot' };

export interface SidebarStep { nav: SidebarNav; command: SidebarCommand | null }

function indexOfKey(keys: string[], key: string | null, fallback: number): number {
  const index = key == null ? -1 : keys.indexOf(key);
  return index >= 0 ? index : Math.max(0, Math.min(fallback, keys.length - 1));
}

/** The cursor's indices for `nav` (the projects cursor defaults to the active project). */
export function sidebarCursor(model: SidebarModel, nav: SidebarNav): SidebarCursor {
  return {
    model,
    projectIndex: indexOfKey(model.projects.map((project) => project.project_id), nav.projectKey ?? model.activeProjectId, 0),
    agentIndex: indexOfKey(model.agents.map((agent) => agent.key), nav.agentKey, 0),
  };
}

/**
 * A navigation key: up and down move the cursor in the focused box (stopping
 * at either end), switchBox moves between the projects and agents boxes, open
 * opens the project or agent under the cursor, back returns to the pane.
 */
export function navigateSidebar(view: SidebarCursor, nav: SidebarNav, key: SidebarKey): SidebarStep {
  const { model } = view;
  const projects = nav.box === 'projects';
  const length = projects ? model.projects.length : model.agents.length;
  const current = projects ? view.projectIndex : view.agentIndex;
  switch (key) {
    case 'back': return { nav, command: { type: 'focusSlot' } };
    case 'switchBox': return { nav: { ...nav, box: projects ? 'agents' : 'projects' }, command: null };
    case 'up':
    case 'down': {
      if (length === 0) return { nav, command: null };
      const next = Math.max(0, Math.min(length - 1, current + (key === 'up' ? -1 : 1)));
      return { nav: projects ? { ...nav, projectKey: model.projects[next].project_id } : { ...nav, agentKey: model.agents[next].key }, command: null };
    }
    case 'open': {
      if (length === 0) return { nav, command: null };
      return projects ? openProjectStep(nav, model, current) : openAgentStep(nav, model, current);
    }
  }
}

function openProjectStep(nav: SidebarNav, model: SidebarModel, index: number): SidebarStep {
  const project = model.projects[index];
  // Another project lists other agents: the agents cursor starts at the top again.
  const agentKey = project.project_id === model.activeProjectId ? nav.agentKey : null;
  return { nav: { box: 'projects', projectKey: project.project_id, agentKey }, command: { type: 'openProject', projectId: project.project_id } };
}

function openAgentStep(nav: SidebarNav, model: SidebarModel, index: number): SidebarStep {
  const agent = model.agents[index];
  const next: SidebarNav = { ...nav, box: 'agents', agentKey: agent.key };
  return { nav: next, command: model.activeProjectId ? { type: 'openAgent', projectId: model.activeProjectId, agentId: agent.agent_id } : null };
}

// ── layout ───────────────────────────────────────────────────────────────────

export type SidebarCard = 'project' | 'otherProjects' | 'agents';

/** A card's body row: what is drawn there and what a click on it hits. */
export type CardLine =
  | { kind: 'coordinator' } | { kind: 'workers' } | { kind: 'notice' } | { kind: 'noProjects' }
  | { kind: 'project'; index: number }
  | { kind: 'agent'; index: number } | { kind: 'detail'; index: number }
  | { kind: 'more'; count: number }
  | { kind: 'empty' };

/** A card as laid out: its first row and rows (borders included) in the sidebar, and its body rows, in order. */
export interface CardLayout { card: SidebarCard; y: number; rows: number; lines: CardLine[] }

export interface SidebarCardsLayout extends SidebarCursor {
  cols: number;
  rows: number;
  /** The card the keys' cursor is in: the agents box's, or the projects box's (`projectCard`). */
  cursorCard: SidebarCard;
  /** The card of the projects box's cursor: Project for the active project, else Other projects. */
  projectCard: 'project' | 'otherProjects';
  /** Top to bottom; Other projects is left out when there is no other project or no row for it. */
  cards: CardLayout[];
}

/** Rows of a card's top and bottom borders. */
const BORDERS = 2;
/** The Project card's rows: coordinator, workers and the notice, between the borders. */
const PROJECT_ROWS = BORDERS + 3;
/** The fewest rows a card keeps when space runs short: one body row. */
const MIN_CARD_ROWS = BORDERS + 1;

const agentHeight = (agent: SidebarAgent): number => (agent.attention ? 2 : 1);

/** The Other projects body in `body` rows: a window around `cursor` (an index into `others`) and a `+N more` line for the rest. */
function otherLines(others: number[], body: number, cursor: number): CardLine[] {
  if (body <= 0) return [];
  if (others.length <= body) return others.map((index) => ({ kind: 'project', index }));
  const shown = Math.max(cursor >= 0 ? 1 : 0, body - 1);
  const start = windowStart(Math.max(0, cursor), others.length, shown);
  const lines: CardLine[] = others.slice(start, start + shown).map((index) => ({ kind: 'project', index }));
  if (lines.length < body) lines.push({ kind: 'more', count: others.length - shown });
  return lines;
}

/**
 * The Agents body in `body` rows: every agent when they fit, else a window
 * that starts as high as the cursor's agent allows and a `+N more` line for
 * the agents left out.
 */
function agentLines(agents: SidebarAgent[], body: number, cursor: number): CardLine[] {
  if (body <= 0) return [];
  if (agents.length === 0) return [{ kind: 'empty' }];
  const block = (index: number): CardLine[] => (agents[index].attention ? [{ kind: 'agent', index }, { kind: 'detail', index }] : [{ kind: 'agent', index }]);
  const total = agents.reduce((sum, agent) => sum + agentHeight(agent), 0);
  if (total <= body) return agents.flatMap((_, index) => block(index));
  const room = body >= 2 ? body - 1 : body;
  let start = 0;
  let used = agents.slice(0, cursor + 1).reduce((sum, agent) => sum + agentHeight(agent), 0);
  while (used > room && start < cursor) used -= agentHeight(agents[start++]);
  let end = cursor + 1;
  while (end < agents.length && used + agentHeight(agents[end]) <= room) used += agentHeight(agents[end++]);
  while (start > 0 && used + agentHeight(agents[start - 1]) <= room) used += agentHeight(agents[--start]);
  const lines = agents.slice(start, end).flatMap((_, offset) => block(start + offset)).slice(0, room);
  const hidden = agents.length - (end - start);
  if (hidden > 0 && lines.length < body) lines.push({ kind: 'more', count: hidden });
  return lines;
}

/**
 * The cards in `rows` by `cols`. The Project card takes 5 rows, Other
 * projects one per other project, Agents the rest. When rows run out Other
 * projects shrinks first (down to a `+N more` line, or the cursor's row and
 * that line), then the Project card (down to its coordinator row), then Other
 * projects goes unless the cursor is in it. Each card's lines keep the
 * cursor's row in view.
 */
export function sidebarCardsLayout(model: SidebarModel, rows: number, nav: SidebarNav, cols: number): SidebarCardsLayout {
  const cursor = sidebarCursor(model, nav);
  const activeIndex = model.projects.findIndex((project) => project.active);
  const others = model.projects.flatMap((project, index) => (project.active ? [] : [index]));
  const projectCard = cursor.projectIndex === activeIndex || others.length === 0 ? 'project' : 'otherProjects';
  const cursorCard: SidebarCard = nav.box === 'agents' ? 'agents' : projectCard;
  const inOthers = cursorCard === 'otherProjects';

  const othersFull = others.length > 0 ? BORDERS + others.length : 0;
  const othersMin = others.length === 0 ? 0 : BORDERS + (inOthers && others.length > 1 ? 2 : 1);
  const agentsFull = BORDERS + Math.max(1, model.agents.reduce((sum, agent) => sum + agentHeight(agent), 0));

  let project = PROJECT_ROWS;
  let other = othersFull;
  if (project + other + agentsFull > rows) other = Math.max(othersMin, Math.min(othersFull, rows - project - agentsFull));
  if (rows - project - other < MIN_CARD_ROWS) project = Math.max(MIN_CARD_ROWS, rows - other - MIN_CARD_ROWS);
  if (rows - project - other < MIN_CARD_ROWS && !inOthers) other = 0;
  // A sidebar too short for every card: the top ones keep their rows, the rest are cut.
  project = Math.max(0, Math.min(project, rows));
  other = Math.max(0, Math.min(other, rows - project));
  const agents = Math.max(0, rows - project - other);

  const body = (cardRows: number) => Math.max(0, cardRows - BORDERS);
  const otherCursor = inOthers ? others.indexOf(cursor.projectIndex) : -1;
  // With no project at all the card says so (`(none)`, as the old projects box did) above the notice that tells why.
  const projectLines: CardLine[] = (model.projects.length === 0
    ? [{ kind: 'noProjects' }, { kind: 'notice' }] as CardLine[]
    : [{ kind: 'coordinator' }, { kind: 'workers' }, { kind: 'notice' }] as CardLine[]).slice(0, body(project));
  const cards: CardLayout[] = [{ card: 'project', y: 0, rows: project, lines: projectLines }];
  if (other > 0) cards.push({ card: 'otherProjects', y: project, rows: other, lines: otherLines(others, body(other), otherCursor) });
  cards.push({ card: 'agents', y: project + other, rows: agents, lines: agentLines(model.agents, body(agents), cursor.agentIndex) });
  return { ...cursor, cols, rows, cursorCard, projectCard, cards };
}

/** What a click hits: a project's or an agent's row, and whether it hit the agent row's collapse marker. */
export interface SidebarCardTarget { card: SidebarCard; index: number; onMarker: boolean }

/** Columns of padding inside each side border. */
const PAD = 1;
/** Columns of the collapse marker, which starts after the left border and its padding. */
const MARKER_COLS = stringWidth(collapseMarker(false));

/** The row under (x, y), relative to the sidebar; null on a border, a blank row, a `+N more` or empty-state line. */
export function sidebarCardTarget(layout: SidebarCardsLayout, x: number, y: number): SidebarCardTarget | null {
  if (x < 1 || x > layout.cols - 2) return null;
  const card = layout.cards.find((candidate) => y >= candidate.y && y < candidate.y + candidate.rows);
  if (!card) return null;
  const row = y - card.y - 1;
  if (row < 0 || row >= card.rows - BORDERS) return null;
  const line = card.lines[row];
  switch (line?.kind) {
    case 'coordinator':
    case 'workers': {
      const index = layout.model.projects.findIndex((project) => project.active);
      return index >= 0 ? { card: 'project', index, onMarker: false } : null;
    }
    case 'project': return { card: 'otherProjects', index: line.index, onMarker: false };
    case 'agent': return { card: 'agents', index: line.index, onMarker: x >= 1 + PAD && x < 1 + PAD + MARKER_COLS };
    case 'detail': return { card: 'agents', index: line.index, onMarker: false };
    default: return null;
  }
}

/** A click at (x, y) in the sidebar: the row's box gets the cursor and its project or agent opens. Null off the rows. */
export function sidebarCardClick(layout: SidebarCardsLayout, nav: SidebarNav, x: number, y: number): SidebarStep | null {
  const target = sidebarCardTarget(layout, x, y);
  if (!target) return null;
  return target.card === 'agents' ? openAgentStep(nav, layout.model, target.index) : openProjectStep(nav, layout.model, target.index);
}

// ── drawing ──────────────────────────────────────────────────────────────────

export interface SidebarDrawOptions {
  /** The sidebar box with the keys, or null while the slot has them. */
  focus: SidebarBox | null;
  /** The styles the sidebar is drawn in. */
  theme: Theme;
}

/** A run's style with `over` applied (a stale row's dim). */
const withStyle = (runs: readonly Run[], over: Partial<CellStyle>): Run[] => runs.map(([text, runStyle, status]) => (status ? [text, { ...runStyle, ...over }, true] : [text, { ...runStyle, ...over }]));

/**
 * The cursor row: `row.cursor` over each run. A status run keeps its colours
 * so its state stays visible, takes the cursor's attributes, and takes the
 * cursor's background where it has none of its own, so the bar has no gap.
 */
function cursorRow(runs: readonly Run[], theme: Theme): Run[] {
  const { fg: _fg, bg: cursorBg, ...attributes } = theme.roles['row.cursor'];
  return runs.map(([text, runStyle, status]) => (status
    ? [text, { ...runStyle, ...attributes, bg: runStyle.bg.type === 'default' && cursorBg ? cursorBg : runStyle.bg }, true]
    : [text, { ...runStyle, ...theme.roles['row.cursor'] }]));
}

/** `[LABEL]`, as drawBadge draws it. */
const badgeText = (label: string): string => `[${label.toUpperCase()}]`;

const runsText = (runs: readonly Run[]): string => runs.map(([text]) => text).join('');

interface CardRow {
  left: string;
  /** `left` as shown (cut to fit) split into styled runs. */
  leftRuns: (left: string) => Run[];
  /** Flush right: `before` runs, the badge, `after` runs; `before` is dropped first, then all of them, when the row is too narrow. */
  before?: Run[];
  badge?: { label: string; role: StatusRole };
  after?: Run[];
  cursor: boolean;
  dim?: boolean;
}

/**
 * Draws one body row: `left` (cut first), then flush right `before`, the badge
 * (drawBadge, in its status role) and `after`. The cursor row takes
 * `row.cursor` across the whole width; the badge keeps its own style.
 */
function drawCardRow(frame: Frame, x: number, y: number, cols: number, row: CardRow, theme: Theme): void {
  const after = row.after ?? [];
  const tailOf = (before: readonly Run[]) => (row.badge ? `${runsText(before)}${badgeText(row.badge.label)}${runsText(after)}` : '');
  let before = row.before ?? [];
  let fitted = fitRow(row.left, tailOf(before), cols);
  if (fitted.right !== tailOf(before) && before.length > 0) {
    before = [];
    fitted = fitRow(row.left, tailOf(before), cols);
  }
  const showTail = row.badge !== undefined && fitted.right === tailOf(before);
  const left = showTail ? fitted.left : fitText(row.left, cols);
  const gap = showTail ? fitted.gap : ' '.repeat(Math.max(0, cols - stringWidth(left)));
  let runs: Run[] = [...row.leftRuns(left), [gap, styleOf(theme, 'text.primary')], ...(showTail ? before : [])];
  let tail = after;
  if (row.cursor) {
    runs = cursorRow(runs, theme);
    tail = cursorRow(after, theme);
  } else if (row.dim) {
    runs = withStyle(runs, { dim: true });
    tail = withStyle(after, { dim: true });
  }
  const used = drawRuns(frame, x, y, runs, cols);
  if (!showTail || !row.badge) return;
  const badge = drawBadge(frame, x + used, y, row.badge.label, row.badge.role, theme, cols - used);
  // A stale row dims its badge too (the cursor row's badge keeps its own style).
  if (row.dim && !row.cursor) {
    for (let col = x + used; col < x + used + badge; col += 1) {
      const cell = frame.cells[y * frame.cols + col];
      cell.style = { ...cell.style, dim: true };
    }
  }
  drawRuns(frame, x + used + badge, y, tail, cols - used - badge);
}

/**
 * Draws the cards into `region` as `layout` lays them out: square boxes
 * (drawBox), the focused card's border in `chrome.borderFocus`, the cursor row
 * in `row.cursor`, states as badges (drawBadge) in their status roles.
 */
export function drawSidebarCards(frame: Frame, region: Region, layout: SidebarCardsLayout, options: SidebarDrawOptions): void {
  if (region.cols < 4 || region.rows < 1) return;
  const { model } = layout;
  const { theme, focus } = options;
  const role = (name: Parameters<typeof styleOf>[1]) => styleOf(theme, name);
  const focusedCard: SidebarCard | null = focus === null ? null : focus === 'agents' ? 'agents' : layout.projectCard;
  const active = model.projects.find((project) => project.active) ?? null;
  const bottom = region.y + region.rows;

  for (const card of layout.cards) {
    // Rows below the region never hold a card: a sidebar too short cuts them.
    const rows = Math.min(card.rows, bottom - (region.y + card.y));
    if (rows < 2) continue;
    const focused = card.card === focusedCard;
    const title = card.card === 'project' ? active?.name ?? 'project' : card.card === 'otherProjects' ? 'Other projects' : 'Agents';
    const count = card.card === 'otherProjects'
      ? String(model.projects.length - (active ? 1 : 0))
      : card.card === 'agents' && model.agents.length > 0 ? `${model.agents.length} ${model.agentsStale ? 'stale' : 'live'}` : '';
    const inner = drawBox(frame, { x: region.x, y: region.y + card.y, cols: region.cols, rows: card.rows }, { title, meta: count, focused, theme });
    // A cut card draws a full box whose lower part the next card or the frame's edge covers: only the rows in the region get body text.
    // One column of padding inside each border; the cursor row's bar spans it too.
    card.lines.slice(0, Math.min(inner.rows, rows - 1)).forEach((line, offset) => {
      const cursor = focused && isCursorLine(layout, line);
      if (cursor) fillRect(frame, { x: inner.x, y: inner.y + offset, cols: inner.cols, rows: 1 }, { ...role('text.primary'), ...theme.roles['row.cursor'] });
      drawLine(frame, inner.x + PAD, inner.y + offset, inner.cols - 2 * PAD, line, cursor);
    });
  }

  function drawLine(frame: Frame, x: number, y: number, cols: number, line: CardLine, cursor: boolean): void {
    const plain = (text: string): Run[] => [[text, role('text.primary')]];
    switch (line.kind) {
      case 'coordinator': {
        const state = model.status.coordinator;
        drawCardRow(frame, x, y, cols, {
          left: state ? 'coordinator' : 'coordinator -', leftRuns: plain, cursor,
          ...(state ? { badge: { label: state, role: projectStateRole(state) } } : {}),
        }, theme);
        return;
      }
      case 'workers': {
        const { workers } = model.status;
        drawCardRow(frame, x, y, cols, { left: `workers ${workers ? `${workers.used}/${workers.total}` : '-'}`, leftRuns: plain, cursor }, theme);
        return;
      }
      case 'noProjects':
        drawRuns(frame, x, y, [[fitText('(none)', cols), role('text.muted')]], cols);
        return;
      case 'notice':
        if (model.notice) drawRuns(frame, x, y, [[fitText(model.notice, cols), role('status.warn')]], cols);
        return;
      case 'project': {
        const project = model.projects[line.index];
        const after: Run[] = project.attention > 0 ? [[' ', role('text.primary')], [`!${project.attention}`, role(badgeRole('status.attention')), true]] : [];
        drawCardRow(frame, x, y, cols, { left: project.name, leftRuns: plain, badge: { label: project.state, role: projectStateRole(project.state) }, after, cursor }, theme);
        return;
      }
      case 'agent': {
        const agent = model.agents[line.index];
        drawCardRow(frame, x, y, cols, {
          left: `${collapseMarker(false)} ${agent.agent_id} ${agent.role}`,
          leftRuns: (left) => agentRuns(agent, left),
          before: agent.elapsed ? [[`${agent.elapsed} `, role('text.muted')]] : [],
          badge: agent.attention
            ? { label: ATTENTION_BADGE[agent.attention], role: attentionRole(agent.attention) }
            : { label: agent.phase, role: phaseRole(agent.phase) },
          cursor, dim: model.agentsStale,
        }, theme);
        return;
      }
      case 'detail': {
        const agent = model.agents[line.index];
        const style = role(agent.attention ? attentionRole(agent.attention) : 'text.muted');
        drawRuns(frame, x, y, [[fitText(`${' '.repeat(MARKER_COLS + 1)}${agent.detail ?? ''}`, cols), model.agentsStale ? { ...style, dim: true } : style]], cols);
        return;
      }
      case 'more':
        drawRuns(frame, x, y, [[fitText(`+${line.count} more`, cols), role('text.muted')]], cols);
        return;
      case 'empty': {
        const text = active?.state === 'stopped' && !model.agentsStale ? '(coordinator not running)' : '(no live agents)';
        drawRuns(frame, x, y, [[fitText(text, cols), role('text.muted')]], cols);
        return;
      }
    }
  }

  /** An agent row's left part as runs: the marker, the name (`text.accent`), the role and elapsed time (`text.muted`). */
  function agentRuns(agent: SidebarAgent, shown: string): Run[] {
    const marker = `${collapseMarker(false)} `;
    const runs: Run[] = [];
    let rest = shown;
    for (const [part, name] of [[marker, 'text.muted'], [agent.agent_id, 'text.accent']] as const) {
      const take = rest.startsWith(part) ? part : rest;
      runs.push([take, role(name)]);
      rest = rest.slice(take.length);
      if (!rest) return runs;
    }
    runs.push([rest, role('text.muted')]);
    return runs;
  }
}

/** Whether `line` is the keys' cursor row (the caller checks its card is the focused one). */
function isCursorLine(layout: SidebarCardsLayout, line: CardLine): boolean {
  switch (line.kind) {
    case 'coordinator': return layout.projectCard === 'project';
    case 'project': return line.index === layout.projectIndex;
    case 'agent': return line.index === layout.agentIndex;
    default: return false;
  }
}
