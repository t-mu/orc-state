import { describe, expect, it } from 'vitest';
import { codePointWidth, fitToWidth, graphemes, graphemeWidth, padToWidth, stringWidth } from './cellWidth.ts';

describe('stringWidth', () => {
  it.each([
    ['ASCII', 'hello', 5],
    ['CJK', '中文字', 6],
    ['Hangul', '한국어', 6],
    ['Hangul jamo sequence', '각', 2],
    ['fullwidth forms', 'ＡＢ！', 6],
    ['halfwidth katakana', 'ｱｲ', 2],
    ['single emoji', '😀', 2],
    ['emoji presentation in the BMP', '✅⌚', 4],
    ['ZWJ family', '👨‍👩‍👧‍👦', 2],
    ['flag', '🇫🇮', 2],
    ['keycap', '#️⃣1️⃣', 4],
    ['VS16 makes a text-default symbol emoji', '❤️', 2],
    ['text-default symbol', '❤', 1],
    ['VS15 keeps text presentation', '☺︎', 1],
    ['skin tone modifier', '👍🏽', 2],
    ['combining marks', 'éä', 2],
    ['zero-width joiner and space', 'a‍b​', 2],
    ['control bytes', '\x1b\x07\t\x7f\x9b', 0],
    ['mixed', 'a中😀b', 6],
  ])('%s', (_name, text, width) => {
    expect(stringWidth(text)).toBe(width);
  });
});

describe('graphemes and their width', () => {
  it('splits a ZWJ sequence, flag and combining sequence as one grapheme each', () => {
    expect(graphemes('👨‍👩‍👧a🇫🇮é')).toEqual(['👨‍👩‍👧', 'a', '🇫🇮', 'é']);
  });

  it('a lone combining mark or control is 0 wide', () => {
    expect(graphemeWidth('́')).toBe(0);
    expect(graphemeWidth('\x00')).toBe(0);
    expect(graphemeWidth('')).toBe(0);
  });

  it('code point widths', () => {
    expect(codePointWidth(0x41)).toBe(1);
    expect(codePointWidth(0x4e2d)).toBe(2);
    expect(codePointWidth(0x200d)).toBe(0);
    expect(codePointWidth(0xfe0f)).toBe(0);
    expect(codePointWidth(0x1f600)).toBe(2);
    expect(codePointWidth(0x2500)).toBe(1);
  });
});

describe('fitToWidth and padToWidth', () => {
  it('leaves text that fits', () => {
    expect(fitToWidth('abc', 3)).toBe('abc');
    expect(fitToWidth('中文', 4)).toBe('中文');
  });

  it('cuts with an ellipsis by display width', () => {
    expect(fitToWidth('abcdef', 4)).toBe('abc…');
    expect(fitToWidth('abcdef', 1)).toBe('…');
    expect(fitToWidth('abcdef', 0)).toBe('');
  });

  it('never splits a wide grapheme', () => {
    expect(fitToWidth('a中文', 4)).toBe('a中…');
    expect(fitToWidth('中文字', 4)).toBe('中…');
    expect(stringWidth(fitToWidth('中文字', 4))).toBe(3);
    expect(fitToWidth('👨‍👩‍👧x', 2)).toBe('…');
    for (let cols = 0; cols < 10; cols++) expect(stringWidth(fitToWidth('a中😀🇫🇮b文', cols))).toBeLessThanOrEqual(cols);
  });

  it('pads to exactly the width', () => {
    expect(padToWidth('中', 3)).toBe('中 ');
    expect(padToWidth('中文字', 4)).toBe('中… ');
    expect(stringWidth(padToWidth('😀abc', 8))).toBe(8);
  });
});
