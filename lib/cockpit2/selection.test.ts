import { describe, expect, it } from 'vitest';
import { blitScreen, createFrame } from './frame.ts';
import { createScreen, type Screen } from './screen.ts';
import { highlightSelection, osc52, selectionRange, selectionText } from './selection.ts';

async function screenOf(cols: number, rows: number, text: string): Promise<Screen> {
  const screen = createScreen({ cols, rows, scrollback: 0 });
  await screen.write(text);
  return screen;
}

const sel = (ax: number, ay: number, hx: number, hy: number) => ({ anchor: { x: ax, y: ay }, head: { x: hx, y: hy } });

describe('selectionText', () => {
  it('takes cells in reading order whichever way the drag went', async () => {
    const screen = await screenOf(20, 3, 'hello world\r\nsecond line');
    expect(selectionText(screen, sel(0, 0, 4, 0))).toBe('hello');
    expect(selectionText(screen, sel(4, 0, 0, 0))).toBe('hello');
    expect(selectionText(screen, sel(6, 0, 5, 1))).toBe('world\nsecond');
    expect(selectionText(screen, sel(5, 1, 6, 0))).toBe('world\nsecond');
  });

  it('drops trailing blanks at hard row ends and when the selection runs past the last text', async () => {
    const screen = await screenOf(20, 3, 'ab\r\ncd');
    expect(selectionText(screen, sel(0, 0, 19, 1))).toBe('ab\ncd');
    expect(selectionText(screen, sel(0, 0, 19, 2))).toBe('ab\ncd\n');
    // Blanks inside the selection on its last row are kept.
    expect(selectionText(screen, sel(0, 1, 3, 1))).toBe('cd  ');
  });

  it('joins soft-wrapped rows into one line', async () => {
    const screen = await screenOf(5, 4, 'abcdefghijkl\r\nnext');
    expect(screen.wrapped(1)).toBe(true);
    expect(selectionText(screen, sel(0, 0, 4, 3))).toBe('abcdefghijkl\nnext');
    expect(selectionText(screen, sel(3, 0, 1, 1))).toBe('defg');
  });

  it('selects whole wide characters from either half, and keeps them across a wrap', async () => {
    const screen = await screenOf(6, 3, '日本語\r\nx漢字y');
    // Starting on the right half of 日, ending on the left half of 本.
    expect(selectionText(screen, sel(1, 0, 2, 0))).toBe('日本');
    expect(selectionRange(screen, sel(1, 0, 2, 0))).toEqual({ start: { x: 0, y: 0 }, end: { x: 3, y: 0 } });
    expect(selectionText(screen, sel(2, 1, 3, 1))).toBe('漢字');
    // abcd + 漢 does not fit in 5 columns: 漢 wraps and the blank it left is not text.
    const wrapped = await screenOf(5, 3, 'abcd漢字');
    expect(wrapped.wrapped(1)).toBe(true);
    expect(selectionText(wrapped, sel(0, 0, 4, 1))).toBe('abcd漢字');
  });

  it('clamps points outside the viewport', async () => {
    const screen = await screenOf(4, 2, 'abcd');
    expect(selectionText(screen, sel(-3, -1, 9, 0))).toBe('abcd');
  });
});

describe('highlightSelection', () => {
  it('inverts the selected cells of the blitted screen, both halves of a wide character', async () => {
    const screen = await screenOf(6, 2, 'ab日c\r\nxyz');
    const frame = createFrame(10, 4);
    const region = { x: 2, y: 1, cols: 8, rows: 3 };
    blitScreen(frame, screen, region);
    highlightSelection(frame, region, screen, sel(1, 0, 2, 0));
    const inverse = (y: number) => Array.from({ length: frame.cols }, (_, x) => (frame.cells[y * frame.cols + x].style.inverse ? 1 : 0)).join('');
    expect(inverse(1)).toBe('0001110000');
    expect(inverse(2)).toBe('0000000000');
    blitScreen(frame, screen, region);
    highlightSelection(frame, region, screen, sel(4, 0, 0, 1));
    expect(inverse(1)).toBe('0000001100');
    expect(inverse(2)).toBe('0010000000');
  });
});

describe('osc52', () => {
  it('puts the exact UTF-8 text on the clipboard, base64-encoded', () => {
    const text = 'a 日本\nwrap ✓';
    const sequence = osc52(text);
    expect(sequence.startsWith('\x1b]52;c;')).toBe(true);
    expect(sequence.endsWith('\x07')).toBe(true);
    expect(Buffer.from(sequence.slice(7, -1), 'base64').toString('utf8')).toBe(text);
  });
});
