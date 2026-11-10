/**
 * lib/cellWidth.ts — how many terminal columns text takes.
 *
 * Text is measured per grapheme cluster (`Intl.Segmenter`), the unit a
 * terminal draws in one cell or two: East Asian wide and fullwidth characters
 * and emoji presentation take 2 columns, combining marks, format characters and
 * control characters 0, everything else 1. A grapheme takes the width of its
 * base; VS16 (emoji presentation) and a keycap make it 2, VS15 (text
 * presentation) 1, and a ZWJ sequence or flag pair counts once.
 *
 * Pure: no imports from the repo.
 */

/** East Asian Wide (W) and Fullwidth (F) ranges that are not emoji (emoji are matched by property). */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2329, 0x232a], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x18cff], [0x1aff0, 0x1b16f], [0x1f200, 0x1f2ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

/** Combining marks, format characters (ZWJ, ZWSP, bidi marks, BOM) and Hangul medial/final jamo. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}ᅠ-ᇿힰ-퟿]$/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const VS15 = '︎';
const VS16 = '️';
const KEYCAP = '⃣';
const ELLIPSIS = '…';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Columns one code point takes on its own: 0, 1 or 2. */
export function codePointWidth(cp: number): 0 | 1 | 2 {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  const ch = String.fromCodePoint(cp);
  if (ZERO_WIDTH.test(ch)) return 0;
  if (inRanges(cp, WIDE_RANGES) || EMOJI_PRESENTATION.test(ch)) return 2;
  return 1;
}

/** The grapheme clusters of `text`. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (segment) => segment.segment);
}

/** Columns one grapheme cluster takes: 0, 1 or 2. */
export function graphemeWidth(grapheme: string): 0 | 1 | 2 {
  let base: 0 | 1 | 2 = 0;
  for (const ch of grapheme) {
    base = codePointWidth(ch.codePointAt(0)!);
    if (base > 0) break;
  }
  if (base === 0) return 0;
  if (grapheme.includes(VS16) || grapheme.includes(KEYCAP)) return 2;
  if (grapheme.includes(VS15)) return 1;
  return base;
}

/** Columns `text` takes. */
export function stringWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment);
  return width;
}

/** `text` cut to at most `cols` columns, ending in `…` when cut; a wide grapheme is never split. */
export function fitToWidth(text: string, cols: number): string {
  if (cols <= 0) return '';
  if (stringWidth(text) <= cols) return text;
  let out = '';
  let width = 0;
  for (const { segment } of segmenter.segment(text)) {
    const w = graphemeWidth(segment);
    if (width + w > cols - 1) break;
    out += segment;
    width += w;
  }
  return out + ELLIPSIS;
}

/** `text` fitted to `cols` columns and padded with spaces to exactly `cols`. */
export function padToWidth(text: string, cols: number): string {
  const fitted = fitToWidth(text, cols);
  return fitted + ' '.repeat(Math.max(0, cols - stringWidth(fitted)));
}
