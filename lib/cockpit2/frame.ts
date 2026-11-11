/**
 * lib/cockpit2/frame.ts — the cell grid cockpit2 draws into before rendering.
 *
 * Cells have the screen model's shape: a wide grapheme is a cell of width 2
 * followed by a continuation cell (text '', width 0). Every helper keeps that
 * invariant: overwriting either half of a wide grapheme blanks the other half,
 * and a wide grapheme that does not fit is drawn as a blank, never half a glyph.
 */
import { graphemes, graphemeWidth, fitToWidth } from '../cellWidth.ts';
import type { Cell, CellStyle, Cursor, Screen } from './screen.ts';

export interface Frame {
  readonly cols: number;
  readonly rows: number;
  /** Row-major, `cols * rows` cells. */
  readonly cells: Cell[];
}

export interface Region { x: number; y: number; cols: number; rows: number }

export const DEFAULT_STYLE: CellStyle = Object.freeze({
  bold: false, dim: false, italic: false, underline: false, blink: false,
  inverse: false, invisible: false, strikethrough: false,
  fg: Object.freeze({ type: 'default' as const }), bg: Object.freeze({ type: 'default' as const }),
});
/** The style of the edge marker drawn where a smaller pane ends inside its region. */
export const EDGE_STYLE: CellStyle = Object.freeze({ ...DEFAULT_STYLE, dim: true });
export const EDGE_COLUMN = '┊';
export const EDGE_ROW = '┈';

const blank = (style: CellStyle = DEFAULT_STYLE): Cell => ({ text: ' ', width: 1, style });

export function createFrame(cols: number, rows: number): Frame {
  return { cols, rows, cells: Array.from({ length: cols * rows }, () => blank()) };
}

export function cellAt(frame: Frame, x: number, y: number): Cell | undefined {
  if (x < 0 || y < 0 || x >= frame.cols || y >= frame.rows) return undefined;
  return frame.cells[y * frame.cols + x];
}

/**
 * Put one grapheme of `width` 1 or 2 at (x, y), blanking the other half of any
 * wide grapheme it overwrites. A wide grapheme without room for its second
 * column becomes a blank.
 */
function put(frame: Frame, x: number, y: number, text: string, width: 1 | 2, style: CellStyle): void {
  if (x < 0 || y < 0 || x >= frame.cols || y >= frame.rows) return;
  if (width === 2 && x + 1 >= frame.cols) { text = ' '; width = 1; }
  const row = y * frame.cols;
  // The left half of a wide grapheme whose continuation we overwrite.
  if (frame.cells[row + x].width === 0 && x > 0) frame.cells[row + x - 1] = blank(frame.cells[row + x - 1].style);
  // The continuation of a wide grapheme whose left half (at our last column) we overwrite.
  const last = x + width - 1;
  if (frame.cells[row + last].width === 2 && last + 1 < frame.cols) frame.cells[row + last + 1] = blank(frame.cells[row + last + 1].style);
  frame.cells[row + x] = { text, width, style };
  if (width === 2) frame.cells[row + x + 1] = { text: '', width: 0, style };
}

/**
 * Draw `text` at (x, y), at most `maxCols` columns (default: to the frame's
 * right edge), cut with `…` by display width. Zero-width graphemes (stray
 * combining marks, control characters) are dropped. Returns the columns drawn.
 */
export function drawText(frame: Frame, x: number, y: number, text: string, style: CellStyle = DEFAULT_STYLE, maxCols?: number): number {
  if (y < 0 || y >= frame.rows || x < 0 || x >= frame.cols) return 0;
  const room = Math.min(maxCols ?? Infinity, frame.cols - x);
  let col = x;
  for (const grapheme of graphemes(fitToWidth(text, room))) {
    const width = graphemeWidth(grapheme);
    if (width === 0) continue;
    put(frame, col, y, grapheme, width, style);
    col += width;
  }
  return col - x;
}

/** Fill a rectangle (clipped to the frame) with `text`, a one-column grapheme, in `style`. */
export function fillRect(frame: Frame, region: Region, style: CellStyle = DEFAULT_STYLE, text = ' '): void {
  const right = Math.min(frame.cols, region.x + region.cols);
  const bottom = Math.min(frame.rows, region.y + region.rows);
  for (let y = Math.max(0, region.y); y < bottom; y++) {
    for (let x = Math.max(0, region.x); x < right; x++) put(frame, x, y, text, 1, style);
  }
}

export interface BlitOptions {
  /** Draw a dim edge marker column/row where the screen ends inside the region (default true). */
  edge?: boolean;
}

/**
 * Copy a screen's visible cells into `region`. A larger screen is cropped, a
 * smaller one padded with blanks; with `edge` a dim marker column follows its
 * last column and a marker row its last row. A wide grapheme cut by the
 * region's right edge becomes a blank.
 */
export function blitScreen(frame: Frame, screen: Pick<Screen, 'cols' | 'rows' | 'row'>, region: Region, options: BlitOptions = {}): void {
  const edge = options.edge ?? true;
  for (let y = 0; y < region.rows; y++) {
    const cells = y < screen.rows ? screen.row(y) : [];
    for (let x = 0; x < region.cols; x++) {
      const fx = region.x + x;
      const fy = region.y + y;
      const cell = cells[x];
      if (cell) {
        if (cell.width === 0) continue; // written with its left half
        const fits = cell.width === 1 || x + 1 < region.cols;
        if (fits) put(frame, fx, fy, cell.text, cell.width === 2 ? 2 : 1, cell.style);
        else put(frame, fx, fy, ' ', 1, cell.style);
        continue;
      }
      if (edge && x === screen.cols && y < screen.rows) put(frame, fx, fy, EDGE_COLUMN, 1, EDGE_STYLE);
      else if (edge && y === screen.rows && x < screen.cols) put(frame, fx, fy, EDGE_ROW, 1, EDGE_STYLE);
      else put(frame, fx, fy, ' ', 1, DEFAULT_STYLE);
    }
  }
}

/**
 * Where the real terminal's cursor goes for a screen blitted into `region`:
 * `screen.cursor()` is pane-relative, the renderer wants frame cells. Hidden
 * (and parked at the region's origin) when the slot has no focus, the program
 * hid it, the pane is scrolled back, or it falls outside the cropped region.
 */
export function slotCursor(screen: Pick<Screen, 'cursor' | 'scrollOffset'>, region: Region, focused: boolean): Cursor {
  const cursor = screen.cursor();
  const shown = focused && cursor.visible && screen.scrollOffset === 0
    && cursor.x >= 0 && cursor.y >= 0 && cursor.x < region.cols && cursor.y < region.rows;
  return shown ? { x: region.x + cursor.x, y: region.y + cursor.y, visible: true } : { x: region.x, y: region.y, visible: false };
}
