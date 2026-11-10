import xtermHeadless from '@xterm/headless';
import type { IBufferCell, IUnicodeVersionProvider } from '@xterm/headless';
import { afterEach, describe, expect, it } from 'vitest';
import { codePointWidth } from '../cellWidth.ts';
import { createFrame, DEFAULT_STYLE, drawText, fillRect, type Frame } from './frame.ts';
import { renderDiff, sgrTransition } from './render.ts';
import type { Cell, CellStyle, Color } from './screen.ts';

const { Terminal } = xtermHeadless;
const ESC = '\x1b';
const PRE = `${ESC}[?2026h${ESC}[?25l`;
const POST = `${ESC}[?2026l`;
const HIDDEN = { x: 0, y: 0, visible: false };

const style = (over: Partial<CellStyle>): CellStyle => ({ ...DEFAULT_STYLE, ...over });
const RED: Color = { type: 'palette', index: 1 };

describe('sgrTransition', () => {
  it('from an unknown style resets first', () => {
    expect(sgrTransition(null, DEFAULT_STYLE)).toBe(`${ESC}[0m`);
    expect(sgrTransition(null, style({ bold: true, fg: RED }))).toBe(`${ESC}[0;1;31m`);
  });

  it('adds only what changed', () => {
    expect(sgrTransition(DEFAULT_STYLE, DEFAULT_STYLE)).toBe('');
    expect(sgrTransition(DEFAULT_STYLE, style({ bold: true }))).toBe(`${ESC}[1m`);
    expect(sgrTransition(style({ bold: true }), style({ bold: true, underline: true, fg: RED }))).toBe(`${ESC}[4;31m`);
    expect(sgrTransition(style({ fg: RED }), DEFAULT_STYLE)).toBe(`${ESC}[39m`);
    expect(sgrTransition(DEFAULT_STYLE, style({ bg: { type: 'palette', index: 9 } }))).toBe(`${ESC}[101m`);
    expect(sgrTransition(DEFAULT_STYLE, style({ fg: { type: 'palette', index: 200 } }))).toBe(`${ESC}[38;5;200m`);
    expect(sgrTransition(DEFAULT_STYLE, style({ bg: { type: 'rgb', r: 1, g: 2, b: 3 } }))).toBe(`${ESC}[48;2;1;2;3m`);
  });

  it('resets when an attribute is dropped, then restores the rest', () => {
    expect(sgrTransition(style({ bold: true }), DEFAULT_STYLE)).toBe(`${ESC}[0m`);
    expect(sgrTransition(style({ bold: true, italic: true, fg: RED }), style({ italic: true, fg: RED }))).toBe(`${ESC}[0;3;31m`);
    expect(sgrTransition(style({ dim: true }), style({ inverse: true }))).toBe(`${ESC}[0;7m`);
  });
});

describe('renderDiff', () => {
  it('an unchanged frame produces no cell output', () => {
    const a = createFrame(6, 2);
    drawText(a, 0, 0, 'ab中😀', style({ bold: true }));
    const b = structuredClone(a);
    expect(renderDiff(a, b, { x: 3, y: 1, visible: true })).toBe(`${PRE}${ESC}[2;4H${ESC}[?25h${POST}`);
  });

  it('a single changed cell is one cursor move and the cell', () => {
    const a = createFrame(5, 3);
    const b = structuredClone(a);
    drawText(b, 2, 1, 'x');
    expect(renderDiff(a, b, HIDDEN)).toBe(`${PRE}${ESC}[2;3H${ESC}[0mx${ESC}[1;1H${POST}`);
  });

  it('adjacent changes need one move; a gap needs another', () => {
    const a = createFrame(8, 1);
    const b = structuredClone(a);
    drawText(b, 1, 0, 'ab');
    drawText(b, 5, 0, 'c');
    const out = renderDiff(a, b, HIDDEN);
    expect(out).toBe(`${PRE}${ESC}[1;2H${ESC}[0mab${ESC}[1;6Hc${ESC}[1;1H${POST}`);
  });

  it('writes style changes and ends in the default style', () => {
    const a = createFrame(3, 1);
    const b = structuredClone(a);
    drawText(b, 0, 0, 'a', style({ bold: true }));
    drawText(b, 1, 0, 'b', style({ bold: true, fg: RED }));
    drawText(b, 2, 0, 'c');
    expect(renderDiff(a, b, HIDDEN)).toBe(`${PRE}${ESC}[1;1H${ESC}[0;1ma${ESC}[31mb${ESC}[0mc${ESC}[1;1H${POST}`);
  });

  it('writes a wide grapheme once for its two cells', () => {
    const a = createFrame(6, 1);
    const b = structuredClone(a);
    drawText(b, 0, 0, '中x');
    expect(renderDiff(a, b, HIDDEN)).toBe(`${PRE}${ESC}[1;1H${ESC}[0m中x${ESC}[1;1H${POST}`);
  });

  it('repositions after an emoji, whose width terminals may disagree on', () => {
    const a = createFrame(6, 1);
    const b = structuredClone(a);
    drawText(b, 0, 0, '😀x');
    const out = renderDiff(a, b, HIDDEN);
    expect(out).toBe(`${PRE}${ESC}[1;1H${ESC}[0m😀${ESC}[1;3Hx${ESC}[1;1H${POST}`);
    expect(out.split('😀')).toHaveLength(2);
  });

  it('rewrites a wide grapheme when only its continuation changed', () => {
    const a = createFrame(4, 1);
    drawText(a, 0, 0, '中');
    const b = structuredClone(a);
    b.cells[1] = { ...b.cells[1], style: style({ bold: true }) };
    expect(renderDiff(a, b, HIDDEN)).toContain('中');
  });

  it('repaints every cell without a previous frame or after a resize', () => {
    const b = createFrame(2, 2);
    const full = `${PRE}${ESC}[1;1H${ESC}[0m  ${ESC}[2;1H  ${ESC}[1;1H${POST}`;
    expect(renderDiff(null, b, HIDDEN)).toBe(full);
    expect(renderDiff(createFrame(3, 2), b, HIDDEN)).toBe(full);
  });

  it('parks the cursor and shows it only when visible', () => {
    const frame = createFrame(4, 4);
    expect(renderDiff(frame, frame, { x: 2, y: 3, visible: true }).endsWith(`${ESC}[4;3H${ESC}[?25h${POST}`)).toBe(true);
    expect(renderDiff(frame, frame, { x: 2, y: 3, visible: false })).not.toContain(`${ESC}[?25h`);
  });
});

// ── replaying into a terminal emulator ────────────────────────────────────────

/**
 * xterm's built-in Unicode 6 tables count emoji as one column and do not join
 * ZWJ sequences or flags. This provider measures like lib/cellWidth.ts: a ZWJ
 * joins the next code point, a regional indicator pair joins, VS16 and a keycap widen.
 */
const AFTER_ZWJ = 1;
const ODD_FLAG = 2;
const isFlag = (cp: number) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const props = (state: number, width: number, join: boolean) => (state << 3) | ((width & 3) << 1) | (join ? 1 : 0);
const graphemeProvider: IUnicodeVersionProvider = {
  version: 'cellWidth',
  wcwidth: (cp) => codePointWidth(cp),
  charProperties(cp, preceding) {
    const own = codePointWidth(cp);
    const prevWidth = (preceding >> 1) & 3;
    const prevState = preceding >> 3;
    if (preceding !== 0 && prevState === AFTER_ZWJ) return props(cp === 0x200d ? AFTER_ZWJ : 0, prevWidth, true);
    if (preceding !== 0 && prevState === ODD_FLAG && isFlag(cp)) return props(0, 2, true);
    if (own === 0 && prevWidth > 0 && cp >= 0x20) {
      const width = cp === 0xfe0f || cp === 0x20e3 ? 2 : cp === 0xfe0e ? 1 : prevWidth;
      return props(cp === 0x200d ? AFTER_ZWJ : 0, width, true);
    }
    return props(isFlag(cp) ? ODD_FLAG : 0, own, false);
  },
};

function colorOf(isDefault: boolean, isPalette: boolean, isRgb: boolean, value: number): Color {
  if (isPalette) return { type: 'palette', index: value };
  if (isRgb && !isDefault) return { type: 'rgb', r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  return { type: 'default' };
}

function cellOf(cell: IBufferCell): Cell {
  const width = cell.getWidth();
  return {
    text: width === 0 ? '' : (cell.getChars() || ' '),
    width,
    style: {
      bold: Boolean(cell.isBold()), dim: Boolean(cell.isDim()), italic: Boolean(cell.isItalic()),
      underline: Boolean(cell.isUnderline()), blink: Boolean(cell.isBlink()), inverse: Boolean(cell.isInverse()),
      invisible: Boolean(cell.isInvisible()), strikethrough: Boolean(cell.isStrikethrough()),
      fg: colorOf(cell.isFgDefault(), cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor()),
      bg: colorOf(cell.isBgDefault(), cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor()),
    },
  };
}

type Term = InstanceType<typeof Terminal>;
let terms: Term[] = [];
afterEach(() => {
  for (const term of terms) term.dispose();
  terms = [];
});

function terminal(cols: number, rows: number): Term {
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  term.unicode.register(graphemeProvider);
  term.unicode.activeVersion = 'cellWidth';
  terms.push(term);
  return term;
}

const write = (term: Term, data: string) => new Promise<void>((resolve) => term.write(Buffer.from(data, 'utf8'), resolve));

function terminalCells(term: Term): Cell[] {
  const buffer = term.buffer.active;
  const scratch = buffer.getNullCell();
  const cells: Cell[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)!;
    for (let x = 0; x < term.cols; x++) cells.push(cellOf(line.getCell(x, scratch)!));
  }
  return cells;
}

/** Deterministic PRNG (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ['a', 'b', 'Z', ' ', '-', '中', '文', '한', 'Ａ', '😀', '✅', '👨‍👩‍👧', '🇫🇮', '❤️', '1️⃣', 'é', '┊', '…', 'hello', 'ab中'];
const STYLES: CellStyle[] = [
  DEFAULT_STYLE, style({ bold: true }), style({ dim: true, fg: RED }), style({ italic: true, underline: true }),
  style({ inverse: true, bg: { type: 'palette', index: 12 } }), style({ fg: { type: 'rgb', r: 10, g: 200, b: 30 } }),
  style({ strikethrough: true, fg: { type: 'palette', index: 100 } }),
];

/** A frame of random text, or `base` with random edits. */
function generate(rand: () => number, cols: number, rows: number, base?: Frame): Frame {
  const frame = base ? structuredClone(base) : createFrame(cols, rows);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
  const edits = base ? 1 + Math.floor(rand() * 6) : cols * rows;
  for (let i = 0; i < edits; i++) {
    const x = Math.floor(rand() * cols);
    const y = Math.floor(rand() * rows);
    if (rand() < 0.1) fillRect(frame, { x, y, cols: 1 + Math.floor(rand() * 4), rows: 1 + Math.floor(rand() * 2) }, pick(STYLES));
    else drawText(frame, x, y, Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(PIECES)).join(''), pick(STYLES));
  }
  return frame;
}

describe('renderDiff replayed into @xterm/headless', () => {
  it('the test provider measures graphemes like lib/cellWidth', async () => {
    const term = terminal(12, 1);
    await write(term, '👨‍👩‍👧🇫🇮❤️1️⃣é中');
    expect(terminalCells(term).map((cell) => cell.text)).toEqual(['👨‍👩‍👧', '', '🇫🇮', '', '❤️', '', '1️⃣', '', 'é', '中', '', ' ']);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('renderDiff(null, a) then renderDiff(a, b) yields frame b (seed %i)', async (seed) => {
    const rand = random(seed);
    const cols = 6 + Math.floor(rand() * 20);
    const rows = 2 + Math.floor(rand() * 6);
    const term = terminal(cols, rows);
    let prev: Frame | null = null;
    let frame = generate(rand, cols, rows);
    for (let step = 0; step < 6; step++) {
      const cursor = { x: Math.floor(rand() * cols), y: Math.floor(rand() * rows), visible: rand() < 0.5 };
      await write(term, renderDiff(prev, frame, cursor));
      expect(terminalCells(term), `step ${step}`).toEqual(frame.cells);
      expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([cursor.x, cursor.y]);
      prev = frame;
      frame = generate(rand, cols, rows, frame);
    }
  });
});
