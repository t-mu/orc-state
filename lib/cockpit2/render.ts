/**
 * lib/cockpit2/render.ts — turn the change from one frame to the next into terminal output.
 *
 * Only changed cells are written. The whole update is one synchronized-output
 * block (mode 2026) with the cursor hidden, so the terminal never shows a half
 * drawn frame, and ends with the cursor where the active pane's program has it.
 *
 * The returned string must be written to the terminal as UTF-8
 * (`Buffer.from(out, 'utf8')` or a stream with utf8 encoding), never through
 * a locale-dependent encoding.
 */
import type { Cell, CellStyle, Color } from './screen.ts';
import { DEFAULT_STYLE, type Frame } from './frame.ts';

const ESC = '\x1b';
const SYNC_ON = `${ESC}[?2026h`;
const SYNC_OFF = `${ESC}[?2026l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;

export interface RenderCursor { x: number; y: number; visible: boolean }

const ATTRIBUTES = [
  ['bold', '1'], ['dim', '2'], ['italic', '3'], ['underline', '4'],
  ['blink', '5'], ['inverse', '7'], ['invisible', '8'], ['strikethrough', '9'],
] as const;

function colorParams(color: Color, base: 30 | 40): string {
  if (color.type === 'default') return String(base + 9);
  if (color.type === 'rgb') return `${base + 8};2;${color.r};${color.g};${color.b}`;
  if (color.index < 8) return String(base + color.index);
  if (color.index < 16) return String(base + 60 + color.index - 8);
  return `${base + 8};5;${color.index}`;
}

const sameColor = (a: Color, b: Color): boolean => colorParams(a, 30) === colorParams(b, 30);

export function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return ATTRIBUTES.every(([key]) => a[key] === b[key]) && sameColor(a.fg, b.fg) && sameColor(a.bg, b.bg);
}

/**
 * The SGR sequence that changes the terminal from `from` (null: unknown) to
 * `to`: only what changed, or a reset plus everything set when an attribute
 * is dropped or the current style is unknown. '' when nothing changes.
 */
export function sgrTransition(from: CellStyle | null, to: CellStyle): string {
  const params: string[] = [];
  const reset = from === null || ATTRIBUTES.some(([key]) => from[key] && !to[key]);
  if (reset) params.push('0');
  for (const [key, code] of ATTRIBUTES) if (to[key] && (reset || !from[key])) params.push(code);
  if (reset ? to.fg.type !== 'default' : !sameColor(from.fg, to.fg)) params.push(colorParams(to.fg, 30));
  if (reset ? to.bg.type !== 'default' : !sameColor(from.bg, to.bg)) params.push(colorParams(to.bg, 40));
  return params.length ? `${ESC}[${params.join(';')}m` : '';
}

function sameCell(a: Cell | undefined, b: Cell): boolean {
  return a !== undefined && a.text === b.text && a.width === b.width && sameStyle(a.style, b.style);
}

/** CJK and Hangul code points, which every terminal draws two columns wide. */
const SURE_WIDE = /^[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿＀-｠￠-￦]$/u;

/**
 * Whether terminals may disagree on how far `cell` advances the cursor: emoji,
 * multi-code-point graphemes and wide text outside CJK. After such a cell the
 * next write repositions the cursor, so a disagreement never shifts the columns after it.
 */
function uncertainAdvance(cell: Cell): boolean {
  const text = cell.text;
  if (text.length === 1) return cell.width === 2 && !SURE_WIDE.test(text);
  return true; // surrogate pairs (emoji, astral CJK), combining sequences, ZWJ, VS16
}

const moveTo = (x: number, y: number) => `${ESC}[${y + 1};${x + 1}H`;

/**
 * Terminal output that turns `prev` (what the terminal shows; null when
 * unknown) into `next`, then parks the cursor at `cursor`. Repaints every cell
 * when `prev` is null or its size differs.
 */
export function renderDiff(prev: Frame | null, next: Frame, cursor: RenderCursor): string {
  const full = prev === null || prev.cols !== next.cols || prev.rows !== next.rows;
  let out = SYNC_ON + HIDE_CURSOR;
  let style: CellStyle | null = null; // unknown until we set it
  let at = -1; // the cell index the terminal's cursor is at, -1 when unknown
  const { cols, cells } = next;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.width === 0) continue; // a continuation, written with its left half
    if (!full) {
      const changed = !sameCell(prev.cells[i], cell) || (cell.width === 2 && !sameCell(prev.cells[i + 1], cells[i + 1]));
      if (!changed) continue;
    }
    if (at !== i) out += moveTo(i % cols, Math.floor(i / cols));
    out += sgrTransition(style, cell.style);
    style = cell.style;
    out += cell.text;
    const end = i + (cell.width === 2 ? 2 : 1);
    // At a row's end the terminal waits to wrap, and an uncertain advance may be off: reposition next time.
    at = end % cols === 0 || uncertainAdvance(cell) ? -1 : end;
  }
  if (style !== null) out += sgrTransition(style, DEFAULT_STYLE);
  out += moveTo(cursor.x, cursor.y);
  if (cursor.visible) out += SHOW_CURSOR;
  return out + SYNC_OFF;
}
