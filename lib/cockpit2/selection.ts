/**
 * lib/cockpit2/selection.ts — the cockpit's text selection in a pane (Plan 6 Step 10).
 *
 * A selection runs in reading order from one viewport cell to another, both
 * included, like a terminal's: whole rows between the first and last. A cell
 * on either half of a wide character selects the whole character. Rows joined
 * by a soft wrap become one line; other row ends become `\n` with their
 * trailing blanks dropped. Release copies the text with OSC 52. Pure.
 */
import type { Frame, Region } from './frame.ts';
import type { Screen } from './screen.ts';

/** A viewport cell of the pane (0-based). */
export interface CellPoint { x: number; y: number }

/** Where the drag started and where the pointer is now; either may come first. */
export interface Selection { anchor: CellPoint; head: CellPoint }

export type SelectionSource = Pick<Screen, 'cols' | 'rows' | 'row' | 'wrapped'>;

const before = (a: CellPoint, b: CellPoint) => a.y < b.y || (a.y === b.y && a.x <= b.x);

/**
 * The selection's first and last cell in reading order, clamped to the
 * viewport and widened to whole wide characters; null when it is outside it.
 */
export function selectionRange(source: SelectionSource, selection: Selection): { start: CellPoint; end: CellPoint } | null {
  if (source.cols <= 0 || source.rows <= 0) return null;
  const clampPoint = ({ x, y }: CellPoint): CellPoint => ({
    x: Math.min(Math.max(x, 0), source.cols - 1),
    y: Math.min(Math.max(y, 0), source.rows - 1),
  });
  const [first, last] = before(selection.anchor, selection.head) ? [selection.anchor, selection.head] : [selection.head, selection.anchor];
  const start = clampPoint(first);
  const end = clampPoint(last);
  // The right half of a wide character starts at its left half; a left half ends at its right half.
  if (start.x > 0 && source.row(start.y)[start.x]?.width === 0) start.x--;
  if (end.x + 1 < source.cols && source.row(end.y)[end.x]?.width === 2) end.x++;
  return { start, end };
}

/** Whether viewport cell (x, y) is in the range. */
const covers = (range: { start: CellPoint; end: CellPoint }, x: number, y: number) =>
  before(range.start, { x, y }) && before({ x, y }, range.end);

/** The selected text: wrapped rows joined, other row ends as `\n` without their trailing blanks. */
export function selectionText(source: SelectionSource, selection: Selection): string {
  const range = selectionRange(source, selection);
  if (!range) return '';
  const { start, end } = range;
  let text = '';
  for (let y = start.y; y <= end.y; y++) {
    const cells = source.row(y);
    const from = y === start.y ? start.x : 0;
    let to = y === end.y ? end.x : source.cols - 1;
    const continues = y < end.y && source.wrapped(y + 1);
    // A wide character that did not fit at the row's end wrapped and left a blank behind (as xterm trims it).
    if (continues && to === source.cols - 1 && cells[to]?.text === ' ' && source.row(y + 1)[0]?.width === 2) to--;
    let segment = '';
    for (let x = from; x <= to; x++) {
      const cell = cells[x];
      if (cell && cell.width !== 0) segment += cell.text;
    }
    if (continues) text += segment;
    else if (y < end.y) text += `${segment.replace(/ +$/, '')}\n`;
    // The last row keeps its blanks unless the selection runs past its end.
    else text += to === source.cols - 1 ? segment.replace(/ +$/, '') : segment;
  }
  return text;
}

/** Marks the selected cells of a screen blitted into `region` in inverse video. */
export function highlightSelection(frame: Frame, region: Region, source: SelectionSource, selection: Selection): void {
  const range = selectionRange(source, selection);
  if (!range) return;
  const rows = Math.min(region.rows, source.rows, frame.rows - region.y);
  const cols = Math.min(region.cols, source.cols, frame.cols - region.x);
  for (let y = Math.max(0, range.start.y); y <= range.end.y && y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!covers(range, x, y)) continue;
      const index = (region.y + y) * frame.cols + region.x + x;
      const cell = frame.cells[index];
      frame.cells[index] = { ...cell, style: { ...cell.style, inverse: !cell.style.inverse } };
    }
  }
}

/** The OSC 52 sequence that puts `text` on the terminal's clipboard (UTF-8, base64). */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}
