/**
 * lib/cockpit2/widgets.ts — the header, the tab bar and the footer drawn as cells (Plan 6 Step 9).
 *
 * The tab bar comes from the pure view model the Ink cockpit uses
 * (lib/tui/tabBarModel.ts), drawn as its label row only: one row of solid blocks; the sidebar's
 * cards are sidebarCards.ts.
 * The header is the cockpit's top row: the orc mark, the active project, the
 * explorer and attention buttons. The footer is its last row: the mode,
 * where you are, the keys.
 * Text is fitted by display width (lib/cellWidth.ts), so wide-character names
 * take their two columns and are never split.
 *
 * With the slot focused the active tab's label is reversed, a marker that
 * does not rely on colour. Colour comes on top, from the theme's roles
 * (lib/cockpit2/theme.ts). Tab clicks hit-test with `tabBarClickTarget` from
 * the model. Everything here is pure; nothing touches a session.
 */
import { stringWidth } from '../cellWidth.ts';
import { fitText } from '../tui/sidebar.ts';
import { layoutTabBar, tabBarRows, type TabBarLayout, type TabBarModel, type TabBarSegment } from '../tui/tabBarModel.ts';
import { DEFAULT_STYLE, drawText, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { attentionRole, badgeRole, styleOf, type Theme, type ThemeRole } from './theme.ts';

// ── styles ───────────────────────────────────────────────────────────────────

/** The mark before an agent tab's name in typing mode, and in view mode. */
export const TYPING_MARK = '✎';
export const VIEW_MARK = '○';

/** Text in one style; `status` marks a run whose colours carry a state (a badge, a count), which the sidebar's cursor row keeps. */
export type Run = readonly [text: string, style: CellStyle, status?: boolean];

/** Draws runs left to right from (x, y), at most `maxCols` columns in all; returns the columns drawn. */
export function drawRuns(frame: Frame, x: number, y: number, runs: readonly Run[], maxCols: number): number {
  let col = 0;
  for (const [text, runStyle] of runs) {
    if (col >= maxCols) break;
    col += drawText(frame, x + col, y, text, runStyle, maxCols - col);
  }
  return col;
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

/**
 * A tab's segment as a solid block: the active tab in `tab.active`, the others
 * in `tab.inactive`; badge and close mark keep their colour on the tab's fill
 * (inverse on the active tab when its role has no fill colour, as in `mono`).
 * A tab's side borders become plain spaces: the gap between blocks.
 */
function tabBlockStyle(segment: TabBarSegment, tab: TabBarModel['tabs'][number], theme: Theme): CellStyle {
  const fill = styleOf(theme, tab.active ? 'tab.active' : 'tab.inactive');
  const hasFill = fill.bg.type !== 'default';
  const onFill = (style: CellStyle): CellStyle => (hasFill ? { ...style, bg: fill.bg } : tab.active ? { ...style, inverse: true } : style);
  switch (segment.kind) {
    case 'border': return DEFAULT_STYLE;
    case 'badge': return onFill(styleOf(theme, badgeRole(tab.attention ? attentionRole(tab.attention) : 'status.attention')));
    case 'close': return onFill(styleOf(theme, 'tab.close'));
    default: return fill;
  }
}

/**
 * Draws the tab bar into `region`'s first row: the tabs as solid blocks with
 * a one-column gap between them (the active one in `tab.active`) and the
 * overflow markers; a notice or the last action's error takes the row instead.
 */
export function drawTabBar(frame: Frame, region: Region, view: TabBarView, options: TabBarDrawOptions): void {
  if (region.cols <= 0 || region.rows <= 0) return;
  const { model, layout } = view;
  const { theme } = options;
  if (options.error) {
    drawText(frame, region.x, region.y, options.error, styleOf(theme, 'error'), region.cols);
    return;
  }
  const [, middle] = tabBarRows(model, layout, region.cols, null);
  drawRuns(frame, region.x, region.y, middle.map((segment): Run => {
    const tab = segment.tab === undefined ? null : model.tabs[segment.tab];
    if (!tab) return [segment.text, styleOf(theme, 'text.muted')];
    return [segment.kind === 'border' ? ' ' : segment.text, tabBlockStyle(segment, tab, theme)];
  }), region.cols);
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
  if (runs.reduce((sum, [text]) => sum + stringWidth(text), 0) <= cols) return [...runs];
  const out: Run[] = [];
  let left = cols;
  for (const [text, runStyle] of runs) {
    const width = stringWidth(text);
    // A whole run only while a column stays for the `…`.
    if (width < left) { out.push([text, runStyle]); left -= width; continue; }
    out.push([fitText(`${text}…`, left), runStyle]); // cut, always ending in `…`
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
