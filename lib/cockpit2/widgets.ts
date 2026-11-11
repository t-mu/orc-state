/**
 * lib/cockpit2/widgets.ts — the header, the sidebar, the tab bar and the footer drawn as cells (Plan 6 Step 9).
 *
 * The sidebar and the tab bar come from the pure view models the Ink cockpit
 * uses: the sidebar from lib/tui/sidebar.ts (status box, projects box, agents
 * box), the tab bar from lib/tui/tabBarModel.ts (three rows of square-bordered tabs).
 * The header is the cockpit's top row: the orc mark, the active project, the
 * explorer and attention buttons. The footer is its last row: the mode,
 * where you are, the keys.
 * Text is fitted by display width (lib/cellWidth.ts), so wide-character names
 * take their two columns and are never split.
 *
 * The focused region has a visible marker that does not rely on colour: the
 * focused sidebar box has its title reversed and its cursor row reversed; with
 * the slot focused the active tab's label is reversed. Colour
 * comes on top, from the theme's roles (lib/cockpit2/theme.ts).
 *
 * Sidebar navigation (`navigateSidebar`) and clicks (`sidebarClick`, plus
 * `tabBarClickTarget` from the model) are pure: they return the new cursor and
 * a command the app runs. Everything here is pure; nothing touches a session.
 */
import { stringWidth } from '../cellWidth.ts';
import {
  BOX_CHROME, agentBodyLines, agentRowParts, computeSidebarLayout, fitRow, fitText, projectBodyLines, sidebarRowTarget, statusLines,
  type SidebarLayout, type SidebarModel,
} from '../tui/sidebar.ts';
import { layoutTabBar, tabBarRows, type TabBarLayout, type TabBarModel, type TabBarSegment } from '../tui/tabBarModel.ts';
import type { SidebarKey } from './dispatch.ts';
import { drawText, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { attentionRole, badgeRole, projectStateRole, styleOf, type Theme, type ThemeRole } from './theme.ts';

// ── styles ───────────────────────────────────────────────────────────────────

/** A role's style with `over` on top: an attribute a widget adds to a role (the focused active tab's inverse). */
const roleWith = (theme: Theme, role: ThemeRole, over: Partial<CellStyle> = {}): CellStyle => ({ ...styleOf(theme, role), ...over });

/** The mark before an agent tab's name in typing mode, and in view mode. */
export const TYPING_MARK = '✎';
export const VIEW_MARK = '○';

/** Text in one style; `status` marks a run whose colours carry a state (a badge, a project state), which the cursor row keeps. */
type Run = readonly [text: string, style: CellStyle, status?: boolean];

/** Draws runs left to right from (x, y), at most `maxCols` columns in all; returns the columns drawn. */
function drawRuns(frame: Frame, x: number, y: number, runs: readonly Run[], maxCols: number): number {
  let col = 0;
  for (const [text, runStyle] of runs) {
    if (col >= maxCols) break;
    col += drawText(frame, x + col, y, text, runStyle, maxCols - col);
  }
  return col;
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

// ── sidebar ──────────────────────────────────────────────────────────────────

export type SidebarBox = 'projects' | 'agents';

/** The sidebar's cursor: the box the keys move in and the selected project and agent (by key, so a reorder keeps them). */
export interface SidebarNav {
  box: SidebarBox;
  projectKey: string | null;
  agentKey: string | null;
}

export const INITIAL_SIDEBAR_NAV: SidebarNav = Object.freeze({ box: 'agents', projectKey: null, agentKey: null });

/** The sidebar as it is drawn: the model, what fits, and the cursor rows. */
export interface SidebarView {
  model: SidebarModel;
  layout: SidebarLayout;
  /** Index into `model.projects` / `model.agents` of the cursor (0 for an empty list). */
  projectIndex: number;
  agentIndex: number;
}

function indexOfKey(keys: string[], key: string | null, fallback: number): number {
  const index = key == null ? -1 : keys.indexOf(key);
  return index >= 0 ? index : Math.max(0, Math.min(fallback, keys.length - 1));
}

/** What of `model` fits `rows` rows, the cursor kept in view. */
export function sidebarView(model: SidebarModel, rows: number, nav: SidebarNav): SidebarView {
  const projectIndex = indexOfKey(model.projects.map((project) => project.project_id), nav.projectKey ?? model.activeProjectId, 0);
  const agentIndex = indexOfKey(model.agents.map((agent) => agent.key), nav.agentKey, 0);
  // computeSidebarLayout keeps a last row for the Ink sidebar's footer; the cockpit's footer is its own region, so the boxes get that row.
  return { model, layout: computeSidebarLayout(model, rows + 1, { project: projectIndex, agent: agentIndex }), projectIndex, agentIndex };
}

/** What a sidebar key or click asks the app to do. */
export type SidebarCommand =
  | { type: 'openProject'; projectId: string }
  | { type: 'openAgent'; projectId: string; agentId: string }
  | { type: 'focusSlot' };

export interface SidebarStep { nav: SidebarNav; command: SidebarCommand | null }

/**
 * A navigation key: up and down move the cursor in the focused box (stopping
 * at either end), switchBox moves between the projects and agents boxes, open
 * opens the project or agent under the cursor, back returns to the pane.
 */
export function navigateSidebar(view: SidebarView, nav: SidebarNav, key: SidebarKey): SidebarStep {
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

/** A click on sidebar row `y` (relative to the sidebar): the row's box gets the cursor and its project or agent opens. Null off the rows. */
export function sidebarClick(view: SidebarView, nav: SidebarNav, y: number): SidebarStep | null {
  const target = sidebarRowTarget(view.model, view.layout, y);
  if (!target) return null;
  return target.kind === 'project' ? openProjectStep(nav, view.model, target.index) : openAgentStep(nav, view.model, target.index);
}

export interface SidebarDrawOptions {
  /** The sidebar box with the keys, or null while the slot has them. */
  focus: SidebarBox | null;
  /** The styles the sidebar is drawn in. */
  theme: Theme;
}

/**
 * Draws the sidebar into `region`: the status box, the projects box and the
 * agents box (each sized by the layout).
 */
export function drawSidebar(frame: Frame, region: Region, view: SidebarView, options: SidebarDrawOptions): void {
  if (region.cols < 4 || region.rows < 1) return;
  const { model, layout } = view;
  const { theme } = options;
  const role = (name: ThemeRole) => styleOf(theme, name);
  const PLAIN = role('text.primary');
  const MUTED = role('text.muted');
  // A count of agents needing a human: an attention badge.
  const COUNT = role(badgeRole('status.attention'));
  const width = region.cols;
  const inner = width - 2;
  const bottom = region.y + region.rows;
  // Rows below the region never hold a box: a terminal too short for the boxes cuts them.
  const line = (y: number, runs: readonly Run[], x = region.x + 1, cols = inner) => {
    if (y < bottom) drawRuns(frame, x, y, runs, cols);
  };
  const box = (top: number, body: number, title: string, focused: boolean): number => {
    const border = role(focused ? 'chrome.borderFocus' : 'chrome.border');
    const label = fitText(title, Math.max(0, width - 6));
    const labelWidth = stringWidth(label);
    line(top, [['╭─ ', border], [label, role(focused ? 'chrome.titleFocus' : 'chrome.title')], [` ${'─'.repeat(Math.max(0, width - labelWidth - 5))}╮`, border]], region.x, width);
    for (let y = top + 1; y <= top + body; y += 1) {
      line(y, [['│', border]], region.x, 1);
      line(y, [['│', border]], region.x + width - 1, 1);
    }
    line(top + body + 1, [[`╰${'─'.repeat(inner)}╯`, border]], region.x, width);
    return top + 1;
  };

  // Status: the active project's coordinator and workers, how many agents need a human, and a notice.
  const { coordinator, workers, attention } = model.status;
  let y = box(region.y, statusLines(model), 'Status', false);
  line(y, [['coordinator ', PLAIN], coordinator ? [coordinator, role(projectStateRole(coordinator))] : ['-', MUTED]]);
  const need = attention > 0 ? `${attention} need${attention === 1 ? 's' : ''} you` : '';
  const counts = fitRow(`workers ${workers ? `${workers.used}/${workers.total}` : '-'}`, need, inner);
  line(y + 1, [[counts.left, PLAIN], [counts.gap, PLAIN], [counts.right, COUNT, true]]);
  if (model.notice) line(y + 2, [[model.notice, role('status.warn')]]);

  // Projects: `▸` marks the active one; its state and, when its agents need a human, `!N`.
  const projectsTop = region.y + BOX_CHROME + statusLines(model);
  const projectBody = projectBodyLines(model, layout);
  y = box(projectsTop, projectBody, 'Projects', options.focus === 'projects');
  if (model.projects.length === 0) line(y, [['(none)', MUTED]]);
  for (let offset = 0; offset < layout.projectCount; offset += 1) {
    const index = layout.projectStart + offset;
    const project = model.projects[index];
    const badge = project.attention > 0 ? ` !${project.attention}` : '';
    const row = fitRow(project.name, `${project.state}${badge}`, inner - 2);
    const right: Run[] = row.right === `${project.state}${badge}`
      ? [[project.state, role(projectStateRole(project.state)), true], [badge, COUNT, true]]
      : [[row.right, PLAIN]];
    const runs: Run[] = [[`${project.active ? '▸ ' : '  '}${row.left}`, project.active ? role('text.accent') : PLAIN], [row.gap, PLAIN], ...right];
    const cursor = options.focus === 'projects' && index === view.projectIndex;
    line(y + offset, cursor ? cursorRow(runs, theme) : runs);
  }
  const hiddenProjects = model.projects.length - layout.projectCount;
  if (hiddenProjects > 0) line(y + Math.max(1, layout.projectCount), [[`+${hiddenProjects} more`, MUTED]]);

  // Agents: two rows each: name, phase (or attention badge) and run time; then activity, question or reason.
  const active = model.projects.find((project) => project.active) ?? null;
  const agentsTop = projectsTop + BOX_CHROME + projectBody;
  y = box(agentsTop, agentBodyLines(model, layout), active ? `Agents · ${active.name}` : 'Agents', options.focus === 'agents');
  if (model.agents.length === 0) {
    line(y, [[active?.state === 'stopped' && !model.agentsStale ? '(coordinator not running)' : '(no live agents)', MUTED]]);
  }
  layout.agents.forEach((index, offset) => {
    const agent = model.agents[index];
    const parts = agentRowParts(agent, inner);
    const cursor = options.focus === 'agents' && index === view.agentIndex;
    const tag: Run = agent.attention
      ? [parts.tag, role(badgeRole(attentionRole(agent.attention))), true]
      : [parts.tag, cursor ? PLAIN : MUTED];
    let first: Run[] = [[parts.name, role('text.accent')], [parts.gap, PLAIN], tag, [parts.elapsed, cursor ? PLAIN : MUTED]];
    if (cursor) first = cursorRow(first, theme);
    else if (model.agentsStale) first = withStyle(first, { dim: true });
    const detailStyle = agent.attention ? role(attentionRole(agent.attention)) : MUTED;
    line(y + 2 * offset, first);
    line(y + 2 * offset + 1, [[`  ${agent.detail ?? ''}`, detailStyle]]);
  });
  const hiddenAgents = model.agents.length - layout.agents.length;
  if (hiddenAgents > 0) line(y + 2 * layout.agents.length, [[`+${hiddenAgents} more`, MUTED]]);
}

// ── header ───────────────────────────────────────────────────────────────────

/** A clickable entry flush right in the header: the task explorer, or the count of agents needing attention. */
export interface HeaderButton { action: 'explorer' | 'attention'; text: string }
/** A button as placed: `x` is its first column in the header. */
export interface PlacedHeaderButton extends HeaderButton { x: number }

/** The header as it is drawn: the active project's name as it fits (null with none open) and the buttons that fit, flush right. */
export interface HeaderView { project: string | null; buttons: PlacedHeaderButton[] }

/** The orc mark, first in the header. */
export const HEADER_MARK = 'ORC';
const HEADER_SEPARATOR = ' │ ';
/** The project name is cut down to this many columns (or its own width) before a button is dropped. */
const MIN_HEADER_NAME_COLS = 6;

/**
 * Lays the header out in `cols`: the orc mark, a separator and the project's
 * name on the left, the `buttons` flush right, each after a space. A narrow
 * header cuts the name first (down to 6 columns), then drops buttons, the
 * first given first.
 */
export function headerView(cols: number, projectName: string | null, buttons: readonly HeaderButton[]): HeaderView {
  const left = stringWidth(HEADER_MARK) + (projectName === null ? 0 : stringWidth(HEADER_SEPARATOR) + Math.min(stringWidth(projectName), MIN_HEADER_NAME_COLS));
  const width = (list: readonly HeaderButton[]) => list.reduce((sum, button) => sum + stringWidth(button.text) + 1, 0);
  let kept = buttons;
  while (kept.length > 0 && left + width(kept) > cols) kept = kept.slice(1);
  const reserve = width(kept);
  let x = cols - reserve + 1;
  const placed = kept.map((button) => {
    const at = { ...button, x };
    x += stringWidth(button.text) + 1;
    return at;
  });
  const nameCols = cols - reserve - stringWidth(HEADER_MARK) - stringWidth(HEADER_SEPARATOR);
  return { project: projectName === null ? null : fitText(projectName, Math.max(0, nameCols)), buttons: placed };
}

/** The header button at column `x`, or null. */
export function headerButtonAt(view: HeaderView, x: number): HeaderButton['action'] | null {
  return view.buttons.find((button) => x >= button.x && x < button.x + stringWidth(button.text))?.action ?? null;
}

/** Draws the header into `region`'s first row: the mark (`text.accent`), the project's name (`text.primary`) and the buttons. */
export function drawHeader(frame: Frame, region: Region, view: HeaderView, theme: Theme): void {
  if (region.cols <= 0 || region.rows <= 0) return;
  const runs: Run[] = [[HEADER_MARK, styleOf(theme, 'text.accent')]];
  if (view.project) runs.push([HEADER_SEPARATOR, styleOf(theme, 'text.muted')], [view.project, styleOf(theme, 'text.primary')]);
  drawRuns(frame, region.x, region.y, runs, region.cols);
  for (const button of view.buttons) {
    const width = stringWidth(button.text);
    drawText(frame, region.x + button.x, region.y, button.text, styleOf(theme, button.action === 'attention' ? 'button.attention' : 'button'), width);
  }
}

// ── tab bar ──────────────────────────────────────────────────────────────────

/** The tab bar as it is drawn: the model and which tabs fit. */
export interface TabBarView { model: TabBarModel; layout: TabBarLayout }

/** The explorer tab's id in the tab bar model: not an agent id (agent ids hold no control characters). */
export const EXPLORER_TAB = '\u0000tasks';
export const EXPLORER_LABEL = 'tasks';

/** Agent tabs labelled with their mode's mark (`○` view, `✎` typing); the master tab, always typing, has none. */
export function withModeMarks(model: TabBarModel, typing: (agentId: string) => boolean): TabBarModel {
  return {
    ...model,
    tabs: model.tabs.map((tab) => (tab.agentId === null ? tab : { ...tab, label: `${typing(tab.agentId) ? TYPING_MARK : VIEW_MARK} ${tab.label}` })),
  };
}

/** The task explorer shown as the active tab after the project's tabs, closable; the project's tabs are inactive while it is shown. */
export function withExplorerTab(model: TabBarModel): TabBarModel {
  if (model.notice) return model;
  const tabs = model.tabs.map((tab) => ({ ...tab, active: false }));
  return { ...model, tabs: [...tabs, { agentId: EXPLORER_TAB, number: tabs.length + 1, label: EXPLORER_LABEL, active: true, attention: null, closable: true }] };
}

/** Lays the tabs out in the bar's full width: tabs that do not fit go behind the overflow markers. */
export function tabBarView(model: TabBarModel, cols: number): TabBarView {
  return { model, layout: layoutTabBar(model, cols) };
}

export interface TabBarDrawOptions {
  /** The slot has the keys: the active tab is the focus marker. */
  slotFocused: boolean;
  /** What the last action reported, or a failed save; takes the bottom row. */
  error: string | null;
  /** The styles the tab bar is drawn in. */
  theme: Theme;
}

function segmentStyle(segment: TabBarSegment, model: TabBarModel, slotFocused: boolean, theme: Theme): CellStyle {
  const tab = segment.tab === undefined ? null : model.tabs[segment.tab];
  const focused = Boolean(tab?.active && slotFocused);
  switch (segment.kind) {
    case 'border': return styleOf(theme, focused ? 'chrome.borderFocus' : 'chrome.border');
    case 'text': return tab?.active ? roleWith(theme, 'text.accent', { inverse: focused }) : styleOf(theme, 'text.primary');
    case 'badge': return styleOf(theme, badgeRole(tab?.attention ? attentionRole(tab.attention) : 'status.attention'));
    case 'close': return styleOf(theme, 'tab.close');
    case 'error': return styleOf(theme, 'error');
    case 'rule': return styleOf(theme, 'chrome.border');
    case 'marker': case 'notice': return styleOf(theme, 'text.muted');
  }
}

/**
 * Draws the tab bar into `region`: the tabs' top borders, their labels, and
 * the rule above the slot (open under the active tab). A region shorter than
 * three rows keeps the labels' row (then the bottom row).
 */
export function drawTabBar(frame: Frame, region: Region, view: TabBarView, options: TabBarDrawOptions): void {
  if (region.cols <= 0 || region.rows <= 0) return;
  const { model, layout } = view;
  const [top, middle, bottom] = tabBarRows(model, layout, region.cols, options.error);
  const rows = region.rows >= 3 ? [top, middle, bottom] : region.rows === 2 ? [middle, bottom] : [middle];
  rows.forEach((segments, offset) => {
    drawRuns(frame, region.x, region.y + offset, segments.map((segment): Run => [segment.text, segmentStyle(segment, model, options.slotFocused, options.theme)]), region.cols);
  });
}

// ── footer ───────────────────────────────────────────────────────────────────

/** A key hint in the footer: `key` (a key label, e.g. `Ctrl-q` or `F12 d`) and what it does. */
export interface FooterHint { key: string; action: string }

export interface FooterDrawOptions {
  /** The focus or the shown tab's mode and its keys (dispatch.ts `modeNotice`). */
  mode: string;
  /** Where the keys go: the active project's name and the shown tab's label; null with no project open. */
  breadcrumb: { project: string; tab: string } | null;
  /** The cockpit keys, from the resolved keys. */
  hints: readonly FooterHint[];
  theme: Theme;
}

const FOOTER_SEPARATOR = ' · ';
/** A breadcrumb cut to fit is kept while it has at least this many columns. */
const MIN_FOOTER_CRUMB_COLS = 8;

/** Runs cut to `cols` display columns in all (the last one shown ends in `…`). */
function fitRuns(runs: readonly Run[], cols: number): Run[] {
  const out: Run[] = [];
  let left = cols;
  for (const [text, runStyle] of runs) {
    if (left <= 0) break;
    const width = stringWidth(text);
    if (width <= left) { out.push([text, runStyle]); left -= width; continue; }
    out.push([fitText(text, left), runStyle]);
    break;
  }
  return out;
}

/**
 * Draws the footer into `region`'s first row: the mode, then `project › tab`,
 * then the key hints, separated by ` · `. Hints that do not fit are left out
 * from the right, except the first (quit), which is kept before the
 * breadcrumb: a breadcrumb too long is cut by display width (dropped below
 * 8 columns). The mode is cut (never dropped) last.
 */
export function drawFooter(frame: Frame, region: Region, options: FooterDrawOptions): void {
  if (region.cols <= 0 || region.rows <= 0) return;
  const { theme } = options;
  const role = (name: ThemeRole) => styleOf(theme, name);
  const muted = role('text.muted');
  const accent = role('text.accent');
  const sep = stringWidth(FOOTER_SEPARATOR);
  const widthOf = (runs: readonly Run[]) => runs.reduce((sum, [text]) => sum + stringWidth(text), 0);
  const hints = options.hints.map((hint): Run[] => [[hint.key, accent], [`: ${hint.action}`, muted]]);
  let crumb: Run[] = options.breadcrumb
    ? [[options.breadcrumb.project, role('text.primary')], [' › ', muted], [options.breadcrumb.tab, role('text.primary')]]
    : [];
  let room = region.cols - stringWidth(options.mode);
  // The quit hint first: what it leaves is the breadcrumb's, then the other hints'.
  const kept: Run[][] = [];
  if (hints.length > 0 && sep + widthOf(hints[0]) <= room) {
    kept.push(hints[0]);
    room -= sep + widthOf(hints[0]);
  }
  if (crumb.length > 0) {
    const crumbCols = Math.min(widthOf(crumb), room - sep);
    crumb = crumbCols >= Math.min(widthOf(crumb), MIN_FOOTER_CRUMB_COLS) ? fitRuns(crumb, crumbCols) : [];
    if (crumb.length > 0) room -= sep + widthOf(crumb);
  }
  for (const hint of hints.slice(kept.length > 0 ? 1 : hints.length)) {
    if (sep + widthOf(hint) > room) break;
    kept.push(hint);
    room -= sep + widthOf(hint);
  }
  const ordered = crumb.length > 0 ? [crumb, ...kept] : kept;
  const runs: Run[] = [[options.mode, accent]];
  for (const segment of ordered) runs.push([FOOTER_SEPARATOR, muted], ...segment);
  if (runs.length === 1) runs[0] = [fitText(options.mode, region.cols), accent];
  drawRuns(frame, region.x, region.y, runs, region.cols);
}
