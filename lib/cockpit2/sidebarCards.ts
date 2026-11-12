/**
 * lib/cockpit2/sidebarCards.ts — the cockpit sidebar as three square cards
 * (Plan 7 Step 8), drawn from the sidebar model of lib/tui/sidebar.ts:
 *
 *   ┌─ [ PROJECTS ] ─────────── 2 ─┐   Projects: every registered project, one row
 *   │ ▸ orc-state        [RUNNING] │   each, state badge and `!N` when its agents
 *   │   arek-on-trail       [IDLE] │   need a human; `▸` marks the active one
 *   └──────────────────────────────┘
 *                                      a blank row between cards (the canvas)
 *   ┌─ [ ORC-STATE ] ──────────────┐   Project: the active project, its coordinator
 *   │ coordinator        [RUNNING] │   state as one badge, its worker capacity, its
 *   │ workers 2/4                  │   open task counts, the notice (only while
 *   │ tasks 3 todo · 1 in progress │   there is one) and a settings button
 *   │ [ SETTINGS ]                 │
 *   └──────────────────────────────┘
 *
 *   ┌─ [ AGENTS ] ─────── 3 live ──┐   Agents: one collapsed row each; an agent
 *   │ [+] grommash worker [PERMI…] │   needing attention keeps its question or
 *   │     ? may I run npm test     │   reason on a second row. An expanded agent
 *   │┌ [-] boin worker 3m [IMPL…] ┐│   (Plan 7 Step 9: Space or a click on its
 *   ││ claude · opus              ││   marker) is a box in its status role: the
 *   ││ cockpit-style/foo          ││   row, its provider and model, its task (a
 *   ││ editing app.ts             ││   scout has none), its question, or its
 *   ││ [ OPEN ] [ KILL ]          ││   activity when it says more than the row
 *   │└────────────────────────────┘│   (at most two lines), and two buttons
 *   └──────────────────────────────┘
 *
 * The keys move in three boxes, one per card, Tab and Shift-Tab cycling them:
 * projects (by project), project (its settings button) and agents (by agent;
 * Enter opens the agent's tab, `x` asks to kill it, as its buttons do).
 * The layout (`sidebarCardsLayout`) is pure: it sizes the cards to the rows
 * (Projects shrinks to a `+N more` window before Agents loses rows), keeps
 * the cursor's row (an expanded agent's whole block) in view and lists every
 * body row, which drawing (`drawSidebarCards`) and clicks
 * (`sidebarCardTarget`) both read.
 */
import { stringWidth } from '../cellWidth.ts';
import { ATTENTION_BADGE, fitRow, fitText, type SidebarAgent, type SidebarModel } from '../tui/sidebar.ts';
import { windowStart, wrapText } from '../tui/taskList.ts';
import { collapseMarker, drawBadge, drawBox } from './chrome.ts';
import type { SidebarKey } from './dispatch.ts';
import { drawText, fillRect, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { attentionRole, badgeRole, phaseRole, projectStateRole, styleOf, type StatusRole, type Theme } from './theme.ts';
import { drawRuns, type Run } from './widgets.ts';

// ── navigation ───────────────────────────────────────────────────────────────

/** The three boxes the sidebar keys move in, one per card, in Tab order: every project, the active project, its agents. */
export type SidebarBox = 'projects' | 'project' | 'agents';

const BOX_ORDER: readonly SidebarBox[] = ['projects', 'project', 'agents'];

/** The sidebar's cursor: the box the keys move in and the selected project and agent (by key, so a reorder keeps them). */
export interface SidebarNav {
  box: SidebarBox;
  projectKey: string | null;
  agentKey: string | null;
  /** The keys of the agents drawn expanded; in memory only (not in view-state.json), pruned by `pruneExpanded`. */
  expanded: ReadonlySet<string>;
}

export const INITIAL_SIDEBAR_NAV: SidebarNav = Object.freeze({ box: 'agents', projectKey: null, agentKey: null, expanded: new Set<string>() });

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
  /** The Project card's `[ SETTINGS ]` button: the active project's settings. */
  | { type: 'openSettings'; projectId: string }
  /** An expanded agent's `[ KILL ]` button or the kill key: the app asks first, then resets a worker's task or removes a scout. */
  | { type: 'killAgent'; projectId: string; agentId: string; kind: 'worker' | 'scout'; taskRef: string | null }
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
 * at either end; the project box holds only its settings button), switchBox
 * and prevBox cycle the projects, project and agents boxes, open opens the
 * project, the settings or the agent under the cursor, toggle expands or
 * collapses the agent under the cursor and kill asks to kill it (both nothing
 * in the other boxes), back returns to the pane.
 */
export function navigateSidebar(view: SidebarCursor, nav: SidebarNav, key: SidebarKey): SidebarStep {
  const { model } = view;
  const projects = nav.box === 'projects';
  const length = projects ? model.projects.length : model.agents.length;
  const current = projects ? view.projectIndex : view.agentIndex;
  switch (key) {
    case 'back': return { nav, command: { type: 'focusSlot' } };
    case 'switchBox':
    case 'prevBox': {
      const step = key === 'switchBox' ? 1 : BOX_ORDER.length - 1;
      return { nav: { ...nav, box: BOX_ORDER[(BOX_ORDER.indexOf(nav.box) + step) % BOX_ORDER.length] }, command: null };
    }
    case 'up':
    case 'down': {
      if (nav.box === 'project' || length === 0) return { nav, command: null };
      const next = Math.max(0, Math.min(length - 1, current + (key === 'up' ? -1 : 1)));
      return { nav: projects ? { ...nav, projectKey: model.projects[next].project_id } : { ...nav, agentKey: model.agents[next].key }, command: null };
    }
    case 'open': {
      if (nav.box === 'project') return openSettingsStep(nav, model);
      if (length === 0) return { nav, command: null };
      return projects ? openProjectStep(nav, model, current) : openAgentStep(nav, model, current);
    }
    case 'toggle': {
      if (nav.box !== 'agents' || length === 0) return { nav, command: null };
      return { nav: toggleAgent(nav, model.agents[current].key), command: null };
    }
    case 'kill': {
      if (nav.box !== 'agents' || length === 0) return { nav, command: null };
      return killAgentStep(nav, model, current);
    }
  }
}

/** `nav` with the agent `key` expanded if it was collapsed, else collapsed; the cursor goes to it. */
function toggleAgent(nav: SidebarNav, key: string): SidebarNav {
  const expanded = new Set(nav.expanded);
  if (!expanded.delete(key)) expanded.add(key);
  return { ...nav, box: 'agents', agentKey: key, expanded };
}

/**
 * `nav` without the expanded keys of agents no longer in `model` (the same
 * object when none went). A model without the active project's status (before
 * its first load, or while it reconnects) lists no agents and prunes nothing.
 */
export function pruneExpanded(nav: SidebarNav, model: SidebarModel): SidebarNav {
  if (nav.expanded.size === 0 || model.status.workers === null) return nav;
  const live = new Set(model.agents.map((agent) => agent.key));
  const kept = [...nav.expanded].filter((key) => live.has(key));
  return kept.length === nav.expanded.size ? nav : { ...nav, expanded: new Set(kept) };
}

function openProjectStep(nav: SidebarNav, model: SidebarModel, index: number): SidebarStep {
  const project = model.projects[index];
  // Another project lists other agents: the agents cursor starts at the top again.
  const agentKey = project.project_id === model.activeProjectId ? nav.agentKey : null;
  return { nav: { ...nav, box: 'projects', projectKey: project.project_id, agentKey }, command: { type: 'openProject', projectId: project.project_id } };
}

/** The settings button: the active project's settings (nothing without an active project). */
function openSettingsStep(nav: SidebarNav, model: SidebarModel): SidebarStep {
  return { nav: { ...nav, box: 'project' }, command: model.activeProjectId ? { type: 'openSettings', projectId: model.activeProjectId } : null };
}

function openAgentStep(nav: SidebarNav, model: SidebarModel, index: number): SidebarStep {
  const agent = model.agents[index];
  const next: SidebarNav = { ...nav, box: 'agents', agentKey: agent.key };
  return { nav: next, command: model.activeProjectId ? { type: 'openAgent', projectId: model.activeProjectId, agentId: agent.agent_id } : null };
}

/** Asks to kill the agent at `index`: a scout is removed, a worker's task reset (the cursor goes to it). */
function killAgentStep(nav: SidebarNav, model: SidebarModel, index: number): SidebarStep {
  const agent = model.agents[index];
  const next: SidebarNav = { ...nav, box: 'agents', agentKey: agent.key };
  if (!model.activeProjectId) return { nav: next, command: null };
  return {
    nav: next,
    command: {
      type: 'killAgent', projectId: model.activeProjectId, agentId: agent.agent_id,
      kind: agent.role === 'scout' ? 'scout' : 'worker', taskRef: agent.task_ref ?? null,
    },
  };
}

// ── layout ───────────────────────────────────────────────────────────────────

/** The cards, top to bottom: Projects, Project and Agents; each is the box of the same name. */
export type SidebarCard = SidebarBox;

/** The rows of an expanded agent's block, top to bottom (`task` only with a task, `detail` up to twice). */
export type BlockPart = 'top' | 'model' | 'task' | 'detail' | 'buttons' | 'bottom';

/** A card's body row: what is drawn there and what a click on it hits. */
export type CardLine =
  | { kind: 'coordinator' } | { kind: 'workers' } | { kind: 'tasks' } | { kind: 'notice' } | { kind: 'settings' } | { kind: 'noProjects' }
  | { kind: 'project'; index: number }
  | { kind: 'agent'; index: number } | { kind: 'detail'; index: number }
  /** A row of an expanded agent's block; a `detail` part carries its wrapped line. */
  | { kind: 'block'; index: number; part: BlockPart; text?: string }
  | { kind: 'more'; count: number }
  | { kind: 'empty' };

/** A card as laid out: its first row and rows (borders included) in the sidebar, and its body rows, in order. */
export interface CardLayout { card: SidebarCard; y: number; rows: number; lines: CardLine[] }

export interface SidebarCardsLayout extends SidebarCursor {
  cols: number;
  rows: number;
  /** The card the keys' cursor is in: the card of the box the keys move in. */
  cursorCard: SidebarCard;
  /** Top to bottom; Projects is left out when there is no row for it (and the cursor is not in it). */
  cards: CardLayout[];
}

/** Rows of a card's top and bottom borders. */
const BORDERS = 2;
/** Blank rows between two cards (no card's: the canvas shows through). */
const CARD_GAP = 1;
/** The fewest rows a card keeps when space runs short: one body row. */
const MIN_CARD_ROWS = BORDERS + 1;

/** Columns of an expanded block's text: the card's inner width less the block's borders and a column of padding inside each. */
const blockTextCols = (cols: number): number => Math.max(1, cols - BORDERS - 4);
/** The most rows an expanded block gives the activity or question. */
const BLOCK_DETAIL_LINES = 2;

/** `text` wrapped to `width` in at most two lines, the second cut (with an ellipsis) when there is more. */
function blockDetail(text: string | null, width: number): string[] {
  if (!text) return [];
  const wrapped = wrapText(text, width);
  const lines = wrapped.length > BLOCK_DETAIL_LINES
    ? [...wrapped.slice(0, BLOCK_DETAIL_LINES - 1), wrapped.slice(BLOCK_DETAIL_LINES - 1).join(' ')]
    : wrapped;
  // wrapText counts code units: a line of wide graphemes is cut again by display width.
  return lines.map((line) => fitText(line, width));
}

/**
 * What an expanded block says below the task: the question or reason of an
 * agent needing a human, else the activity only when it says something the
 * block does not (never the task it falls back to, the bare role a scout
 * shows, or the phase or state the badge already shows).
 */
function blockDetailText(agent: SidebarAgent): string | null {
  if (agent.attention) return agent.detail;
  const text = agent.detail?.trim();
  if (!text) return null;
  const repeats = [agent.task_ref, agent.role, agent.phase].some((other) => other != null && other.toLowerCase() === text.toLowerCase());
  return repeats ? null : text;
}

/**
 * Each agent's rows in a card `cols` wide: collapsed, its row and (when it
 * needs attention) its question or reason; expanded, its block.
 */
function agentBlocks(agents: SidebarAgent[], expanded: ReadonlySet<string>, cols: number): CardLine[][] {
  return agents.map((agent, index): CardLine[] => {
    if (!expanded.has(agent.key)) return agent.attention ? [{ kind: 'agent', index }, { kind: 'detail', index }] : [{ kind: 'agent', index }];
    const part = (name: BlockPart, text?: string): CardLine => (text === undefined ? { kind: 'block', index, part: name } : { kind: 'block', index, part: name, text });
    return [
      part('top'), part('model'), ...(agent.task_ref ? [part('task')] : []),
      ...blockDetail(blockDetailText(agent), blockTextCols(cols)).map((text) => part('detail', text)),
      part('buttons'), part('bottom'),
    ];
  });
}

/**
 * The Projects body in `body` rows: every project when they fit, else a
 * window around `anchor` (an index into `model.projects`) and a `+N more`
 * line for the rest; in one row only the anchor's (the card's count tells the rest).
 */
function projectsLines(model: SidebarModel, body: number, anchor: number): CardLine[] {
  if (body <= 0) return [];
  const count = model.projects.length;
  if (count === 0) return [{ kind: 'noProjects' }];
  const line = (index: number): CardLine => ({ kind: 'project', index });
  if (count <= body) return model.projects.map((_, index) => line(index));
  const shown = Math.max(1, body - 1);
  const start = windowStart(anchor, count, shown);
  const lines = Array.from({ length: shown }, (_, offset) => line(start + offset));
  if (lines.length < body) lines.push({ kind: 'more', count: count - shown });
  return lines;
}

/** The Project card's body rows in drawn order: coordinator, workers, tasks (with the status), the notice (while there is one), the settings button. */
function projectCardLines(model: SidebarModel): CardLine[] {
  const notice: CardLine[] = model.notice ? [{ kind: 'notice' }] : [];
  if (model.activeProjectId === null) return notice;
  return [{ kind: 'coordinator' }, { kind: 'workers' }, ...(model.tasks ? [{ kind: 'tasks' } as const] : []), ...notice, { kind: 'settings' }];
}

/**
 * `lines` cut to `body` rows: the coordinator row, the notice and the
 * settings button go last (the button first while the cursor is on it), in
 * drawn order.
 */
function fitProjectLines(lines: CardLine[], body: number, box: SidebarBox): CardLine[] {
  if (lines.length <= body) return lines;
  const order: CardLine['kind'][] = box === 'project'
    ? ['settings', 'coordinator', 'notice', 'workers', 'tasks']
    : ['coordinator', 'notice', 'settings', 'workers', 'tasks'];
  const kept = new Set([...lines].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, Math.max(0, body)));
  return lines.filter((line) => kept.has(line));
}

/**
 * The Agents body in `body` rows from each agent's rows (`blocks`): every
 * agent when they fit, else a window that starts as high as the cursor's
 * agent allows (its whole block in view when it fits) and a `+N more` line for
 * the agents left out.
 */
function agentLines(blocks: CardLine[][], body: number, cursor: number): CardLine[] {
  if (body <= 0) return [];
  if (blocks.length === 0) return [{ kind: 'empty' }];
  const height = (index: number): number => blocks[index].length;
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  if (total <= body) return blocks.flat();
  // A row for the `+N more` line, only when another agent can be left out.
  const room = blocks.length > 1 && body >= 2 ? body - 1 : body;
  let start = 0;
  let used = blocks.slice(0, cursor + 1).reduce((sum, block) => sum + block.length, 0);
  while (used > room && start < cursor) used -= height(start++);
  let end = cursor + 1;
  while (end < blocks.length && used + height(end) <= room) used += height(end++);
  while (start > 0 && used + height(start - 1) <= room) used += height(--start);
  const lines = blocks.slice(start, end).flat().slice(0, room);
  const hidden = blocks.length - (end - start);
  if (hidden > 0 && lines.length < body) lines.push({ kind: 'more', count: hidden });
  return lines;
}

/**
 * The cards in `rows` by `cols`. Projects takes a row per project, the
 * Project card a row per line (at most 5), Agents the rest. When rows run out
 * Projects shrinks first (down to a window of the cursor's project, else the
 * active one, and a `+N more` line), then the Agents card down to the cursor agent's row (an
 * expanded agent's whole block, and a `+N more` line when there are other
 * agents), then the Project card (down to one row), then Projects goes unless
 * the cursor is in it. Rows the Agents window leaves unused go back to a
 * shrunk Project card, then to a shrunk Projects. Each card's lines keep the
 * cursor's row in view. A blank row (no card's) separates two cards and counts
 * in `rows`; a sidebar too short for the gaps draws the cards border to border.
 */
export function sidebarCardsLayout(model: SidebarModel, rows: number, nav: SidebarNav, cols: number): SidebarCardsLayout {
  const cursor = sidebarCursor(model, nav);
  const activeIndex = model.projects.findIndex((project) => project.active);
  // The Projects window follows the cursor while the keys are in it, else keeps the active project in view.
  const anchor = nav.box === 'projects' || activeIndex < 0 ? cursor.projectIndex : activeIndex;
  const allProjectLines = projectCardLines(model);

  const projectsFull = BORDERS + Math.max(1, model.projects.length);
  // Projects keeps a project's row and, with more projects, the `+N more` line.
  const projectsMin = BORDERS + Math.min(2, Math.max(1, model.projects.length));
  const projectFull = BORDERS + Math.max(1, allProjectLines.length);
  const blocks = agentBlocks(model.agents, nav.expanded, cols);
  const agentsFull = BORDERS + Math.max(1, blocks.reduce((sum, block) => sum + block.length, 0));
  const cursorAgent = model.agents[cursor.agentIndex];
  // The Agents card's least: the cursor agent's row, or its expanded block, and a `+N more` line for the other agents.
  const agentsMin = BORDERS + (cursorAgent && nav.expanded.has(cursorAgent.key) ? blocks[cursor.agentIndex].length : 1) + (model.agents.length > 1 ? 1 : 0);

  const body = (cardRows: number) => Math.max(0, cardRows - BORDERS);
  const anyExpanded = model.agents.some((agent) => nav.expanded.has(agent.key));
  /** Each card's rows when the cards share `space` rows. */
  const size = (space: number): { projects: number; project: number; agents: number } => {
    let projects = projectsFull;
    let project = projectFull;
    if (projects + project + agentsFull > space) projects = Math.max(projectsMin, Math.min(projectsFull, space - project - agentsFull));
    if (space - projects - project < agentsMin) project = Math.max(MIN_CARD_ROWS, space - projects - agentsMin);
    if (space - projects - project < agentsMin && nav.box !== 'projects') projects = 0;
    // A sidebar too short for every card: the top ones keep their rows, the rest are cut.
    projects = Math.max(0, Math.min(projects, space));
    project = Math.max(0, Math.min(project, space - projects));
    let agents = Math.max(0, space - projects - project);
    const unused = () => body(agents) - agentLines(blocks, body(agents), cursor.agentIndex).length;
    // An expanded block can leave the Agents window well short of its card: a shrunk Project card takes those rows
    // back first, then a shrunk Projects, the reverse of the order they shrank in.
    if (anyExpanded && project < projectFull) {
      const spare = Math.min(projectFull - project, unused());
      if (spare > 0) { project += spare; agents -= spare; }
    }
    if (anyExpanded && projects > 0 && projects < projectsFull) {
      const spare = Math.min(projectsFull - projects, unused());
      if (spare > 0) { projects += spare; agents -= spare; }
    }
    return { projects, project, agents };
  };

  // A blank row between cards, counted in the rows; a sidebar too short for them drops the gaps before the
  // Project card loses rows, Projects goes or Agents is down to its least.
  const flush = size(rows);
  let gapped = size(rows - CARD_GAP * 2);
  if (gapped.projects === 0) gapped = size(rows - CARD_GAP);
  const keepGaps = (gapped.agents > agentsMin || gapped.agents === flush.agents)
    && gapped.project === flush.project && (gapped.projects > 0) === (flush.projects > 0);
  const { projects, project, agents } = keepGaps ? gapped : flush;
  const gap = keepGaps ? CARD_GAP : 0;

  const cards: CardLayout[] = [];
  if (projects > 0) cards.push({ card: 'projects', y: 0, rows: projects, lines: projectsLines(model, body(projects), anchor) });
  const projectY = projects > 0 ? projects + gap : 0;
  cards.push({ card: 'project', y: projectY, rows: project, lines: fitProjectLines(allProjectLines, body(project), nav.box) });
  cards.push({ card: 'agents', y: projectY + project + gap, rows: agents, lines: agentLines(blocks, body(agents), cursor.agentIndex) });
  return { ...cursor, cols, rows, cursorCard: nav.box, cards };
}

/** An expanded agent's buttons, left to right. */
export type AgentButton = 'open' | 'kill';

/**
 * What a click hits: a project's or an agent's row, whether it hit the agent
 * row's collapse marker, and (set only then) the Project card's settings
 * button or an expanded agent's button.
 */
export interface SidebarCardTarget { card: SidebarCard; index: number; onMarker: boolean; settings?: true; button?: AgentButton }

/** The Project card's settings button, as drawn. */
export const SETTINGS_BUTTON = '[ SETTINGS ]';
/** An expanded agent's buttons as drawn, one column apart. */
export const AGENT_BUTTONS: ReadonlyArray<{ button: AgentButton; label: string }> = [{ button: 'open', label: '[ OPEN ]' }, { button: 'kill', label: '[ KILL ]' }];
const AGENT_BUTTON_GAP = 1;
/** Before the active project's name on its Projects row. */
const ACTIVE_MARK = '▸ ';

/** Columns of padding inside each side border. */
const PAD = 1;
/** Columns of the collapse marker, which starts after the left border and its padding. */
const MARKER_COLS = stringWidth(collapseMarker(false));
/** The marker's first column on an expanded block's top row: after the card's border, the block's corner and a space. */
const BLOCK_MARKER_X = 3;
/** An expanded block's text, its buttons included, starts in the marker's column. */
const BLOCK_TEXT_X = BLOCK_MARKER_X;

/** Each agent button's columns on a block's buttons row, as far as `textCols` columns of text hold them (a cut button is drawn cut). */
function agentButtonSpans(x: number, textCols: number): Array<{ button: AgentButton; label: string; x: number; cols: number }> {
  const spans = [];
  let at = x;
  for (const { button, label } of AGENT_BUTTONS) {
    const cols = Math.min(stringWidth(label), x + textCols - at);
    if (cols <= 0) break;
    spans.push({ button, label, x: at, cols });
    at += stringWidth(label) + AGENT_BUTTON_GAP;
  }
  return spans;
}

/** The row under (x, y), relative to the sidebar; null on a border, a blank row, a `+N more` or empty-state line. */
export function sidebarCardTarget(layout: SidebarCardsLayout, x: number, y: number): SidebarCardTarget | null {
  if (x < 1 || x > layout.cols - 2) return null;
  const card = layout.cards.find((candidate) => y >= candidate.y && y < candidate.y + candidate.rows);
  if (!card) return null;
  const row = y - card.y - 1;
  if (row < 0 || row >= card.rows - BORDERS) return null;
  const line = card.lines[row];
  const active = layout.model.projects.findIndex((project) => project.active);
  switch (line?.kind) {
    case 'coordinator':
    case 'workers':
    case 'tasks':
      return active >= 0 ? { card: 'project', index: active, onMarker: false } : null;
    case 'settings': {
      const onButton = x >= 1 + PAD && x < 1 + PAD + Math.min(stringWidth(SETTINGS_BUTTON), layout.cols - 2 - 2 * PAD);
      return active >= 0 && onButton ? { card: 'project', index: active, onMarker: false, settings: true } : null;
    }
    case 'project': return { card: 'projects', index: line.index, onMarker: false };
    case 'agent': return { card: 'agents', index: line.index, onMarker: x >= 1 + PAD && x < 1 + PAD + MARKER_COLS };
    case 'detail': return { card: 'agents', index: line.index, onMarker: false };
    case 'block': {
      if (line.part === 'buttons') {
        const hit = agentButtonSpans(BLOCK_TEXT_X, layout.cols - 2 - 4).find((span) => x >= span.x && x < span.x + span.cols);
        if (hit) return { card: 'agents', index: line.index, onMarker: false, button: hit.button };
      }
      return { card: 'agents', index: line.index, onMarker: line.part === 'top' && x >= BLOCK_MARKER_X && x < BLOCK_MARKER_X + MARKER_COLS };
    }
    default: return null;
  }
}

/**
 * A click at (x, y) in the sidebar: the row's box gets the cursor and its
 * project or agent opens, on the settings button the active project's settings
 * open, on an expanded agent's `[ KILL ]` the app is asked to kill it, or, on
 * an agent's collapse marker, the agent expands or collapses (no command).
 * Null off the rows.
 */
export function sidebarCardClick(layout: SidebarCardsLayout, nav: SidebarNav, x: number, y: number): SidebarStep | null {
  const target = sidebarCardTarget(layout, x, y);
  if (!target) return null;
  if (target.settings) return openSettingsStep(nav, layout.model);
  if (target.button === 'kill') return killAgentStep(nav, layout.model, target.index);
  if (target.onMarker) return { nav: toggleAgent(nav, layout.model.agents[target.index].key), command: null };
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
  /** A shorter `left` used instead of cutting `left` (an agent row drops its role rather than show it as `…`). */
  leftShort?: string;
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
  if (row.leftShort !== undefined && fitted.left !== row.left) {
    const short = fitRow(row.leftShort, tailOf(before), cols);
    if (short.right === fitted.right) fitted = short;
  }
  const showTail = row.badge !== undefined && fitted.right === tailOf(before);
  const left = showTail ? fitted.left : fitText(row.leftShort ?? row.left, cols);
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
  const focusedCard: SidebarCard | null = focus;
  const active = model.projects.find((project) => project.active) ?? null;
  const bottom = region.y + region.rows;

  for (const card of layout.cards) {
    // Rows below the region never hold a card: a sidebar too short cuts them.
    const rows = Math.min(card.rows, bottom - (region.y + card.y));
    if (rows < 2) continue;
    const focused = card.card === focusedCard;
    const title = card.card === 'project' ? active?.name ?? 'Project' : card.card === 'projects' ? 'Projects' : 'Agents';
    const count = card.card === 'projects'
      ? model.projects.length > 0 ? String(model.projects.length) : ''
      : card.card === 'agents' && model.agents.length > 0 ? `${model.agents.length} ${model.agentsStale ? 'stale' : 'live'}` : '';
    const inner = drawBox(frame, { x: region.x, y: region.y + card.y, cols: region.cols, rows: card.rows }, { title, meta: count, focused, theme });
    // A cut card draws a full box whose lower part the next card or the frame's edge covers: only the rows in the region get body text.
    // One column of padding inside each border; the cursor row's bar spans it too.
    card.lines.slice(0, Math.min(inner.rows, rows - 1)).forEach((line, offset) => {
      const cursor = focused && isCursorLine(layout, line);
      if (cursor) fillRect(frame, { x: inner.x, y: inner.y + offset, cols: inner.cols, rows: 1 }, { ...role('text.primary'), ...theme.roles['row.cursor'] });
      // An expanded block's border takes the padding columns: it spans the card's inner width.
      if (line.kind === 'block') drawBlockLine(frame, inner.x, inner.y + offset, inner.cols, line, cursor);
      else drawLine(frame, inner.x + PAD, inner.y + offset, inner.cols - 2 * PAD, line, cursor);
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
      case 'tasks': {
        const counts = model.tasks ?? {};
        const open = (['todo', 'in_progress'] as const).filter((key) => (counts[key] ?? 0) > 0).map((key) => `${counts[key]} ${key.replace('_', ' ')}`);
        drawCardRow(frame, x, y, cols, { left: open.length > 0 ? `tasks ${open.join(' · ')}` : 'no open tasks', leftRuns: plain, cursor }, theme);
        return;
      }
      case 'settings':
        drawCardRow(frame, x, y, cols, { left: SETTINGS_BUTTON, leftRuns: (shown) => [[shown, role('button'), true]], cursor }, theme);
        return;
      case 'noProjects':
        drawRuns(frame, x, y, [[fitText('(none)', cols), role('text.muted')]], cols);
        return;
      case 'notice':
        if (model.notice) drawRuns(frame, x, y, [[fitText(model.notice, cols), role('status.warn')]], cols);
        return;
      case 'project': {
        const project = model.projects[line.index];
        const after: Run[] = project.attention > 0 ? [[' ', role('text.primary')], [`!${project.attention}`, role(badgeRole('status.attention')), true]] : [];
        // The active project is marked and in text.accent; the others line up under its name.
        const leftRuns = (shown: string): Run[] => [[shown, role(project.active ? 'text.accent' : 'text.primary')]];
        drawCardRow(frame, x, y, cols, {
          left: `${project.active ? ACTIVE_MARK : ' '.repeat(stringWidth(ACTIVE_MARK))}${project.name}`, leftRuns,
          badge: { label: project.state, role: projectStateRole(project.state) }, after, cursor,
        }, theme);
        return;
      }
      case 'agent':
        drawCardRow(frame, x, y, cols, agentRow(model.agents[line.index], false, cursor), theme);
        return;
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
      case 'block':
        return;
    }
  }

  /** An agent's row: marker, name and role left, elapsed time and the attention kind's or the phase's badge flush right. */
  function agentRow(agent: SidebarAgent, expanded: boolean, cursor: boolean): CardRow {
    return {
      left: `${collapseMarker(expanded)} ${agent.agent_id} ${agent.role}`,
      leftShort: `${collapseMarker(expanded)} ${agent.agent_id}`,
      leftRuns: (left) => agentRuns(agent, expanded, left),
      before: agent.elapsed ? [[`${agent.elapsed} `, role('text.muted')]] : [],
      badge: { label: agent.attention ? ATTENTION_BADGE[agent.attention] : agent.phase, role: agentStatusRole(agent) },
      cursor, dim: model.agentsStale,
    };
  }

  /**
   * One row of an expanded agent's block, `cols` wide: the border in the
   * agent's status role (dim on a stale list), the agent's row in the top
   * border, then its provider and model, task, activity or question (in the
   * attention kind's role) and its buttons (`[ OPEN ]` in `tab.active`,
   * `[ KILL ]` in `button.danger`), each cut by display width.
   */
  function drawBlockLine(frame: Frame, x: number, y: number, cols: number, line: Extract<CardLine, { kind: 'block' }>, cursor: boolean): void {
    if (cols < 4) return;
    const agent = model.agents[line.index];
    const stale = model.agentsStale;
    const styled = (style: CellStyle): CellStyle => (stale ? { ...style, dim: true } : style);
    const border = styled(role(agentStatusRole(agent)));
    if (line.part === 'bottom') {
      drawText(frame, x, y, `└${'─'.repeat(cols - 2)}┘`, border, cols);
      return;
    }
    const top = line.part === 'top';
    drawText(frame, x, y, top ? '┌' : '│', border, 1);
    drawText(frame, x + cols - 1, y, top ? '┐' : '│', border, 1);
    const textCols = cols - 4;
    if (textCols <= 0) return;
    if (top) {
      drawCardRow(frame, x + 2, y, textCols, agentRow(agent, true, cursor), theme);
      return;
    }
    const muted = styled(role('text.muted'));
    const primary = styled(role('text.primary'));
    if (line.part === 'buttons') {
      for (const span of agentButtonSpans(x + 2, textCols)) {
        drawText(frame, span.x, y, span.label, styled(role(span.button === 'kill' ? 'button.danger' : 'tab.active')), span.cols);
      }
      return;
    }
    const separator = ' · ';
    const runs: Run[] = line.part === 'model'
      ? cutRuns([[agent.provider ?? '-', primary], [separator, muted], [agent.model ?? '-', primary]], textCols)
      : line.part === 'task' ? [[fitText(agent.task_ref ?? '', textCols), primary]]
      : [[fitText(line.text ?? '', textCols), styled(role(agent.attention ? attentionRole(agent.attention) : 'text.muted'))]];
    drawRuns(frame, x + 2, y, runs, textCols);
  }

  /** An agent row's left part as runs: the marker, the name (`text.accent`), the role and elapsed time (`text.muted`). */
  function agentRuns(agent: SidebarAgent, expanded: boolean, shown: string): Run[] {
    const marker = `${collapseMarker(expanded)} `;
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

/** `runs` cut to `cols` by display width, the cut run ending in an ellipsis (fitText). */
function cutRuns(runs: readonly Run[], cols: number): Run[] {
  const whole = fitText(runsText(runs), cols);
  const out: Run[] = [];
  let rest = whole;
  for (const [text, style] of runs) {
    if (!rest) break;
    const take = rest.startsWith(text) ? text : rest;
    out.push([take, style]);
    rest = rest.slice(take.length);
  }
  return out;
}

/** An agent's status role: its attention kind's, else its phase's; an expanded block's border and the agent's badge use it. */
export function agentStatusRole(agent: SidebarAgent): StatusRole {
  return agent.attention ? attentionRole(agent.attention) : phaseRole(agent.phase);
}

/** Whether `line` is the keys' cursor row (the caller checks its card is the focused one); an expanded agent's is its block's top row. */
function isCursorLine(layout: SidebarCardsLayout, line: CardLine): boolean {
  switch (line.kind) {
    case 'settings': return true;
    case 'project': return line.index === layout.projectIndex;
    case 'agent': return line.index === layout.agentIndex;
    case 'block': return line.part === 'top' && line.index === layout.agentIndex;
    default: return false;
  }
}
