/**
 * lib/cockpit2/widgets.ts — the sidebar and the tab bar drawn as cells (Plan 6 Step 9).
 *
 * Both come from the pure view models the Ink cockpit uses: the sidebar from
 * lib/tui/sidebar.ts (status box, projects box, agents box, then one footer
 * row), the tab bar from lib/tui/tabBarModel.ts (three rows of bordered tabs).
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

/** What of `model` fits `rows` rows (the last one is the footer), the cursor kept in view. */
export function sidebarView(model: SidebarModel, rows: number, nav: SidebarNav): SidebarView {
  const projectIndex = indexOfKey(model.projects.map((project) => project.project_id), nav.projectKey ?? model.activeProjectId, 0);
  const agentIndex = indexOfKey(model.agents.map((agent) => agent.key), nav.agentKey, 0);
  return { model, layout: computeSidebarLayout(model, rows, { project: projectIndex, agent: agentIndex }), projectIndex, agentIndex };
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
  /** The last row: the focus or the tab's mode and its keys. */
  footer: string;
  /** The styles the sidebar is drawn in. */
  theme: Theme;
}

/**
 * Draws the sidebar into `region`: the status box, the projects box and the
 * agents box (each sized by the layout), and the footer on the last row.
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
  const footerY = region.y + region.rows - 1;
  // Rows below the footer's never hold a box: a terminal too short for the boxes cuts them.
  const line = (y: number, runs: readonly Run[], x = region.x + 1, cols = inner) => {
    if (y < footerY) drawRuns(frame, x, y, runs, cols);
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

  drawText(frame, region.x, footerY, options.footer, role('chrome.meta'), width);
}

// ── tab bar ──────────────────────────────────────────────────────────────────

/** A clickable entry flush right in the tab bar, left of the quit hint: the task explorer, or the count of agents needing attention. */
export interface TabBarButton { action: 'explorer' | 'attention'; text: string }
/** A button as placed: `x` is its first column in the bar. */
export interface PlacedTabBarButton extends TabBarButton { x: number }

/** The tab bar as it is drawn: the model, which tabs fit, the hint flush right of them (null when it has no room), and the buttons left of the hint. */
export interface TabBarView { model: TabBarModel; layout: TabBarLayout; hint: string | null; buttons: PlacedTabBarButton[] }

/** The tabs keep at least this many columns; a narrower bar drops the hint instead. */
const MIN_TAB_COLS = 24;
/** The tabs keep at least this many columns next to the buttons; a narrower bar drops buttons, the first given first. */
const MIN_TAB_COLS_WITH_BUTTONS = 20;

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

/**
 * Lays the tabs out in `cols`, minus room for `hint` (the quit key) flush
 * right and the `buttons` left of it, so the hint stays visible however many
 * tabs are open: tabs that do not fit go behind the overflow markers. Buttons
 * are left out (the first given first) when the tabs would keep fewer than
 * 20 columns, the hint when they would keep fewer than 24.
 */
export function tabBarView(model: TabBarModel, cols: number, hint: string | null = null, buttons: TabBarButton[] = []): TabBarView {
  const shownHint = hint && cols - (stringWidth(hint) + 1) >= MIN_TAB_COLS ? hint : null;
  const hintReserve = shownHint ? stringWidth(shownHint) + 1 : 0;
  const width = (list: TabBarButton[]) => list.reduce((sum, button) => sum + stringWidth(button.text) + 1, 0);
  // The quit hint comes first: a bar with no room for it has none for the buttons.
  let kept = model.notice || (hint && !shownHint) ? [] : buttons;
  while (kept.length > 0 && cols - hintReserve - width(kept) < MIN_TAB_COLS_WITH_BUTTONS) kept = kept.slice(1);
  const reserve = hintReserve + width(kept);
  let x = cols - reserve + 1;
  const placed = kept.map((button) => {
    const at = { ...button, x };
    x += stringWidth(button.text) + 1;
    return at;
  });
  return { model, layout: layoutTabBar(model, cols - reserve), hint: shownHint, buttons: placed };
}

/** The button at column `x` of the bar (any row), or null. */
export function tabBarButtonAt(view: TabBarView, x: number): TabBarButton['action'] | null {
  return view.buttons.find((button) => x >= button.x && x < button.x + stringWidth(button.text))?.action ?? null;
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
    case 'marker': case 'rule': case 'notice': return styleOf(theme, 'chrome.meta');
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
  if (model.notice) return;
  const y = region.y + (region.rows >= 3 ? 1 : 0);
  for (const button of view.buttons) {
    const width = stringWidth(button.text);
    drawText(frame, region.x + button.x, y, button.text, styleOf(options.theme, button.action === 'attention' ? 'button.attention' : 'button'), width);
  }
  if (!view.hint) return;
  const hintWidth = stringWidth(view.hint);
  drawText(frame, region.x + region.cols - hintWidth, y, view.hint, styleOf(options.theme, 'chrome.meta'), hintWidth);
}
