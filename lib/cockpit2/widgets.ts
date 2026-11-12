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
 * does not rely on colour; with the tab strip focused the highlighted tab is
 * marked `▸` and its label underlined. Colour comes on top, from the theme's roles
 * (lib/cockpit2/theme.ts). Tab clicks hit-test with `tabBarClickTarget` from
 * the model. Everything here is pure; nothing touches a session.
 */
import { stringWidth } from '../cellWidth.ts';
import { fitText } from '../tui/sidebar.ts';
import { CLOSE_MARKER, TAB_GAP, layoutTabBar, type TabBarLayout, type TabBarModel } from '../tui/tabBarModel.ts';
import { AGENT_TAB_PREFIX, SHELL_TAB_PREFIX, isAgentSessionTab, isShellTab } from './explorer.ts';
import { DEFAULT_STYLE, drawText, fillRect, type Frame, type Region } from './frame.ts';
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
/** The tab bar as drawn: the model, which tabs fit, and where the new-shell tab (`+`) sits (null when it has no room or no project is open). */
export interface TabBarView { model: TabBarModel; layout: TabBarLayout; plus: { x: number } | null }

/** The new-shell tab's label and width: a small block after the last tab. */
export const PLUS_LABEL = ' + ';
const PLUS_COLS = PLUS_LABEL.length;

/** The explorer tab's id in the tab bar model: not an agent id (agent ids hold no control characters). */
export const EXPLORER_TAB = '\u0000tasks';
export const EXPLORER_LABEL = 'tasks';

/**
 * Agent tabs labelled with their mode's mark (`○` view, `✎` typing); the master tab, always typing, has none.
 * An agent session tab (`agent:N`) is labelled by `agentLabel` (`claude 1`, `critic · claude`), else `agent N`.
 */
export function withModeMarks(model: TabBarModel, typing: (agentId: string) => boolean, agentLabel?: (tabId: string) => string | null): TabBarModel {
  return {
    ...model,
    // The master, shell and agent session tabs always type: no mark; a shell tab is labelled `shell N`.
    tabs: model.tabs.map((tab) => {
      const id = tab.agentId;
      if (id === null) return tab;
      if (isShellTab(id)) return { ...tab, label: `shell ${id.slice(SHELL_TAB_PREFIX.length)}` };
      if (isAgentSessionTab(id)) return { ...tab, label: agentLabel?.(id) ?? `agent ${id.slice(AGENT_TAB_PREFIX.length)}` };
      return { ...tab, label: `${typing(id) ? TYPING_MARK : VIEW_MARK} ${tab.label}` };
    }),
  };
}

/** The task explorer shown as the active tab after the project's tabs, closable; the project's tabs are inactive while it is shown. */
export function withExplorerTab(model: TabBarModel): TabBarModel {
  if (model.notice) return model;
  const tabs = model.tabs.map((tab) => ({ ...tab, active: false }));
  return { ...model, tabs: [...tabs, { agentId: EXPLORER_TAB, number: tabs.length + 1, label: EXPLORER_LABEL, active: true, attention: null, closable: true }] };
}

/** Lays the tabs out in the bar's full width: tabs that do not fit go behind the overflow markers. */
export function tabBarView(model: TabBarModel, cols: number, withPlus = false): TabBarView {
  if (!withPlus || model.notice || cols < PLUS_COLS + TAB_GAP + 10) return { model, layout: layoutTabBar(model, cols), plus: null };
  const layout = layoutTabBar(model, cols - PLUS_COLS - TAB_GAP);
  const last = layout.cells.at(-1);
  const end = (last ? last.x + last.width : stringWidth(layout.leftMarker)) + stringWidth(layout.rightMarker);
  return { model, layout, plus: { x: end + TAB_GAP } };
}

/** Whether column `x` of the bar is on the new-shell tab. */
export const onPlusTab = (view: TabBarView, x: number) => view.plus !== null && x >= view.plus.x && x < view.plus.x + PLUS_COLS;

export interface TabBarDrawOptions {
  /** The slot has the keys: the active tab is the focus marker. */
  slotFocused: boolean;
  /** What the last action reported, or a failed save; takes the bottom row. */
  error: string | null;
  /** The tab strip has the keys: the highlighted tab (its index in the model) or the new-shell tab (`plus`); null otherwise. */
  highlight?: number | 'plus' | null;
  /** The styles the tab bar is drawn in. */
  theme: Theme;
}

/**
 * A tab's block: its label row in `fill`, and above and below it a half block
 * in the fill colour, so the block looks two rows tall, not three (inverse
 * fills, as in `mono`, are capped in the default colours; no fill, no caps).
 */
function drawTabBlock(frame: Frame, region: Region, cellX: number, cols: number, labelY: number, fill: CellStyle): void {
  const x = region.x + cellX;
  fillRect(frame, { x, y: labelY, cols, rows: 1 }, fill);
  const cap = fill.bg.type !== 'default' ? { ...DEFAULT_STYLE, fg: fill.bg } : fill.inverse ? DEFAULT_STYLE : null;
  if (!cap) return;
  if (labelY > region.y) fillRect(frame, { x, y: labelY - 1, cols, rows: 1 }, cap, '▄');
  if (labelY < region.y + region.rows - 1) fillRect(frame, { x, y: labelY + 1, cols, rows: 1 }, cap, '▀');
}

/**
 * Draws the tab bar into `region`: each tab a solid block on the label row
 * capped by half blocks above and below (`▄`, `▀`)
 * (the active one in `tab.active`, the others in `tab.inactive`) with its
 * number, label, badge and close mark on the label row, one column between
 * blocks, the overflow markers beside them. Badge and close mark keep their
 * colour on the tab's fill (inverse on the active tab when its role has no
 * fill colour, as in `mono`). The last action's error takes the label row.
 */
export function drawTabBar(frame: Frame, region: Region, view: TabBarView, options: TabBarDrawOptions): void {
  if (region.cols <= 0 || region.rows <= 0) return;
  const { model, layout } = view;
  const { theme } = options;
  const labelY = region.y + Math.floor((region.rows - 1) / 2);
  if (options.error) {
    drawText(frame, region.x, labelY, options.error, styleOf(theme, 'error'), region.cols);
    return;
  }
  if (model.notice) {
    drawText(frame, region.x, labelY, model.notice, styleOf(theme, 'text.muted'), region.cols);
    return;
  }
  const muted = styleOf(theme, 'text.muted');
  if (layout.leftMarker) drawText(frame, region.x, labelY, layout.leftMarker, muted, region.cols);
  let end = stringWidth(layout.leftMarker);
  for (const cell of layout.cells) {
    const tab = model.tabs[cell.index];
    const fill = styleOf(theme, tab.active ? 'tab.active' : 'tab.inactive');
    const hasFill = fill.bg.type !== 'default';
    const onFill = (style: CellStyle): CellStyle => (hasFill ? { ...style, bg: fill.bg } : tab.active ? { ...style, inverse: true } : style);
    const x = region.x + cell.x;
    const cols = Math.min(cell.width, region.cols - cell.x);
    if (cols <= 0) break;
    drawTabBlock(frame, region, cell.x, cols, labelY, fill);
    const highlighted = options.highlight === cell.index;
    const runs: Run[] = [[cell.text, highlighted ? { ...fill, underline: true, bold: true } : fill]];
    if (cell.badge) runs.push([cell.badge, onFill(styleOf(theme, badgeRole(tab.attention ? attentionRole(tab.attention) : 'status.attention')))]);
    if (tab.closable) runs.push([' ', fill], [CLOSE_MARKER, onFill(styleOf(theme, 'tab.close'))]);
    drawRuns(frame, x + 1, labelY, runs, cols - 2);
    if (highlighted) drawHighlightMark(frame, x, labelY, fill, theme);
    end = cell.x + cell.width;
  }
  if (layout.rightMarker) drawText(frame, region.x + end, labelY, layout.rightMarker, muted, region.cols - end);
  if (view.plus) {
    const fill = styleOf(theme, 'tab.inactive');
    const highlighted = options.highlight === 'plus';
    drawTabBlock(frame, region, view.plus.x, PLUS_COLS, labelY, fill);
    drawText(frame, region.x + view.plus.x, labelY, PLUS_LABEL, { ...fill, bold: true, ...(highlighted ? { underline: true } : {}) }, PLUS_COLS);
    if (highlighted) drawHighlightMark(frame, region.x + view.plus.x, labelY, fill, theme);
  }
}

/** The tab strip's highlight mark: a `▸` in the block's first column, in `chrome.borderFocus` on the block's fill. */
export const TAB_HIGHLIGHT_MARK = '▸';
function drawHighlightMark(frame: Frame, x: number, y: number, fill: CellStyle, theme: Theme): void {
  drawText(frame, x, y, TAB_HIGHLIGHT_MARK, { ...fill, fg: styleOf(theme, 'chrome.borderFocus').fg, bold: true }, 1);
}

// ── footer ───────────────────────────────────────────────────────────────────

/** A key hint in the footer: `key` (a key label, e.g. `F10` or `Ctrl-Space q`) and what it does. */
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
