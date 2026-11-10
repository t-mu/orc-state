import { describe, expect, it } from 'vitest';
import { isMouseInput, parseClicks, parseSgrMouse } from './mouse.ts';

describe('SGR mouse reports', () => {
  it('parses presses and releases with 0-based pane coordinates, several per chunk', () => {
    expect(parseSgrMouse('\u001B[<0;5;3M\u001B[<0;5;3m')).toEqual([
      { button: 0, x: 4, y: 2, release: false },
      { button: 0, x: 4, y: 2, release: true },
    ]);
    expect(parseSgrMouse('\u001B[<64;1;10M')).toEqual([{ button: 64, x: 0, y: 9, release: false }]);
    expect(parseSgrMouse('j')).toEqual([]);
  });

  it('counts only plain left presses as clicks', () => {
    // A press and its release; a right click; a ctrl-click; a wheel turn; a drag.
    const data = '\u001B[<0;2;7M\u001B[<0;2;7m\u001B[<2;1;1M\u001B[<16;1;1M\u001B[<64;1;1M\u001B[<32;1;1M';
    expect(parseClicks(data)).toEqual([{ x: 1, y: 6 }]);
  });

  it('tells a mouse report from a key, as useInput passes it (ESC stripped)', () => {
    expect(isMouseInput('[<0;2;7M')).toBe(true);
    expect(isMouseInput('\u001B[<0;2;7m')).toBe(true);
    expect(isMouseInput('[A')).toBe(false);
    expect(isMouseInput('j')).toBe(false);
  });
});
