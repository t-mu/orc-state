/**
 * lib/cockpit2/sidebarCards.ts — the cockpit sidebar as three square cards
 * (Plan 7 Step 8), drawn from the sidebar model of lib/tui/sidebar.ts:
 *
 *   ┌─ [ PROJECTS ] ─────────── 2 ─┐   Projects: every registered project, one row
 *   │ ▸ orc-state        [RUNNING] │   each, state badge and `!N` when its agents
 *   │                              │   need a human; `▸` marks the active one;
 *   │   arek-on-trail       [IDLE] │   an add-project button on its last row
 *   │ [ + ADD PROJECT ]            │
 *   └──────────────────────────────┘
 *                                      a blank row between cards (the canvas)
 *   ┌─ [ ORC-STATE ] ──────────────┐   Project: the active project, its coordinator
 *   │ coordinator        [RUNNING] │   state as one badge, its worker capacity, its
 *   │ workers 2/4                  │   open task counts, the notice (only while
 *   │ tasks 3 todo · 1 in progress │   there is one) and a settings button on its
 *   │ [ SETTINGS ]                 │   last row
 *   └──────────────────────────────┘
 *
 *   ┌─ [ AGENTS ] ─────── 3 live ──┐   Agents: one collapsed row each; an agent
 *   │ [+] grommash worker [PERMI…] │   needing attention keeps its question or
 *   │     ? may I run npm test     │   reason on a second row. An expanded agent
 *   │┌ [-] boin worker 3m [IMPL…] ┐│   (Plan 7 Step 9: Space or a click on its
 *   ││ model  claude · opus       ││   marker) is a box in its status role: the
 *   ││ task   cockpit-style/foo   ││   row, then labelled rows: its provider and
 *   ││ doing  editing app.ts      ││   model (`default` when unknown), its task
 *   ││ [ OPEN ] [ KILL ]          ││   (a scout's brief instead), its activity
 *   │└────────────────────────────┘│   when it says more than the row (at most
 *   │ [ + NEW AGENT ]              │   two lines) or, unlabelled, its question
 *   └──────────────────────────────┘   or reason; and two buttons. A new-agent
 *                                      button on the card's last row
 *
 * After the coordinator's agents the Agents card lists the cockpit's own agent
 * sessions of the active project (`agent:N` tabs started from the new-agent
 * dialog, outside the coordinator), each flagged as such: a muted `◇` before
 * its label and `[LOCAL]` in status.local (`[ENDED]` in status.idle once its
 * session ended). Expanded: its provider with the CLI's default model, its
 * type or custom agent, a note and the same two buttons (KILL closes its tab):
 *
 *   │ [+] ◇ claude 1       2m [LOCAL] │
 *   │┌ [-] ◇ critic · claude [LOCAL] ┐│
 *   ││ model  claude · default       ││
 *   ││ agent  critic                 ││
 *   ││ not managed by the            ││
 *   ││ coordinator                   ││
 *   ││ [ OPEN ] [ KILL ]             ││
 *   │└───────────────────────────────┘│
 *
 * Each card's action button sits on its last body row whatever the card's
 * height; its list scrolls in the rows above it. The cards share the rows
 * equally (the remainder to Agents) until the Agents content needs more.
 * Rows a card's list leaves blank go to air (`padCard`): a blank row between
 * each two items, then one under the top border, then one above the button;
 * they never count in the card heights.
 * The keys move in three boxes, one per card, Tab and Shift-Tab cycling them:
 * projects (by project, then its add button), project (its settings button)
 * and agents (by agent, then its new-agent button; Enter or a click on an
 * agent's row expands or collapses it, `↓` from an expanded agent's row goes
 * to its buttons, `→`/`←` move between them and Enter presses one: only
 * `[ OPEN ]` opens the agent's tab; `x` asks to kill it). The layout
 * (`sidebarCardsLayout`) is pure: it sizes the cards to the rows, keeps the
 * cursor's row (an expanded agent's whole block, or a button) in view and
 * lists every body row, which drawing (`drawSidebarCards`) and clicks
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
  /** The cursor is on the box's action button after its list (projects: add project, agents: new agent); left out on an item. */
  onButton?: true;
  /**
   * The cursor is on one of the cursor agent's buttons (its expanded block's `[ OPEN ]` or `[ KILL ]`) rather than its
   * row; left out on the row, and of no effect unless the cursor agent is expanded.
   */
  agentButton?: AgentButton;
}

/** An expanded agent's buttons, left to right. */
export type AgentButton = 'open' | 'kill';

export const INITIAL_SIDEBAR_NAV: SidebarNav = Object.freeze({ box: 'agents', projectKey: null, agentKey: null, expanded: new Set<string>() });

/**
 * An agent session the cockpit started itself (an `agent:N` tab of the active
 * project): not a registered agent, so not in the model; listed after the
 * coordinator's agents.
 */
export interface LocalAgent {
  /** Its tab's id (`agent:N`). */
  tabId: string;
  /** Its tab's label: `claude 1`, or `critic · claude` for a custom agent. */
  label: string;
  provider: string;
  variant: 'fresh' | 'custom';
  /** The custom agent it was started as; null for a fresh session. */
  agentName: string | null;
  /** False once its session ended (its tab not yet closed). */
  alive: boolean;
  /** Its run time since its tab was opened, when known. */
  elapsed?: string | null;
}

/** A local agent session's sidebar key: apart from every coordinator agent's (`<project>/<agent>`). */
export const localAgentKey = (projectId: string | null, tabId: string): string => `local:${projectId ?? ''}/${tabId}`;

/**
 * What navigation needs: the model, the cockpit's own agent sessions and the
 * cursor's indices into the projects and the agents (0 for an empty list). An
 * agent index runs over the model's agents, then the local sessions.
 */
export interface SidebarCursor {
  model: SidebarModel;
  locals: readonly LocalAgent[];
  projectIndex: number;
  agentIndex: number;
}

/** The Agents card's entry at `index`: a coordinator agent of the model, else a local session. */
type AgentEntry = { local: false; agent: SidebarAgent } | { local: true; session: LocalAgent };

function agentEntry(view: Pick<SidebarCursor, 'model' | 'locals'>, index: number): AgentEntry {
  const count = view.model.agents.length;
  return index < count ? { local: false, agent: view.model.agents[index] } : { local: true, session: view.locals[index - count] };
}

/** Every Agents card entry's key, in order: the coordinator's agents, then the local sessions. */
function agentKeys(model: SidebarModel, locals: readonly LocalAgent[]): string[] {
  return [...model.agents.map((agent) => agent.key), ...locals.map((session) => localAgentKey(model.activeProjectId, session.tabId))];
}

/** What a sidebar key or click asks the app to do. */
export type SidebarCommand =
  | { type: 'openProject'; projectId: string }
  | { type: 'openAgent'; projectId: string; agentId: string }
  /** The Project card's `[ SETTINGS ]` button: the active project's settings. */
  | { type: 'openSettings'; projectId: string }
  /** The Projects card's `[ + ADD PROJECT ]` button. */
  | { type: 'addProject' }
  /** The Agents card's `[ + NEW AGENT ]` button: a new agent in the active project. */
  | { type: 'newAgent'; projectId: string }
  /**
   * An expanded agent's `[ KILL ]` button or the kill key: the app asks first, then resets a worker's task, removes a
   * scout or, for a local agent session (`agentId` its tab id), closes its tab, which ends the session.
   */
  | { type: 'killAgent'; projectId: string; agentId: string; kind: 'worker' | 'scout' | 'local'; taskRef: string | null }
  | { type: 'focusSlot' };

export interface SidebarStep { nav: SidebarNav; command: SidebarCommand | null }

function indexOfKey(keys: string[], key: string | null, fallback: number): number {
  const index = key == null ? -1 : keys.indexOf(key);
  return index >= 0 ? index : Math.max(0, Math.min(fallback, keys.length - 1));
}

/** The cursor's indices for `nav` (the projects cursor defaults to the active project); `locals` follow the model's agents. */
export function sidebarCursor(model: SidebarModel, nav: SidebarNav, locals: readonly LocalAgent[] = []): SidebarCursor {
  return {
    model,
    locals,
    projectIndex: indexOfKey(model.projects.map((project) => project.project_id), nav.projectKey ?? model.activeProjectId, 0),
    agentIndex: indexOfKey(agentKeys(model, locals), nav.agentKey, 0),
  };
}

/**
 * Whether the cursor is on its box's action button: where `nav` put it, or in
 * an empty list (projects: always; agents: with an active project, which its
 * button needs). Never in the project box, whose only row is its button.
 */
function cursorOnButton(model: SidebarModel, nav: SidebarNav, agentCount: number): boolean {
  if (nav.box === 'projects') return nav.onButton === true || model.projects.length === 0;
  if (nav.box === 'agents') return model.activeProjectId !== null && (nav.onButton === true || agentCount === 0);
  return false;
}

/** `nav` with the cursor on an item's row rather than its box's action button or an agent's button. */
function onItem(nav: SidebarNav): SidebarNav {
  const { onButton: _onButton, agentButton: _agentButton, ...rest } = nav;
  return rest;
}

/**
 * The agent button the cursor is on: `nav.agentButton` while the keys' cursor
 * is on an agent (not the card's button) and that agent is expanded, else null.
 */
function cursorAgentButton(nav: SidebarNav, keys: readonly string[], agentIndex: number, onButton: boolean): AgentButton | null {
  if (nav.box !== 'agents' || onButton || !nav.agentButton) return null;
  const key = keys[agentIndex];
  return key !== undefined && nav.expanded.has(key) ? nav.agentButton : null;
}

/**
 * A navigation key: up and down move the cursor in the focused box, down past
 * the last item onto the box's action button (stopping at either end; the
 * project box holds only its settings button), switchBox and prevBox cycle the
 * projects, project and agents boxes, open opens the project or the settings
 * under the cursor, expands or collapses the agent under it, or presses the
 * button under it, toggle expands or collapses the agent under the cursor and
 * kill asks to kill it (both nothing in the other boxes or on a button), back
 * returns to the pane. An expanded agent's buttons are a row of the cursor's
 * own: down from its row lands on `[ OPEN ]`, expand and collapse move between
 * `[ OPEN ]` and `[ KILL ]` there, up returns to its row, down goes on to the
 * next agent (or the card's button), and up from below lands on it.
 */
export function navigateSidebar(view: SidebarCursor, nav: SidebarNav, key: SidebarKey): SidebarStep {
  const { model } = view;
  const keys = agentKeys(model, view.locals);
  const projects = nav.box === 'projects';
  const length = projects ? model.projects.length : keys.length;
  const current = projects ? view.projectIndex : view.agentIndex;
  const onButton = cursorOnButton(model, nav, keys.length);
  const at = (index: number): SidebarNav => onItem(projects ? { ...nav, projectKey: model.projects[index].project_id } : { ...nav, agentKey: keys[index] });
  const agentButton = cursorAgentButton(nav, keys, current, onButton);
  // An agent reached from below lands on its buttons when it is expanded.
  const fromBelow = (index: number): SidebarNav => (!projects && nav.expanded.has(keys[index]) ? { ...at(index), agentButton: 'open' } : at(index));
  switch (key) {
    case 'back': return { nav, command: { type: 'focusSlot' } };
    case 'switchBox':
    case 'prevBox': {
      const step = key === 'switchBox' ? 1 : BOX_ORDER.length - 1;
      return { nav: onItem({ ...nav, box: BOX_ORDER[(BOX_ORDER.indexOf(nav.box) + step) % BOX_ORDER.length] }), command: null };
    }
    case 'up':
    case 'down': {
      if (nav.box === 'project' || length === 0) return { nav, command: null };
      if (key === 'up') {
        if (onButton) return { nav: fromBelow(length - 1), command: null };
        if (agentButton) return { nav: at(current), command: null };
        return { nav: current > 0 ? fromBelow(current - 1) : at(0), command: null };
      }
      if (onButton) return { nav, command: null };
      // An expanded agent's row leads to its buttons, the first one focused.
      if (!projects && !agentButton && nav.expanded.has(keys[current])) return { nav: { ...at(current), agentButton: 'open' }, command: null };
      if (current < length - 1) return { nav: at(current + 1), command: null };
      // Past the last item the cursor lands on the button (the agents box has one only with an active project).
      return { nav: projects || model.activeProjectId !== null ? { ...at(current), onButton: true } : nav, command: null };
    }
    case 'open': {
      if (nav.box === 'project') return openSettingsStep(nav, model);
      if (onButton) return buttonStep(nav, model, nav.box);
      if (length === 0) return { nav, command: null };
      if (projects) return openProjectStep(nav, model, current);
      if (agentButton === 'open') return openAgentStep(nav, view, current);
      if (agentButton === 'kill') return killAgentStep(nav, view, current, 'kill');
      // Enter on an agent's row expands or collapses it; only its `[ OPEN ]` opens its tab.
      return { nav: toggleAgent(nav, keys[current]), command: null };
    }
    case 'toggle': {
      if (nav.box !== 'agents' || length === 0 || onButton) return { nav, command: null };
      return { nav: toggleAgent(nav, keys[current]), command: null };
    }
    case 'expand':
    case 'collapse': {
      // → expands the cursor agent, ← collapses it; either is a no-op when it already is.
      if (nav.box !== 'agents' || length === 0 || onButton) return { nav, command: null };
      // On the buttons → and ← move between them.
      if (agentButton) return { nav: { ...nav, agentButton: key === 'expand' ? 'kill' : 'open' }, command: null };
      const expanded = nav.expanded.has(keys[current]);
      if (expanded === (key === 'expand')) return { nav, command: null };
      return { nav: toggleAgent(nav, keys[current]), command: null };
    }
    case 'kill': {
      if (nav.box !== 'agents' || length === 0 || onButton) return { nav, command: null };
      return killAgentStep(nav, view, current, agentButton ?? undefined);
    }
  }
}

/** The Projects card's add button, or the Agents card's new-agent button (nothing without an active project); the cursor goes to it. */
function buttonStep(nav: SidebarNav, model: SidebarModel, box: 'projects' | 'agents'): SidebarStep {
  const next: SidebarNav = { ...nav, box, onButton: true };
  if (box === 'projects') return { nav: next, command: { type: 'addProject' } };
  return { nav: next, command: model.activeProjectId ? { type: 'newAgent', projectId: model.activeProjectId } : null };
}

/** `nav` with the agent `key` expanded if it was collapsed, else collapsed; the cursor goes to it. */
function toggleAgent(nav: SidebarNav, key: string): SidebarNav {
  const expanded = new Set(nav.expanded);
  if (!expanded.delete(key)) expanded.add(key);
  return onItem({ ...nav, box: 'agents', agentKey: key, expanded });
}

/**
 * `nav` without the expanded keys of agents no longer in `model` or `locals`
 * (the same object when none went). A model without the active project's
 * status (before its first load, or while it reconnects) lists no agents and
 * prunes only local sessions' keys.
 */
export function pruneExpanded(nav: SidebarNav, model: SidebarModel, locals: readonly LocalAgent[] = []): SidebarNav {
  if (nav.expanded.size === 0) return nav;
  const unloaded = model.status.workers === null;
  const live = new Set(agentKeys(model, locals));
  const kept = [...nav.expanded].filter((key) => live.has(key) || (unloaded && !key.startsWith('local:')));
  return kept.length === nav.expanded.size ? nav : { ...nav, expanded: new Set(kept) };
}

function openProjectStep(nav: SidebarNav, model: SidebarModel, index: number): SidebarStep {
  const project = model.projects[index];
  // Another project lists other agents: the agents cursor starts at the top again.
  const agentKey = project.project_id === model.activeProjectId ? nav.agentKey : null;
  return { nav: onItem({ ...nav, box: 'projects', projectKey: project.project_id, agentKey }), command: { type: 'openProject', projectId: project.project_id } };
}

/** The settings button: the active project's settings (nothing without an active project). */
function openSettingsStep(nav: SidebarNav, model: SidebarModel): SidebarStep {
  return { nav: onItem({ ...nav, box: 'project' }), command: model.activeProjectId ? { type: 'openSettings', projectId: model.activeProjectId } : null };
}

/** `nav` with the cursor on the agent `key`: its row, or its `button` (the agent expanded). */
function onAgent(nav: SidebarNav, key: string, button?: AgentButton): SidebarNav {
  const next = onItem({ ...nav, box: 'agents', agentKey: key });
  return button && nav.expanded.has(key) ? { ...next, agentButton: button } : next;
}

/** The agent's `[ OPEN ]`: opens the agent at `index`, a coordinator agent's tab or a local session's own (by its tab id); the cursor goes to the button. */
function openAgentStep(nav: SidebarNav, view: Pick<SidebarCursor, 'model' | 'locals'>, index: number): SidebarStep {
  const { model } = view;
  const entry = agentEntry(view, index);
  const next = onAgent(nav, agentKeys(model, view.locals)[index], 'open');
  const agentId = entry.local ? entry.session.tabId : entry.agent.agent_id;
  return { nav: next, command: model.activeProjectId ? { type: 'openAgent', projectId: model.activeProjectId, agentId } : null };
}

/**
 * Asks to kill the agent at `index`: a scout is removed, a worker's task reset, a local session's tab closed (the
 * cursor goes to it, on `button` when given: the button it was on or pressed).
 */
function killAgentStep(nav: SidebarNav, view: Pick<SidebarCursor, 'model' | 'locals'>, index: number, button?: AgentButton): SidebarStep {
  const { model } = view;
  const entry = agentEntry(view, index);
  const next = onAgent(nav, agentKeys(model, view.locals)[index], button);
  if (!model.activeProjectId) return { nav: next, command: null };
  if (entry.local) {
    return { nav: next, command: { type: 'killAgent', projectId: model.activeProjectId, agentId: entry.session.tabId, kind: 'local', taskRef: null } };
  }
  const { agent } = entry;
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

/**
 * The rows of an expanded agent's block, top to bottom: its top border, its title row (the agent's row inside the
 * box), then (`task` only with a task, `brief` only with a scout's brief, `detail` up to twice; `type` and `note` only
 * for a local session) its labelled rows, its buttons and its bottom border.
 */
export type BlockPart = 'top' | 'title' | 'model' | 'task' | 'brief' | 'type' | 'detail' | 'note' | 'buttons' | 'bottom';

/** A card's body row: what is drawn there and what a click on it hits. */
export type CardLine =
  | { kind: 'coordinator' } | { kind: 'workers' } | { kind: 'tasks' } | { kind: 'notice' } | { kind: 'settings' } | { kind: 'noProjects' }
  | { kind: 'project'; index: number }
  | { kind: 'agent'; index: number } | { kind: 'detail'; index: number }
  /** A row of an expanded agent's block; a `detail` part carries its wrapped line and, for an activity, its label (`doing`, then blank). */
  | { kind: 'block'; index: number; part: BlockPart; text?: string; label?: string }
  | { kind: 'more'; count: number }
  | { kind: 'empty' }
  /** The Projects card's add button and the Agents card's new-agent button, each on its card's last body row. */
  | { kind: 'addProject' } | { kind: 'newAgent' }
  /** A body row left blank: a card's padding, the spacing between its items, or the rows between its list and its button. */
  | { kind: 'blank' };

/** A card as laid out: its first row and rows (borders included) in the sidebar, and its body rows, in order. */
export interface CardLayout { card: SidebarCard; y: number; rows: number; lines: CardLine[] }

export interface SidebarCardsLayout extends SidebarCursor {
  cols: number;
  rows: number;
  /** The card the keys' cursor is in: the card of the box the keys move in. */
  cursorCard: SidebarCard;
  /** Whether the cursor is on its card's action button (the Projects or Agents card's; the Project card's cursor is always its button). */
  onButton: boolean;
  /** The cursor agent's button the cursor is on (its block's buttons row), or null on its row. */
  agentButton: AgentButton | null;
  /** Top to bottom; Projects is left out when there is no row for it (and the cursor is not in it). */
  cards: CardLayout[];
}

/** Rows of a card's top and bottom borders. */
const BORDERS = 2;
/** Blank rows between two cards (no card's: the canvas shows through). */
const CARD_GAP = 1;

/** Columns of an expanded block's text: the card's inner width less the block's borders and a column of padding inside each. */
const blockTextCols = (cols: number): number => Math.max(1, cols - BORDERS - 4);
/** The most rows an expanded block gives the activity or question. */
const BLOCK_DETAIL_LINES = 2;
/** An expanded block's row labels, muted, padded to one width so the values line up. */
const BLOCK_LABELS = { model: 'model', task: 'task', brief: 'brief', doing: 'doing', type: 'type', agent: 'agent' } as const;
/** A local session's note row in its expanded block. */
export const LOCAL_NOTE = 'not managed by the coordinator';
/** Before a local session's label: it is the cockpit's own, not the coordinator's. */
export const LOCAL_MARK = '◇';
const BLOCK_LABEL_COLS = Math.max(...Object.values(BLOCK_LABELS).map((label) => label.length)) + 2;
const blockLabel = (label: string): string => label.padEnd(BLOCK_LABEL_COLS);

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
  const repeats = [agent.task_ref, agent.brief, agent.role, agent.phase].some((other) => other != null && other.toLowerCase() === text.toLowerCase());
  return repeats ? null : text;
}

/**
 * Each agent's rows in a card `cols` wide: collapsed, its row and (when it
 * needs attention) its question or reason; expanded, its block. A question or
 * reason takes the block's full width; an activity wraps beside its label.
 */
function agentBlocks(model: SidebarModel, locals: readonly LocalAgent[], expanded: ReadonlySet<string>, cols: number): CardLine[][] {
  const count = model.agents.length;
  // A local session's block: its row, its provider, what it runs, the note and the buttons.
  const localBlocks = locals.map((session, offset): CardLine[] => {
    const index = count + offset;
    if (!expanded.has(localAgentKey(model.activeProjectId, session.tabId))) return [{ kind: 'agent', index }];
    const part = (name: BlockPart): CardLine => ({ kind: 'block', index, part: name });
    // The note wraps rather than cut in a narrow card.
    const note = blockDetail(LOCAL_NOTE, blockTextCols(cols)).map((text): CardLine => ({ kind: 'block', index, part: 'note', text }));
    return [part('top'), part('title'), part('model'), part('type'), ...note, part('buttons'), part('bottom')];
  });
  return [...coordinatorBlocks(model.agents, expanded, cols), ...localBlocks];
}

function coordinatorBlocks(agents: SidebarAgent[], expanded: ReadonlySet<string>, cols: number): CardLine[][] {
  return agents.map((agent, index): CardLine[] => {
    if (!expanded.has(agent.key)) return agent.attention ? [{ kind: 'agent', index }, { kind: 'detail', index }] : [{ kind: 'agent', index }];
    const part = (name: BlockPart, text?: string): CardLine => (text === undefined ? { kind: 'block', index, part: name } : { kind: 'block', index, part: name, text });
    const detail = blockDetailText(agent);
    const detailLines: CardLine[] = agent.attention
      ? blockDetail(detail, blockTextCols(cols)).map((text) => part('detail', text))
      : blockDetail(detail, Math.max(1, blockTextCols(cols) - BLOCK_LABEL_COLS))
        .map((text, line) => ({ kind: 'block', index, part: 'detail', text, label: line === 0 ? BLOCK_LABELS.doing : '' }));
    return [
      part('top'), part('title'), part('model'), ...(agent.task_ref ? [part('task')] : []), ...(agent.brief ? [part('brief')] : []),
      ...detailLines,
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

/** The Project card's rows above its button, in drawn order: coordinator, workers, tasks (with the status), the notice (while there is one). */
function projectInfoLines(model: SidebarModel): CardLine[] {
  const notice: CardLine[] = model.notice ? [{ kind: 'notice' }] : [];
  if (model.activeProjectId === null) return notice;
  return [{ kind: 'coordinator' }, { kind: 'workers' }, ...(model.tasks ? [{ kind: 'tasks' } as const] : []), ...notice];
}

/** `lines` cut to `body` rows: the coordinator row and the notice go last, in drawn order. */
function fitProjectLines(lines: CardLine[], body: number): CardLine[] {
  if (lines.length <= body) return lines;
  const order: CardLine['kind'][] = ['coordinator', 'notice', 'workers', 'tasks'];
  const kept = new Set([...lines].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, Math.max(0, body)));
  return lines.filter((line) => kept.has(line));
}

/**
 * A card's `body` rows: its list (`list`, given the rows it may take) on top
 * and its button (`button`, null for none) on the last row, blank rows
 * between; in one row only the button while the cursor is on it, else the list.
 */
function withButton(list: (rows: number) => CardLine[], button: CardLine | null, body: number, onButton: boolean): CardLine[] {
  if (body <= 0) return [];
  if (!button) return list(body);
  if (body === 1) return onButton ? [button] : list(1);
  const lines = list(body - 1);
  return [...lines, ...Array.from({ length: body - 1 - lines.length }, (): CardLine => ({ kind: 'blank' })), button];
}

/** A card's action buttons, each on its card's last body row. */
const BUTTON_KINDS: ReadonlySet<CardLine['kind']> = new Set(['addProject', 'newAgent', 'settings']);

/** The item a list row belongs to: an agent's rows (collapsed or expanded) are one item, every other row its own. */
function itemOf(line: CardLine, row: number): string {
  return line.kind === 'agent' || line.kind === 'detail' || line.kind === 'block' ? `agent:${line.index}` : `row:${row}`;
}

/**
 * A card's body (`lines`, as withButton lays it out: the list, blank rows, the button) padded and spaced in the blank
 * rows it has spare, only when its list is `complete` (every item shown, none behind `+N more`): first a blank row
 * between each two items (all of them or none, so a list never looks half-spaced), then one between the top border
 * and the first row, then one between the last row and the button. The rows stay the card's: padding and spacing only
 * take the blank rows a short list leaves, so they never make a card grow or push an item out of view.
 */
function padCard(lines: CardLine[], complete: boolean): CardLine[] {
  if (!complete) return lines;
  const last = lines.at(-1);
  const button = last !== undefined && BUTTON_KINDS.has(last.kind) ? last : null;
  const list = lines.filter((line) => line.kind !== 'blank' && line !== button);
  if (list.length === 0) return lines;
  const groups: CardLine[][] = [];
  let key: string | null = null;
  list.forEach((line, row) => {
    const item = itemOf(line, row);
    if (item !== key) groups.push([]);
    key = item;
    groups.at(-1)!.push(line);
  });
  const blank = (): CardLine => ({ kind: 'blank' });
  let spare = lines.length - list.length - (button ? 1 : 0);
  const spacing = groups.length - 1;
  const spaced = spacing > 0 && spare >= spacing;
  if (spaced) spare -= spacing;
  const top = spare >= 1;
  if (top) spare -= 1;
  const body = groups.flatMap((group, index) => (spaced && index > 0 ? [blank(), ...group] : group));
  return [...(top ? [blank()] : []), ...body, ...Array.from({ length: spare }, blank), ...(button ? [button] : [])];
}

/**
 * The Agents body in `body` rows from each agent's rows (`blocks`): every
 * agent when they fit, else a window that starts as high as the cursor's
 * agent allows (its whole block in view when it fits) and a `+N more` line for
 * the agents left out. With the cursor on the agent's buttons (`onButtons`) a
 * block taller than the window shows its rows down to its buttons row.
 */
function agentLines(blocks: CardLine[][], body: number, cursor: number, onButtons = false): CardLine[] {
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
  let lines = blocks.slice(start, end).flat().slice(0, room);
  const buttons = blocks[cursor].findIndex((line) => line.kind === 'block' && line.part === 'buttons');
  if (onButtons && buttons >= 0 && !lines.includes(blocks[cursor][buttons])) lines = blocks[cursor].slice(Math.max(0, buttons + 1 - room), buttons + 1);
  const hidden = blocks.length - (end - start);
  if (hidden > 0 && lines.length < body) lines.push({ kind: 'more', count: hidden });
  return lines;
}

/**
 * The cards in `rows` by `cols`, each with its button (when it has one) on
 * its last body row. The cards share the rows equally, the remainder to
 * Agents; Projects and the Project card never take more than their share.
 * When the Agents content (its rows, expanded blocks included, and its
 * button) needs more than its share, it takes the rows the other cards'
 * content leaves of their shares, then Projects shrinks (down to a window of
 * the cursor's project, else the active one, a `+N more` line and its button).
 * When rows run out the Agents card shrinks down to the cursor agent's row (an
 * expanded agent's whole block, and a `+N more` line when there are other
 * agents) and its button, then the Project card (down to one row and its
 * button), then Projects goes unless the cursor is in it. Rows the Agents
 * window leaves unused go back to a shrunk Project card, then to a shrunk
 * Projects, up to their shares. Each card's lines keep the cursor's row in
 * view. A blank row (no card's) separates two cards and counts in `rows`; a
 * sidebar too short for the gaps draws the cards border to border.
 */
export function sidebarCardsLayout(model: SidebarModel, rows: number, nav: SidebarNav, cols: number, locals: readonly LocalAgent[] = []): SidebarCardsLayout {
  const cursor = sidebarCursor(model, nav, locals);
  const keys = agentKeys(model, locals);
  const onButton = cursorOnButton(model, nav, keys.length);
  const agentButton = cursorAgentButton(nav, keys, cursor.agentIndex, onButton);
  const activeIndex = model.projects.findIndex((project) => project.active);
  // The Projects window follows the cursor while the keys are in it, else keeps the active project in view.
  const anchor = nav.box === 'projects' || activeIndex < 0 ? cursor.projectIndex : activeIndex;
  const infoLines = projectInfoLines(model);
  const settings: CardLine | null = model.activeProjectId === null ? null : { kind: 'settings' };
  const newAgent: CardLine | null = model.activeProjectId === null ? null : { kind: 'newAgent' };
  const buttonRows = (button: CardLine | null): number => (button ? 1 : 0);

  const projectsFull = BORDERS + Math.max(1, model.projects.length) + 1;
  // Projects keeps a project's row and, with more projects, the `+N more` line, and its button.
  const projectsMin = BORDERS + Math.min(2, Math.max(1, model.projects.length)) + 1;
  const projectFull = BORDERS + Math.max(1, infoLines.length + buttonRows(settings));
  // The Project card keeps its coordinator row and its button.
  const projectMin = BORDERS + Math.max(1, Math.min(infoLines.length, 1) + buttonRows(settings));
  const blocks = agentBlocks(model, locals, nav.expanded, cols);
  const agentsFull = BORDERS + Math.max(1, blocks.reduce((sum, block) => sum + block.length, 0)) + buttonRows(newAgent);
  // The Agents card's least: the cursor agent's row, or its expanded block, a `+N more` line for the other agents, and its button.
  const cursorKey = keys[cursor.agentIndex];
  const agentsMin = BORDERS + (cursorKey !== undefined && nav.expanded.has(cursorKey) ? blocks[cursor.agentIndex].length : 1)
    + (keys.length > 1 ? 1 : 0) + buttonRows(newAgent);

  const body = (cardRows: number) => Math.max(0, cardRows - BORDERS);
  const agentsLines = (agents: number) => withButton((room) => agentLines(blocks, room, cursor.agentIndex, agentButton !== null), newAgent, body(agents), onButton && nav.box === 'agents');
  const anyExpanded = keys.some((key) => nav.expanded.has(key));
  /** Each card's rows when the cards share `space` rows. */
  const size = (space: number): { projects: number; project: number; agents: number; projectShort: boolean } => {
    const share = Math.floor(space / 3);
    let projects = share;
    let project = share;
    // Agents needing more than its share first takes what the others' content leaves of theirs.
    let wanted = agentsFull - (space - 2 * share);
    const toContent = (cardRows: number, full: number): number => {
      const given = Math.max(0, Math.min(cardRows - full, wanted));
      wanted -= given;
      return cardRows - given;
    };
    projects = toContent(projects, projectsFull);
    project = toContent(project, projectFull);
    // A share below a card's least (a short sidebar) is raised to it; Projects goes below when Agents needs the rows.
    project = Math.max(project, projectMin);
    projects = Math.max(projects, projectsMin);
    if (projects + project + agentsFull > space) projects = Math.max(projectsMin, Math.min(projects, space - project - agentsFull));
    if (space - projects - project < agentsMin) project = Math.max(projectMin, space - projects - agentsMin);
    if (space - projects - project < agentsMin && nav.box !== 'projects') projects = 0;
    // A sidebar too short for every card: the top ones keep their rows, the rest are cut.
    projects = Math.max(0, Math.min(projects, space));
    project = Math.max(0, Math.min(project, space - projects));
    let agents = Math.max(0, space - projects - project);
    const unused = () => agentsLines(agents).filter((line) => line.kind === 'blank').length;
    // An expanded block can leave the Agents window well short of its card: a shrunk Project card takes those rows
    // back first, then a shrunk Projects, the reverse of the order they shrank in, up to their shares.
    if (anyExpanded && project < share) {
      const spare = Math.min(share - project, unused());
      if (spare > 0) { project += spare; agents -= spare; }
    }
    if (anyExpanded && projects > 0 && projects < share) {
      const spare = Math.min(share - projects, unused());
      if (spare > 0) { projects += spare; agents -= spare; }
    }
    return { projects, project, agents, projectShort: project < Math.min(projectFull, Math.max(share, projectMin)) };
  };

  // A blank row between cards, counted in the rows; a sidebar too short for them drops the gaps before the
  // Project card goes below its content (or its share), Projects goes or Agents is down to its least.
  const flush = size(rows);
  // Two gaps with Projects shown, one without it.
  const two = size(rows - CARD_GAP * 2);
  const one = two.projects > 0 ? null : size(rows - CARD_GAP);
  const gapped = one === null ? two : one.projects === 0 ? one : null;
  const keepGaps = gapped !== null && (gapped.projects > 0) === (flush.projects > 0) && !gapped.projectShort
    && (gapped.agents > agentsMin || gapped.agents >= Math.min(agentsFull, flush.agents));
  const { projects, project, agents } = keepGaps ? gapped : flush;
  const gap = keepGaps ? CARD_GAP : 0;

  // Padding and spacing only take the blank rows each card's sized body leaves: the sizing above never counts them.
  const count = (lines: CardLine[], kind: CardLine['kind']): number => lines.filter((line) => line.kind === kind).length;
  const cards: CardLayout[] = [];
  const addProject: CardLine = { kind: 'addProject' };
  if (projects > 0) {
    const lines = withButton((room) => projectsLines(model, room, anchor), addProject, body(projects), onButton && nav.box === 'projects');
    const complete = model.projects.length === 0 ? count(lines, 'noProjects') === 1 : count(lines, 'project') === model.projects.length;
    cards.push({ card: 'projects', y: 0, rows: projects, lines: padCard(lines, complete) });
  }
  const projectY = projects > 0 ? projects + gap : 0;
  const projectLines = withButton((room) => fitProjectLines(infoLines, room), settings, body(project), nav.box === 'project');
  const projectComplete = infoLines.length > 0 && projectLines.filter((line) => line.kind !== 'blank' && line.kind !== 'settings').length === infoLines.length;
  cards.push({ card: 'project', y: projectY, rows: project, lines: padCard(projectLines, projectComplete) });
  const agentRows = agentsLines(agents);
  const blockRows = blocks.reduce((sum, block) => sum + block.length, 0);
  const agentsComplete = count(agentRows, 'more') === 0
    && agentRows.filter((line) => line.kind !== 'blank' && line.kind !== 'newAgent' && line.kind !== 'empty').length === blockRows
    && (blocks.length > 0 || count(agentRows, 'empty') === 1);
  cards.push({ card: 'agents', y: projectY + project + gap, rows: agents, lines: padCard(agentRows, agentsComplete) });
  return { ...cursor, cols, rows, cursorCard: nav.box, onButton, agentButton, cards };
}

/** A card's action button, on its last body row. */
export type CardButton = 'addProject' | 'newAgent';

/**
 * What a click hits: a project's or an agent's row, whether it hit the agent
 * row's collapse marker, and (set only then) the Project card's settings
 * button, the Projects or Agents card's button (`action`; its index -1) or an
 * expanded agent's button.
 */
export interface SidebarCardTarget {
  card: SidebarCard; index: number; onMarker: boolean; settings?: true; action?: CardButton; button?: AgentButton;
  /** An expanded block's row other than its title row (off its buttons): not the agent's own row. */
  inBlock?: true;
}

/** The Project card's settings button, as drawn. */
export const SETTINGS_BUTTON = '[ SETTINGS ]';
/** The Projects and Agents cards' buttons, as drawn (in the settings button's style). */
export const CARD_BUTTONS: Readonly<Record<CardButton, string>> = { addProject: '[ + ADD PROJECT ]', newAgent: '[ + NEW AGENT ]' };
/** An expanded agent's buttons as drawn, one column apart. */
export const AGENT_BUTTONS: ReadonlyArray<{ button: AgentButton; label: string }> = [{ button: 'open', label: '[ OPEN ]' }, { button: 'kill', label: '[ KILL ]' }];
const AGENT_BUTTON_GAP = 1;
/** Before the focused agent button, in the column left of it. */
export const FOCUS_MARK = '▸';
/** Before the active project's name on its Projects row. */
const ACTIVE_MARK = '▸ ';

/** Columns of padding inside each side border. */
const PAD = 1;
/** Columns of the collapse marker, which starts after the left border and its padding. */
const MARKER_COLS = stringWidth(collapseMarker(false));
/** The marker's first column on an expanded block's title row: after the card's border, the block's side and a space. */
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
  // A card button is hit on its label's columns only.
  const onLabel = (label: string): boolean => x >= 1 + PAD && x < 1 + PAD + Math.min(stringWidth(label), layout.cols - 2 - 2 * PAD);
  switch (line?.kind) {
    case 'coordinator':
    case 'workers':
    case 'tasks':
      return active >= 0 ? { card: 'project', index: active, onMarker: false } : null;
    case 'settings':
      return active >= 0 && onLabel(SETTINGS_BUTTON) ? { card: 'project', index: active, onMarker: false, settings: true } : null;
    case 'addProject': return onLabel(CARD_BUTTONS.addProject) ? { card: 'projects', index: -1, onMarker: false, action: 'addProject' } : null;
    case 'newAgent': return onLabel(CARD_BUTTONS.newAgent) ? { card: 'agents', index: -1, onMarker: false, action: 'newAgent' } : null;
    case 'project': return { card: 'projects', index: line.index, onMarker: false };
    case 'agent': return { card: 'agents', index: line.index, onMarker: x >= 1 + PAD && x < 1 + PAD + MARKER_COLS };
    case 'detail': return { card: 'agents', index: line.index, onMarker: false };
    case 'block': {
      if (line.part === 'buttons') {
        const hit = agentButtonSpans(BLOCK_TEXT_X, layout.cols - 2 - 4).find((span) => x >= span.x && x < span.x + span.cols);
        if (hit) return { card: 'agents', index: line.index, onMarker: false, button: hit.button };
      }
      if (line.part !== 'title') return { card: 'agents', index: line.index, onMarker: false, inBlock: true };
      return { card: 'agents', index: line.index, onMarker: x >= BLOCK_MARKER_X && x < BLOCK_MARKER_X + MARKER_COLS };
    }
    default: return null;
  }
}

/**
 * A click at (x, y) in the sidebar: the row's box gets the cursor and its
 * project opens, on the settings button the active project's settings open, on
 * the add-project or new-agent button the app is asked for it (the cursor goes
 * to the button), on an expanded agent's `[ OPEN ]` its tab opens and on its
 * `[ KILL ]` the app is asked to kill it (the cursor goes to the button), on an
 * agent's row (a collapsed agent's rows, its marker included, or an expanded
 * block's title row) the agent expands or collapses, and on the rest of an
 * expanded block the cursor goes to the agent (neither with a command).
 * Null off the rows.
 */
export function sidebarCardClick(layout: SidebarCardsLayout, nav: SidebarNav, x: number, y: number): SidebarStep | null {
  const target = sidebarCardTarget(layout, x, y);
  if (!target) return null;
  if (target.settings) return openSettingsStep(nav, layout.model);
  if (target.action) return buttonStep(nav, layout.model, target.action === 'addProject' ? 'projects' : 'agents');
  if (target.card !== 'agents') return openProjectStep(nav, layout.model, target.index);
  if (target.button === 'open') return openAgentStep(nav, layout, target.index);
  if (target.button === 'kill') return killAgentStep(nav, layout, target.index, 'kill');
  const key = agentKeys(layout.model, layout.locals)[target.index];
  return { nav: target.inBlock ? onAgent(nav, key) : toggleAgent(nav, key), command: null };
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
  const { model, locals } = layout;
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
    const count = card.card === 'projects' ? model.projects.length > 0 ? String(model.projects.length) : ''
      : card.card === 'agents' ? agentsMeta() : '';
    const inner = drawBox(frame, { x: region.x, y: region.y + card.y, cols: region.cols, rows: card.rows }, { title, meta: count, focused, theme });
    // A cut card draws a full box whose lower part the next card or the frame's edge covers: only the rows in the region get body text.
    // One column of padding inside each border; the cursor row's bar spans it too.
    card.lines.slice(0, Math.min(inner.rows, rows - 1)).forEach((line, offset) => {
      const cursor = focused && isCursorLine(layout, line);
      if (cursor) fillRect(frame, { x: inner.x, y: inner.y + offset, cols: inner.cols, rows: 1 }, { ...role('text.primary'), ...theme.roles['row.cursor'] });
      // An expanded block's border takes the padding columns: it spans the card's inner width.
      // The focused agent button gets a marker (only while the sidebar has the keys, like the cursor bar).
      const focusButton = focused && line.kind === 'block' && line.part === 'buttons' && line.index === layout.agentIndex ? layout.agentButton : null;
      if (line.kind === 'block') drawBlockLine(frame, inner.x, inner.y + offset, inner.cols, line, cursor, focusButton);
      else drawLine(frame, inner.x + PAD, inner.y + offset, inner.cols - 2 * PAD, line, cursor);
    });
  }

  /** The Agents card's count: the coordinator's agents (`2 live`, or `stale`), then the local sessions (`1 local`), not counted with them. */
  function agentsMeta(): string {
    const parts = [
      ...(model.agents.length > 0 ? [`${model.agents.length} ${model.agentsStale ? 'stale' : 'live'}`] : []),
      ...(locals.length > 0 ? [`${locals.length} local`] : []),
    ];
    return parts.join(' · ');
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
      case 'addProject':
      case 'newAgent':
        drawCardRow(frame, x, y, cols, { left: line.kind === 'settings' ? SETTINGS_BUTTON : CARD_BUTTONS[line.kind], leftRuns: (shown) => [[shown, role('button'), true]], cursor }, theme);
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
      case 'agent': {
        const entry = agentEntry(layout, line.index);
        drawCardRow(frame, x, y, cols, entry.local ? localRow(entry.session, false, cursor) : agentRow(entry.agent, false, cursor), theme);
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
      case 'block':
      case 'blank':
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

  /** A local session's row: marker, a muted `◇` and its label left, its run time (when known) and `[LOCAL]` or `[ENDED]` flush right. */
  function localRow(session: LocalAgent, expanded: boolean, cursor: boolean): CardRow {
    const prefix = `${collapseMarker(expanded)} ${LOCAL_MARK} `;
    return {
      left: `${prefix}${session.label}`,
      leftRuns: (shown) => {
        const head = shown.startsWith(prefix) ? prefix : shown;
        const rest = shown.slice(head.length);
        return [[head, role('text.muted')], ...(rest ? [[rest, role('text.accent')] as Run] : [])];
      },
      before: session.elapsed ? [[`${session.elapsed} `, role('text.muted')]] : [],
      badge: { label: session.alive ? 'local' : 'ended', role: localStatusRole(session) },
      cursor,
    };
  }

  /**
   * One row of a local session's expanded block, `cols` wide: the border in
   * its status role, its row inside the box below its top border, its provider with the CLI's
   * default model, `type fresh session` or `agent <name>`, the note (muted)
   * and the buttons.
   */
  function drawLocalBlockLine(frame: Frame, x: number, y: number, cols: number, line: Extract<CardLine, { kind: 'block' }>, session: LocalAgent, cursor: boolean, focusButton: AgentButton | null): void {
    const border = role(localStatusRole(session));
    if (drawBlockBorder(frame, x, y, cols, line.part, border)) return;
    const textCols = cols - 4;
    if (textCols <= 0) return;
    if (line.part === 'title') {
      drawCardRow(frame, x + 2, y, textCols, localRow(session, true, cursor), theme);
      return;
    }
    const muted = role('text.muted');
    const primary = role('text.primary');
    if (line.part === 'buttons') {
      drawAgentButtons(frame, x + 2, y, textCols, focusButton, (style) => style);
      return;
    }
    const labelled = (label: string, value: Run[]): Run[] => cutRuns([[blockLabel(label), muted], ...value], textCols);
    const custom = session.variant === 'custom' && session.agentName;
    const runs: Run[] = line.part === 'model'
      ? labelled(BLOCK_LABELS.model, [[session.provider, primary], [' · ', muted], ['default', primary]])
      : line.part === 'type' ? custom ? labelled(BLOCK_LABELS.agent, [[session.agentName ?? '', primary]]) : labelled(BLOCK_LABELS.type, [['fresh session', primary]])
      : [[fitText(line.text ?? '', textCols), muted]];
    drawRuns(frame, x + 2, y, runs, textCols);
  }

  /**
   * One row of an expanded agent's block, `cols` wide: the border in the
   * agent's status role (dim on a stale list), the agent's row inside the box below the top
   * border, then its labelled rows (label in `text.muted`, value in
   * `text.primary`): provider and model (`default` for an unknown model),
   * task or brief, activity; or its question (in the attention kind's role);
   * and its buttons (`[ OPEN ]` in `tab.active`, `[ KILL ]` in
   * `button.danger`), each cut by display width.
   */
  function drawBlockLine(frame: Frame, x: number, y: number, cols: number, line: Extract<CardLine, { kind: 'block' }>, cursor: boolean, focusButton: AgentButton | null): void {
    if (cols < 4) return;
    const entry = agentEntry(layout, line.index);
    if (entry.local) {
      drawLocalBlockLine(frame, x, y, cols, line, entry.session, cursor, focusButton);
      return;
    }
    const { agent } = entry;
    const stale = model.agentsStale;
    const styled = (style: CellStyle): CellStyle => (stale ? { ...style, dim: true } : style);
    const border = styled(role(agentStatusRole(agent)));
    if (drawBlockBorder(frame, x, y, cols, line.part, border)) return;
    const textCols = cols - 4;
    if (textCols <= 0) return;
    if (line.part === 'title') {
      drawCardRow(frame, x + 2, y, textCols, agentRow(agent, true, cursor), theme);
      return;
    }
    const muted = styled(role('text.muted'));
    const primary = styled(role('text.primary'));
    if (line.part === 'buttons') {
      drawAgentButtons(frame, x + 2, y, textCols, focusButton, styled);
      return;
    }
    const labelled = (label: string, value: Run[]): Run[] => cutRuns([[blockLabel(label), muted], ...value], textCols);
    const runs: Run[] = line.part === 'model'
      ? labelled(BLOCK_LABELS.model, [[agent.provider ?? '-', primary], [' · ', muted], [agent.model ?? 'default', primary]])
      : line.part === 'task' ? labelled(BLOCK_LABELS.task, [[agent.task_ref ?? '', primary]])
      : line.part === 'brief' ? labelled(BLOCK_LABELS.brief, [[agent.brief ?? '', primary]])
      : line.label !== undefined ? labelled(line.label, [[line.text ?? '', primary]])
      : [[fitText(line.text ?? '', textCols), styled(role(agent.attention ? attentionRole(agent.attention) : 'text.muted'))]];
    drawRuns(frame, x + 2, y, runs, textCols);
  }

  /**
   * An expanded block's border on its row: the whole `┌─┐` or `└─┘` line on its top or bottom row (true: nothing else
   * goes there), else its `│` sides, in `border`.
   */
  function drawBlockBorder(frame: Frame, x: number, y: number, cols: number, part: BlockPart, border: CellStyle): boolean {
    if (part === 'top' || part === 'bottom') {
      drawText(frame, x, y, part === 'top' ? `┌${'─'.repeat(cols - 2)}┐` : `└${'─'.repeat(cols - 2)}┘`, border, cols);
      return true;
    }
    drawText(frame, x, y, '│', border, 1);
    drawText(frame, x + cols - 1, y, '│', border, 1);
    return false;
  }

  /**
   * An expanded block's buttons from `x`, `textCols` columns: `[ OPEN ]` in
   * `tab.active`, `[ KILL ]` in `button.danger`, each through `styled` (a stale
   * list's dim); the focused one (`focus`) bold, with a `▸` (`text.accent`) in
   * the column before it, as the confirm dialog marks its focused button.
   */
  function drawAgentButtons(frame: Frame, x: number, y: number, textCols: number, focus: AgentButton | null, styled: (style: CellStyle) => CellStyle): void {
    for (const span of agentButtonSpans(x, textCols)) {
      const style = styled(role(span.button === 'kill' ? 'button.danger' : 'tab.active'));
      if (span.button === focus) drawText(frame, span.x - 1, y, FOCUS_MARK, styled(role('text.accent')), 1);
      drawText(frame, span.x, y, span.label, span.button === focus ? { ...style, bold: true } : style, span.cols);
    }
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

/** A local session's status role: `status.local` while its session runs, `status.idle` once it ended. */
export function localStatusRole(session: LocalAgent): StatusRole {
  return session.alive ? 'status.local' : 'status.idle';
}

/**
 * Whether `line` is the keys' cursor row (the caller checks its card is the focused one); an expanded agent's is its
 * block's title row, none while the cursor is on its buttons (drawn with a marker instead).
 */
function isCursorLine(layout: SidebarCardsLayout, line: CardLine): boolean {
  switch (line.kind) {
    case 'settings': return true;
    case 'addProject':
    case 'newAgent': return layout.onButton;
    case 'project': return !layout.onButton && line.index === layout.projectIndex;
    case 'agent': return !layout.onButton && line.index === layout.agentIndex;
    case 'block': return !layout.onButton && layout.agentButton === null && line.part === 'title' && line.index === layout.agentIndex;
    default: return false;
  }
}
