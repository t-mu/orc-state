import { afterEach, describe, expect, it } from 'vitest';
import { stringWidth } from '../cellWidth.ts';
import { createScreen, type PaneModes, type Screen } from './screen.ts';

const ESC = '\x1b';
const OFF: PaneModes = {
  alternateOn: false, mouseAny: false, mouseButton: false, mouseStandard: false,
  mouseSgr: false, mouseUtf8: false, keypadCursor: false, cursorVisible: true,
};

let screens: Screen[] = [];
function screen(cols = 20, rows = 5, scrollback = 100): Screen {
  const s = createScreen({ cols, rows, scrollback });
  screens.push(s);
  return s;
}
afterEach(() => {
  for (const s of screens) s.dispose();
  screens = [];
});

const text = (s: Screen, y: number) => s.row(y).map((c) => c.text).join('').trimEnd();

describe('modes from the stream', () => {
  it('reports mouse tracking 1000/1002/1003 and its reset', async () => {
    const s = screen();
    expect(s.modes().mouseTracking).toBe('none');
    await s.write(`${ESC}[?1000h`);
    expect(s.modes().mouseTracking).toBe('vt200');
    await s.write(`${ESC}[?1002h`);
    expect(s.modes().mouseTracking).toBe('drag');
    await s.write(`${ESC}[?1003h`);
    expect(s.modes().mouseTracking).toBe('any');
    await s.write(`${ESC}[?1003l`);
    expect(s.modes().mouseTracking).toBe('none');
  });

  it('reports mouse encoding 1005/1006 and its reset', async () => {
    const s = screen();
    expect(s.modes().mouseEncoding).toBe('default');
    await s.write(`${ESC}[?1005h`);
    expect(s.modes().mouseEncoding).toBe('utf8');
    await s.write(`${ESC}[?1006h`);
    expect(s.modes().mouseEncoding).toBe('sgr');
    await s.write(`${ESC}[?1005l`); // not the current encoding: no change
    expect(s.modes().mouseEncoding).toBe('sgr');
    await s.write(`${ESC}[?1006l`);
    expect(s.modes().mouseEncoding).toBe('default');
  });

  it('reports combined params in one sequence', async () => {
    const s = screen();
    await s.write(`${ESC}[?1003;1006h`);
    expect(s.modes()).toMatchObject({ mouseTracking: 'any', mouseEncoding: 'sgr' });
  });

  it('reports bracketed paste, DECCKM, cursor visibility and the alternate screen', async () => {
    const s = screen();
    expect(s.modes()).toEqual({
      mouseTracking: 'none', mouseEncoding: 'default', bracketedPaste: false,
      applicationCursorKeys: false, cursorVisible: true, alternateScreen: false,
    });
    await s.write(`${ESC}[?2004h${ESC}[?1h${ESC}[?25l${ESC}[?1049h`);
    expect(s.modes()).toMatchObject({ bracketedPaste: true, applicationCursorKeys: true, cursorVisible: false, alternateScreen: true });
    expect(s.cursor().visible).toBe(false);
    await s.write(`${ESC}[?2004l${ESC}[?1l${ESC}[?25h${ESC}[?1049l`);
    expect(s.modes()).toMatchObject({ bracketedPaste: false, applicationCursorKeys: false, cursorVisible: true, alternateScreen: false });
  });

  it('RIS resets tracked modes', async () => {
    const s = screen();
    await s.write(`${ESC}[?1003h${ESC}[?1006h${ESC}[?25l${ESC}c`);
    expect(s.modes()).toMatchObject({ mouseTracking: 'none', mouseEncoding: 'default', cursorVisible: true });
  });

  it('DECSTR shows the cursor and keeps mouse tracking with its encoding', async () => {
    const s = screen();
    await s.write(`${ESC}[?1003h${ESC}[?1006h${ESC}[?25l${ESC}[!p`);
    expect(s.modes()).toMatchObject({ mouseTracking: 'any', mouseEncoding: 'sgr', cursorVisible: true });
  });
});

describe('seeded modes (late attach)', () => {
  it('reports modes seeded before any stream', async () => {
    const s = screen();
    await s.seedModes({ ...OFF, alternateOn: true, mouseAny: true, mouseSgr: true, keypadCursor: true, cursorVisible: false });
    expect(s.modes()).toEqual({
      mouseTracking: 'any', mouseEncoding: 'sgr', bracketedPaste: false,
      applicationCursorKeys: true, cursorVisible: false, alternateScreen: true,
    });
  });

  it('mouseAny alongside a specific flag (tmux mouse_any_flag) seeds that flag, not 1003', async () => {
    const s = screen();
    await s.seedModes({ ...OFF, mouseAny: true, mouseStandard: true });
    expect(s.modes().mouseTracking).toBe('vt200');
    await s.seedModes({ ...OFF, mouseAny: true, mouseButton: true });
    expect(s.modes().mouseTracking).toBe('drag');
  });

  it('seeds button and standard tracking and utf8 encoding', async () => {
    const s = screen();
    await s.seedModes({ ...OFF, mouseButton: true, mouseUtf8: true });
    expect(s.modes()).toMatchObject({ mouseTracking: 'drag', mouseEncoding: 'utf8' });
    await s.seedModes({ ...OFF, mouseStandard: true });
    expect(s.modes()).toMatchObject({ mouseTracking: 'vt200', mouseEncoding: 'default' });
  });

  it('reports a mode reset by the stream after seeding as off', async () => {
    const s = screen();
    await s.seedModes({ ...OFF, alternateOn: true, mouseAny: true, mouseSgr: true, keypadCursor: true, cursorVisible: false });
    await s.write(`${ESC}[?1003l${ESC}[?1006l${ESC}[?1l${ESC}[?25h${ESC}[?1049l`);
    expect(s.modes()).toMatchObject({
      mouseTracking: 'none', mouseEncoding: 'default', applicationCursorKeys: false, cursorVisible: true, alternateScreen: false,
    });
  });

  it('seeding all-off clears earlier modes', async () => {
    const s = screen();
    await s.write(`${ESC}[?1003h${ESC}[?1006h${ESC}[?1h${ESC}[?25l${ESC}[?1049h`);
    await s.seedModes(OFF);
    expect(s.modes()).toMatchObject({
      mouseTracking: 'none', mouseEncoding: 'default', applicationCursorKeys: false, cursorVisible: true, alternateScreen: false,
    });
  });
});

describe('restore', () => {
  it('reproduces styled cells and places the cursor', async () => {
    const s = screen();
    await s.write('old junk everywhere\r\nmore junk');
    await s.restore([`${ESC}[1;31mred${ESC}[0m plain`, `${ESC}[38;2;10;20;30;48;5;200mrgb`], { x: 4, y: 1 });
    expect(text(s, 0)).toBe('red plain');
    expect(text(s, 1)).toBe('rgb');
    expect(text(s, 2)).toBe('');
    const red = s.cell(0, 0)!;
    expect(red.style).toMatchObject({ bold: true, fg: { type: 'palette', index: 1 }, bg: { type: 'default' } });
    expect(s.cell(4, 0)!.style).toMatchObject({ bold: false, fg: { type: 'default' } });
    expect(s.cell(0, 1)!.style).toMatchObject({ fg: { type: 'rgb', r: 10, g: 20, b: 30 }, bg: { type: 'palette', index: 200 } });
    expect(s.cursor()).toEqual({ x: 4, y: 1, visible: true });
  });

  it('reports every attribute', async () => {
    const s = screen();
    await s.restore([`${ESC}[1;2;3;4;5;7;8;9mx`], { x: 0, y: 0 });
    expect(s.cell(0, 0)!.style).toEqual({
      bold: true, dim: true, italic: true, underline: true, blink: true, inverse: true, invisible: true, strikethrough: true,
      fg: { type: 'default' }, bg: { type: 'default' },
    });
  });

  it('does not leak the snapshot style into later output', async () => {
    const s = screen();
    await s.restore([`${ESC}[1mbold`], { x: 0, y: 1 });
    await s.write('next');
    expect(s.cell(0, 1)!.style.bold).toBe(false);
  });
});

describe('cells', () => {
  it('a wide character reports width 2 then 0', async () => {
    const s = screen();
    await s.write('a漢b');
    const row = s.row(0);
    expect(row.slice(0, 4).map((c) => [c.text, c.width])).toEqual([['a', 1], ['漢', 2], ['', 0], ['b', 1]]);
  });

  it('a combining mark stays with its base', async () => {
    const s = screen();
    await s.write('éx');
    expect(s.cell(0, 0)).toMatchObject({ text: 'é', width: 1 });
    expect(s.cell(1, 0)).toMatchObject({ text: 'x', width: 1 });
  });

  it('is undefined or empty outside the viewport', () => {
    const s = screen(20, 5);
    expect(s.cell(20, 0)).toBeUndefined();
    expect(s.cell(0, 5)).toBeUndefined();
    expect(s.cell(-1, 0)).toBeUndefined();
    expect(s.row(5)).toEqual([]);
    expect(s.row(0)).toHaveLength(20);
  });
});

describe('scrollback', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\r\n');

  it('is bounded to the configured line count', async () => {
    const s = screen(20, 5, 10);
    await s.write(lines(100));
    s.scroll(-1000);
    expect(s.scrollOffset).toBe(10);
    expect(text(s, 0)).toBe('line 85');
  });

  it('reading cells honours the scroll offset', async () => {
    const s = screen(20, 5, 100);
    await s.write(lines(20));
    expect(s.scrollOffset).toBe(0);
    expect(text(s, 4)).toBe('line 19');
    s.scroll(-3);
    expect(s.scrollOffset).toBe(3);
    expect(text(s, 0)).toBe('line 12');
    expect(s.cell(5, 4)).toMatchObject({ text: '1' }); // 'line 16'
    s.scroll(1);
    expect(s.scrollOffset).toBe(2);
    s.scrollToBottom();
    expect(s.scrollOffset).toBe(0);
    expect(text(s, 4)).toBe('line 19');
  });
});

describe('resize', () => {
  it('keeps content', async () => {
    const s = screen(20, 5);
    await s.write('hello\r\nworld');
    s.resize(30, 8);
    expect([s.cols, s.rows]).toEqual([30, 8]);
    expect(text(s, 0)).toBe('hello');
    expect(text(s, 1)).toBe('world');
    expect(s.row(0)).toHaveLength(30);
    s.resize(10, 5);
    expect(text(s, 0)).toBe('hello');
    expect(text(s, 1)).toBe('world');
  });
});

describe('cell widths follow lib/cellWidth.ts', () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const HEART_VS16 = cp(0x2764, 0xfe0f);
  const FAMILY = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const FLAG = cp(0x1f1eb, 0x1f1ee);

  it.each([
    ['check mark', 'a✅b', '✅'],
    ['emoji', 'a😀x', '😀'],
    ['CJK', 'a日本', '日'],
    ['heart + VS16', `a${HEART_VS16}x`, HEART_VS16],
    ['ZWJ family', `a${FAMILY}x`, FAMILY],
    ['flag', `a${FLAG}x`, FLAG],
  ])('%s is one 2-column cell and the next char lands where stringWidth says', async (_name, line, wide) => {
    const s = screen();
    await s.write(line);
    expect(s.cell(1, 0)).toMatchObject({ text: wide, width: 2 });
    expect(s.cell(2, 0)).toMatchObject({ text: '', width: 0 });
    const rest = line.slice(1 + wide.length);
    const next = rest[0];
    expect(s.cell(1 + stringWidth(wide), 0)!.text).toBe(next);
    expect(s.cursor().x).toBe(stringWidth(line));
  });

  it('CJK pairs take two cells each', async () => {
    const s = screen();
    await s.write('日本x');
    expect(s.row(0).slice(0, 5).map((c) => [c.text, c.width])).toEqual([['日', 2], ['', 0], ['本', 2], ['', 0], ['x', 1]]);
  });

  it('absolute cursor moves after an emoji land on the right cell', async () => {
    const s = screen();
    await s.write(`😀ab${ESC}[1;6HZ${ESC}[5GY`);
    expect(text(s, 0)).toBe('😀abYZ');
    expect(s.cell(4, 0)!.text).toBe('Y');
    expect(s.cell(5, 0)!.text).toBe('Z');
  });
});
