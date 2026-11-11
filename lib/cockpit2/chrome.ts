/**
 * lib/cockpit2/chrome.ts — the cockpit's chrome primitives: a square box with
 * a bracketed title and right-aligned meta, a bracketed status badge and the
 * plus/minus collapse marker.
 *
 *   box     ┌─ [ AGENTS ] ──────── 3 live ┐   │ … │   └──────┘
 *   badge   [RUNNING]  [INPUT REQ]
 *   marker  [+] collapsed   [-] expanded
 *
 * Pure drawing on a Frame; widths are display widths (a wide grapheme takes two
 * columns and is never split).
 */
import { stringWidth } from '../cellWidth.ts';
import { fitText } from '../tui/sidebar.ts';
import { drawText, type Frame, type Region } from './frame.ts';
import type { CellStyle } from './screen.ts';
import { badgeRole, styleOf, type StatusRole, type Theme, type ThemeRole } from './theme.ts';

export interface BoxOptions {
  /** Shown upper-cased as `[ TITLE ]` after `┌─ `; cut by display width when it does not fit. */
  title?: string;
  /** Shown flush right on the top border when it fits whole; dropped before the title is cut. */
  meta?: string;
  /** The border's role; default `chrome.border`, or `chrome.borderFocus` when focused. */
  role?: ThemeRole;
  focused?: boolean;
  theme: Theme;
}

const EMPTY = (region: Region): Region => ({ x: region.x, y: region.y, cols: 0, rows: 0 });

/** Columns the top border needs around a title: `─ [ ` and ` ] ` (the trailing space may meet the corner). */
const TITLE_CHROME = 7;
/** Columns around the meta: a space each side and at least one `─` before it. */
const META_CHROME = 3;

/**
 * The top border's title and meta for a box `cols` wide: the title cut only
 * when even it alone does not fit (and dropped below two columns), the meta
 * shown whole beside an uncut title or not at all.
 */
function topLabels(cols: number, title: string, meta: string): { title: string; meta: string } {
  const inner = cols - 2;
  const titleRoom = inner - TITLE_CHROME;
  const titleWidth = stringWidth(title);
  let shownTitle = '';
  if (title && titleWidth <= titleRoom) shownTitle = title;
  else if (title && titleRoom >= 2) shownTitle = fitText(title, titleRoom);
  // A cut that keeps no text (a wide first grapheme in two columns) is only the ellipsis: drop it.
  if (shownTitle && shownTitle !== title && stringWidth(shownTitle) <= 1) shownTitle = '';
  const titleCut = shownTitle !== title;
  const used = shownTitle ? stringWidth(shownTitle) + TITLE_CHROME : 0;
  const metaRoom = inner - used - META_CHROME;
  const shownMeta = meta && !titleCut && stringWidth(meta) <= metaRoom ? meta : '';
  return { title: shownTitle, meta: shownMeta };
}

/**
 * Draw a square box on `region`'s edge and return its inner region. Draws
 * nothing (and returns an empty region) when the region is narrower than 4 or
 * shorter than 2. The inside is left as it is.
 */
export function drawBox(frame: Frame, region: Region, options: BoxOptions): Region {
  const { x, y, cols, rows } = region;
  if (cols < 4 || rows < 2) return EMPTY(region);
  const { theme, focused = false } = options;
  const border = styleOf(theme, options.role ?? (focused ? 'chrome.borderFocus' : 'chrome.border'));
  const labels = topLabels(cols, (options.title ?? '').toUpperCase(), options.meta ?? '');
  const right = x + cols - 1;

  drawText(frame, x, y, `┌${'─'.repeat(cols - 2)}┐`, border, cols);
  if (labels.title) {
    const label = `[ ${labels.title} ]`;
    drawText(frame, x + 2, y, ' ', border, 1);
    drawText(frame, x + 3, y, label, styleOf(theme, focused ? 'chrome.titleFocus' : 'chrome.title'), stringWidth(label));
    drawText(frame, x + 3 + stringWidth(label), y, ' ', border, 1);
  }
  if (labels.meta) {
    const width = stringWidth(labels.meta);
    drawText(frame, right - width - 2, y, ' ', border, 1);
    drawText(frame, right - width - 1, y, labels.meta, styleOf(theme, 'chrome.meta'), width);
    drawText(frame, right - 1, y, ' ', border, 1);
  }
  for (let row = y + 1; row < y + rows - 1; row++) {
    drawText(frame, x, row, '│', border, 1);
    drawText(frame, right, row, '│', border, 1);
  }
  drawText(frame, x, y + rows - 1, `└${'─'.repeat(cols - 2)}┘`, border, cols);
  return { x: x + 1, y: y + 1, cols: cols - 2, rows: rows - 2 };
}

/**
 * Draw `[LABEL]` (upper-cased) at (x, y) in the status role's badge style and
 * return its width; draws nothing and returns 0 when it does not fit in
 * `maxCols` (default: to the frame's right edge) or the frame.
 */
export function drawBadge(frame: Frame, x: number, y: number, label: string, statusRole: StatusRole, theme: Theme, maxCols?: number): number {
  const text = `[${label.toUpperCase()}]`;
  const width = stringWidth(text);
  if (x < 0 || y < 0 || y >= frame.rows || width > Math.min(maxCols ?? Infinity, frame.cols - x)) return 0;
  return drawText(frame, x, y, text, styleOf(theme, badgeRole(statusRole)), width);
}

/** The marker in front of a collapsible row: `[-]` when expanded, `[+]` when collapsed. */
export function collapseMarker(expanded: boolean): string {
  return expanded ? '[-]' : '[+]';
}

/** The box around the slot: `region` is the slot with its frame. */
export function drawPaneFrame(frame: Frame, region: Region, style: CellStyle): void {
  if (region.cols < 2 || region.rows < 2) return;
  const left = region.x;
  const right = region.x + region.cols - 1;
  const bottom = region.y + region.rows - 1;
  drawText(frame, left, region.y, `┌${'─'.repeat(region.cols - 2)}┐`, style, region.cols);
  for (let y = region.y + 1; y < bottom; y += 1) {
    drawText(frame, left, y, '│', style, 1);
    drawText(frame, right, y, '│', style, 1);
  }
  drawText(frame, left, bottom, `└${'─'.repeat(region.cols - 2)}┘`, style, region.cols);
}
