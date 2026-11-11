import { describe, expect, it } from 'vitest';
import { blitScreen, cellAt, createFrame, DEFAULT_STYLE, drawText, EDGE_COLUMN, EDGE_ROW, fillRect, slotCursor, type Frame } from './frame.ts';
import { createScreen, type Cell, type CellStyle } from './screen.ts';
import { BUILT_IN_THEMES, DEFAULT_THEME, styleOf } from './theme.ts';

const BOLD: CellStyle = { ...DEFAULT_STYLE, bold: true };

const rowText = (frame: Frame, y: number) =>
  Array.from({ length: frame.cols }, (_, x) => cellAt(frame, x, y)!.text).join('');

/** Every wide cell is followed by a continuation, and every continuation follows a wide cell. */
function expectValid(frame: Frame): void {
  for (let y = 0; y < frame.rows; y++) {
    for (let x = 0; x < frame.cols; x++) {
      const cell = cellAt(frame, x, y)!;
      if (cell.width === 2) expect(cellAt(frame, x + 1, y)?.width, `continuation after ${x},${y}`).toBe(0);
      if (cell.width === 0) expect(cellAt(frame, x - 1, y)?.width, `wide before ${x},${y}`).toBe(2);
    }
  }
}

/** A screen stand-in whose rows are the given strings (one column per character, '中' wide). */
function fakeScreen(lines: string[], cols: number): { cols: number; rows: number; row(y: number): Cell[] } {
  return {
    cols,
    rows: lines.length,
    row(y) {
      const cells: Cell[] = [];
      for (const ch of lines[y] ?? '') {
        if (ch === '中') cells.push({ text: ch, width: 2, style: DEFAULT_STYLE }, { text: '', width: 0, style: DEFAULT_STYLE });
        else cells.push({ text: ch, width: 1, style: DEFAULT_STYLE });
      }
      while (cells.length < cols) cells.push({ text: ' ', width: 1, style: DEFAULT_STYLE });
      return cells.slice(0, cols);
    },
  };
}

describe('createFrame and drawText', () => {
  it('starts blank', () => {
    const frame = createFrame(3, 2);
    expect(frame.cells).toHaveLength(6);
    expect(rowText(frame, 0)).toBe('   ');
  });

  it('draws wide text as a cell and a continuation', () => {
    const frame = createFrame(6, 1);
    expect(drawText(frame, 0, 0, 'a中b', BOLD)).toBe(4);
    expect(frame.cells.slice(0, 4)).toEqual([
      { text: 'a', width: 1, style: BOLD }, { text: '中', width: 2, style: BOLD },
      { text: '', width: 0, style: BOLD }, { text: 'b', width: 1, style: BOLD },
    ]);
    expectValid(frame);
  });

  it('truncates by display width with an ellipsis', () => {
    const frame = createFrame(10, 1);
    expect(drawText(frame, 1, 0, '中文字abc', DEFAULT_STYLE, 5)).toBe(5);
    expect(rowText(frame, 0)).toBe(' 中文…    ');
    const narrow = createFrame(4, 1);
    expect(drawText(narrow, 1, 0, '中文')).toBe(3);
    expect(rowText(narrow, 0)).toBe(' 中…');
    expectValid(narrow);
  });

  it('drops zero-width graphemes and keeps emoji clusters whole', () => {
    const frame = createFrame(6, 1);
    drawText(frame, 0, 0, '\x1b\u0301👨‍👩‍👧x');
    expect(rowText(frame, 0)).toBe('👨‍👩‍👧x   ');
    expectValid(frame);
  });

  it('overwriting half of a wide grapheme blanks its other half', () => {
    const frame = createFrame(5, 1);
    drawText(frame, 0, 0, '中文');
    drawText(frame, 1, 0, 'x');
    expect(rowText(frame, 0)).toBe(' x文 ');
    drawText(frame, 2, 0, 'y');
    expect(rowText(frame, 0)).toBe(' xy  ');
    expectValid(frame);
  });

  it('ignores text outside the frame', () => {
    const frame = createFrame(2, 1);
    expect(drawText(frame, 0, 1, 'a')).toBe(0);
    expect(drawText(frame, 2, 0, 'a')).toBe(0);
    expect(rowText(frame, 0)).toBe('  ');
  });
});

describe('fillRect', () => {
  it('fills the clipped rectangle', () => {
    const frame = createFrame(4, 3);
    fillRect(frame, { x: 2, y: 1, cols: 5, rows: 5 }, BOLD, '#');
    expect([0, 1, 2].map((y) => rowText(frame, y))).toEqual(['    ', '  ##', '  ##']);
    expect(cellAt(frame, 3, 2)!.style).toEqual(BOLD);
  });

  it('cutting a wide grapheme leaves no half glyph', () => {
    const frame = createFrame(4, 1);
    drawText(frame, 0, 0, '中文');
    fillRect(frame, { x: 1, y: 0, cols: 2, rows: 1 });
    expect(rowText(frame, 0)).toBe('    ');
    expectValid(frame);
  });
});

describe('blitScreen', () => {
  it('crops a larger screen', () => {
    const frame = createFrame(5, 3);
    blitScreen(frame, fakeScreen(['abcdefg', 'hijklmn', 'opqrstu', 'vwxyz'], 7), { x: 1, y: 1, cols: 3, rows: 2 });
    expect([0, 1, 2].map((y) => rowText(frame, y))).toEqual(['     ', ' abc ', ' hij ']);
  });

  it('pads a smaller screen with an edge marker column and row', () => {
    const frame = createFrame(5, 4);
    fillRect(frame, { x: 0, y: 0, cols: 5, rows: 4 }, DEFAULT_STYLE, 'x');
    blitScreen(frame, fakeScreen(['ab', 'cd'], 2), { x: 0, y: 0, cols: 4, rows: 4 });
    expect([0, 1, 2, 3].map((y) => rowText(frame, y))).toEqual([
      `ab${EDGE_COLUMN} x`, `cd${EDGE_COLUMN} x`, `${EDGE_ROW}${EDGE_ROW}  x`, '    x',
    ]);
    expect(cellAt(frame, 2, 0)!.style).toEqual(styleOf(DEFAULT_THEME, 'text.edge'));
    expect(cellAt(frame, 0, 2)!.style).toEqual(styleOf(DEFAULT_THEME, 'text.edge'));
    expect(cellAt(frame, 3, 3)!.style).toEqual(DEFAULT_STYLE);
  });

  it('draws the edge marker in the given theme', () => {
    const frame = createFrame(3, 1);
    blitScreen(frame, fakeScreen(['a'], 1), { x: 0, y: 0, cols: 3, rows: 1 }, { theme: BUILT_IN_THEMES.classic });
    expect(cellAt(frame, 1, 0)!.style).toEqual({ ...DEFAULT_STYLE, dim: true });
  });

  it('pads without markers when edge is off', () => {
    const frame = createFrame(3, 2);
    blitScreen(frame, fakeScreen(['a'], 1), { x: 0, y: 0, cols: 3, rows: 2 }, { edge: false });
    expect([rowText(frame, 0), rowText(frame, 1)]).toEqual(['a  ', '   ']);
  });

  it('a wide grapheme cut at the region edge becomes a blank', () => {
    const frame = createFrame(5, 1);
    fillRect(frame, { x: 0, y: 0, cols: 5, rows: 1 }, DEFAULT_STYLE, 'x');
    blitScreen(frame, fakeScreen(['a中b'], 4), { x: 0, y: 0, cols: 2, rows: 1 });
    expect(rowText(frame, 0)).toBe('a xxx');
    expectValid(frame);
  });

  it('copies a real screen model, wide text and style included', async () => {
    const screen = createScreen({ cols: 6, rows: 2, scrollback: 0 });
    try {
      await screen.write('\x1b[1m中\x1b[0mab\r\n😀');
      const frame = createFrame(8, 3);
      blitScreen(frame, screen, { x: 1, y: 0, cols: 7, rows: 3 });
      expect(cellAt(frame, 1, 0)).toEqual({ text: '中', width: 2, style: BOLD });
      expect(cellAt(frame, 2, 0)!.width).toBe(0);
      expect(rowText(frame, 0)).toBe(' 中ab  ' + EDGE_COLUMN);
      expect(rowText(frame, 2)).toBe(' ' + EDGE_ROW.repeat(6) + ' ');
      expectValid(frame);
    } finally {
      screen.dispose();
    }
  });
  it('a wide emoji from a real screen keeps its continuation cell and the next char', async () => {
    const screen = createScreen({ cols: 6, rows: 1, scrollback: 0 });
    try {
      await screen.write('😀x✅y');
      const frame = createFrame(6, 1);
      blitScreen(frame, screen, { x: 0, y: 0, cols: 6, rows: 1 }, { edge: false });
      expect(cellAt(frame, 0, 0)).toMatchObject({ text: '😀', width: 2 });
      expect(cellAt(frame, 1, 0)!.width).toBe(0);
      expect(cellAt(frame, 2, 0)).toMatchObject({ text: 'x', width: 1 });
      expect(cellAt(frame, 3, 0)).toMatchObject({ text: '✅', width: 2 });
      expect(cellAt(frame, 4, 0)!.width).toBe(0);
      expect(cellAt(frame, 5, 0)).toMatchObject({ text: 'y', width: 1 });
      expectValid(frame);
    } finally {
      screen.dispose();
    }
  });
});

describe('slotCursor', () => {
  const region = { x: 34, y: 3, cols: 46, rows: 21 };
  const pane = (x: number, y: number, visible = true, scrollOffset = 0) => ({ cursor: () => ({ x, y, visible }), scrollOffset });

  it('maps the pane-relative cursor into the region', () => {
    expect(slotCursor(pane(0, 0), region, true)).toEqual({ x: 34, y: 3, visible: true });
    expect(slotCursor(pane(45, 20), region, true)).toEqual({ x: 79, y: 23, visible: true });
  });

  it('hides it when it is outside the cropped region', () => {
    expect(slotCursor(pane(46, 0), region, true).visible).toBe(false);
    expect(slotCursor(pane(0, 21), region, true).visible).toBe(false);
  });

  it('hides it while the pane is scrolled back, the program hid it, or the slot has no focus', () => {
    expect(slotCursor(pane(1, 1, true, 5), region, true).visible).toBe(false);
    expect(slotCursor(pane(1, 1, false), region, true).visible).toBe(false);
    expect(slotCursor(pane(1, 1), region, false)).toEqual({ x: 34, y: 3, visible: false });
  });

  it('follows a real screen scrolled back into its scrollback', async () => {
    const screen = createScreen({ cols: 10, rows: 3, scrollback: 20 });
    await screen.write(Array.from({ length: 8 }, (_, i) => `line${i}`).join('\r\n'));
    expect(slotCursor(screen, { x: 0, y: 0, cols: 10, rows: 3 }, true)).toEqual({ x: 5, y: 2, visible: true });
    screen.scroll(-2);
    expect(slotCursor(screen, { x: 0, y: 0, cols: 10, rows: 3 }, true).visible).toBe(false);
    screen.dispose();
  });
});
