import { describe, expect, it } from 'vitest';
import { TerminalMouseFilter } from './terminalMouseFilter.ts';

const once = (text: string): string => new TerminalMouseFilter().filter(text);

describe('TerminalMouseFilter', () => {
  it('removes mouse mode set and reset sequences, also compound ones', () => {
    for (const final of ['h', 'l']) {
      expect(once(`a\x1b[?1000${final}b\x1b[?1003${final}c\x1b[?1006${final}d`)).toBe('abcd');
      expect(once(`a\x1b[?1003;1006${final}b`)).toBe('ab');
      expect(once(`\x1b[?9${final}\x1b[?1001;1002;1005;1015;1016${final}`)).toBe('');
    }
  });

  it('keeps the non-mouse modes of a compound sequence', () => {
    expect(once('\x1b[?25;1000h')).toBe('\x1b[?25h');
    expect(once('\x1b[?1000;25;1006l')).toBe('\x1b[?25l');
  });

  it('leaves other modes, colors and text unchanged', () => {
    const text = '\x1b[?1049h\x1b[?2004h\x1b[31mred\x1b[0m \x1b[?10000h \x1b[1000h é\x1b[?1049l';
    expect(once(text)).toBe(text);
  });

  it('removes a mouse mode sequence split across two chunks at any position', () => {
    const sequence = '\x1b[?1003;1006h';
    const input = `ab${sequence}cd`;
    for (let at = 0; at <= input.length; at++) {
      const filter = new TerminalMouseFilter();
      expect(filter.filter(input.slice(0, at)) + filter.filter(input.slice(at))).toBe('abcd');
    }
  });

  it('passes a non-mouse sequence split across two chunks through intact', () => {
    for (const input of ['ab\x1b[?1049hcd', 'ab\x1b[?25;1000hcd', 'ab\x1b[38;5;1mcd']) {
      const expected = input.replace(';1000', '');
      for (let at = 0; at <= input.length; at++) {
        const filter = new TerminalMouseFilter();
        expect(filter.filter(input.slice(0, at)) + filter.filter(input.slice(at))).toBe(expected);
      }
    }
  });

  it('does not hold back more than a bounded tail', () => {
    const filter = new TerminalMouseFilter();
    const long = `\x1b[?${'1;'.repeat(40)}`;
    expect(filter.filter(long)).toBe(long);
  });
});
