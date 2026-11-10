import { describe, expect, it } from 'vitest';
import { createTokenizer, type Token } from './input.ts';
import { appWants, encodeMouse, parseSgrMouse, type MouseButton, type MouseEvent, type MouseMode } from './mouse.ts';

const token = (text: string): Token => {
  const tokens = createTokenizer().push(Buffer.from(text, 'latin1'));
  expect(tokens).toHaveLength(1);
  return tokens[0];
};

const event = (fields: Partial<MouseEvent>): MouseEvent => ({
  button: 'left', shift: false, alt: false, ctrl: false, motion: false, release: false, x: 0, y: 0, ...fields,
});

const BUTTON_CODES: [MouseButton, number][] = [
  ['left', 0], ['middle', 1], ['right', 2], ['none', 3],
  ['wheelUp', 64], ['wheelDown', 65], ['wheelLeft', 66], ['wheelRight', 67],
  ['button8', 128], ['button9', 129], ['button10', 130], ['button11', 131],
];

describe('parseSgrMouse', () => {
  it.each(BUTTON_CODES)('parses %s (code %i)', (button, code) => {
    expect(parseSgrMouse(token(`\x1b[<${code};1;1M`))).toEqual(event({ button }));
  });

  it('parses modifiers, motion, release and 0-based cells', () => {
    expect(parseSgrMouse(token('\x1b[<4;10;20M'))).toEqual(event({ shift: true, x: 9, y: 19 }));
    expect(parseSgrMouse(token('\x1b[<8;1;1M'))).toEqual(event({ alt: true }));
    expect(parseSgrMouse(token('\x1b[<16;1;1M'))).toEqual(event({ ctrl: true }));
    expect(parseSgrMouse(token('\x1b[<93;1;1M'))).toEqual(event({ button: 'wheelDown', ctrl: true, alt: true, shift: true }));
    expect(parseSgrMouse(token('\x1b[<32;5;6M'))).toEqual(event({ motion: true, x: 4, y: 5 }));
    expect(parseSgrMouse(token('\x1b[<35;300;2M'))).toEqual(event({ button: 'none', motion: true, x: 299, y: 1 }));
    expect(parseSgrMouse(token('\x1b[<2;3;4m'))).toEqual(event({ button: 'right', release: true, x: 2, y: 3 }));
  });

  it('returns null for other tokens and malformed reports', () => {
    expect(parseSgrMouse(token('\x1b[A'))).toBeNull();
    expect(parseSgrMouse(token('a'))).toBeNull();
    expect(parseSgrMouse(token('\x1b[<0;0;1M'))).toBeNull();
    expect(parseSgrMouse(token('\x1b[<0;1M'))).toBeNull();
    expect(parseSgrMouse(token('\x1b[<192;1;1M'))).toBeNull();
  });
});

describe('appWants', () => {
  const EVENTS: Record<string, MouseEvent> = {
    press: event({}),
    wheel: event({ button: 'wheelUp' }),
    release: event({ release: true }),
    wheelRelease: event({ button: 'wheelUp', release: true }),
    drag: event({ motion: true }),
    move: event({ button: 'none', motion: true }),
    pressNone: event({ button: 'none' }),
  };
  const EXPECTED: Record<MouseMode, string[]> = {
    none: [],
    x10: ['press', 'wheel'],
    vt200: ['press', 'wheel', 'release'],
    drag: ['press', 'wheel', 'release', 'drag'],
    any: ['press', 'wheel', 'release', 'drag', 'move'],
  };

  it.each(Object.keys(EXPECTED) as MouseMode[])('mode %s gets the events xterm sends in it', (mode) => {
    const wanted = Object.entries(EVENTS).filter(([, value]) => appWants(value, mode)).map(([name]) => name);
    expect(wanted).toEqual(EXPECTED[mode]);
  });
});

describe('encodeMouse', () => {
  const pane = { x: 10, y: 5, width: 80, height: 24 };
  const latin1 = (buffer: Buffer) => buffer.toString('latin1');

  it('encodes SGR relative to the pane, keeping the button on release', () => {
    expect(latin1(encodeMouse(event({ x: 12, y: 7 }), 'sgr', pane))).toBe('\x1b[<0;3;3M');
    expect(latin1(encodeMouse(event({ button: 'right', release: true, x: 10, y: 5 }), 'sgr', pane))).toBe('\x1b[<2;1;1m');
    expect(latin1(encodeMouse(event({ button: 'wheelDown', ctrl: true, shift: true, alt: true, x: 11, y: 5 }), 'sgr', pane))).toBe('\x1b[<93;2;1M');
    expect(latin1(encodeMouse(event({ button: 'none', motion: true, x: 10, y: 5 }), 'sgr', pane))).toBe('\x1b[<35;1;1M');
    expect(latin1(encodeMouse(event({ button: 'button9', x: 10, y: 5 }), 'sgr', pane))).toBe('\x1b[<129;1;1M');
  });

  it('round-trips every button through parseSgrMouse', () => {
    for (const [button] of BUTTON_CODES) {
      const original = event({ button, shift: true, motion: true, x: 15, y: 9 });
      const encoded = encodeMouse(original, 'sgr', { x: 0, y: 0, width: 100, height: 50 });
      expect(parseSgrMouse(token(latin1(encoded)))).toEqual(original);
    }
  });

  it('clamps cells outside the pane to its edges', () => {
    expect(latin1(encodeMouse(event({ x: 2, y: 1 }), 'sgr', pane))).toBe('\x1b[<0;1;1M');
    expect(latin1(encodeMouse(event({ x: 500, y: 500 }), 'sgr', pane))).toBe('\x1b[<0;80;24M');
  });

  it('encodes the default X10 bytes, a release as button 3, and caps coordinates at 223', () => {
    expect([...encodeMouse(event({ x: 12, y: 7 }), 'default', pane)]).toEqual([0x1b, 0x5b, 0x4d, 32, 35, 35]);
    expect([...encodeMouse(event({ button: 'right', release: true, ctrl: true, x: 10, y: 5 }), 'default', pane)]).toEqual([0x1b, 0x5b, 0x4d, 32 + 3 + 16, 33, 33]);
    expect([...encodeMouse(event({ button: 'wheelUp', x: 10, y: 5 }), 'default', pane)]).toEqual([0x1b, 0x5b, 0x4d, 32 + 64, 33, 33]);
    expect([...encodeMouse(event({ button: 'left', motion: true, x: 10, y: 5 }), 'default', pane)]).toEqual([0x1b, 0x5b, 0x4d, 32 + 32, 33, 33]);
    const wide = { x: 0, y: 0, width: 400, height: 300 };
    expect([...encodeMouse(event({ x: 222, y: 221 }), 'default', wide)]).toEqual([0x1b, 0x5b, 0x4d, 32, 255, 254]);
    expect([...encodeMouse(event({ x: 350, y: 299 }), 'default', wide)]).toEqual([0x1b, 0x5b, 0x4d, 32, 255, 255]);
  });

  it('encodes UTF-8 (1005) values above 127 as two bytes and caps coordinates at 2015', () => {
    const wide = { x: 0, y: 0, width: 3000, height: 3000 };
    expect([...encodeMouse(event({ x: 9, y: 4 }), 'utf8', wide)]).toEqual([0x1b, 0x5b, 0x4d, 32, 42, 37]);
    // x 200 (1-based 201) → value 233 → C3 A9.
    expect([...encodeMouse(event({ x: 200, y: 0 }), 'utf8', wide)]).toEqual([0x1b, 0x5b, 0x4d, 32, 0xc3, 0xa9, 33]);
    expect(encodeMouse(event({ x: 2500, y: 2500 }), 'utf8', wide).toString('utf8')).toBe(`\x1b[M ${String.fromCodePoint(2047)}${String.fromCodePoint(2047)}`);
    expect(encodeMouse(event({ button: 'button8', release: true, x: 0, y: 0 }), 'utf8', wide).toString('utf8')).toBe('\x1b[M#!!');
    expect(encodeMouse(event({ button: 'button8', x: 0, y: 0 }), 'utf8', wide).toString('utf8')).toBe(`\x1b[M${String.fromCodePoint(160)}!!`);
  });

  it('leaves the modifiers out in x10 mode', () => {
    const modified = event({ shift: true, alt: true, ctrl: true, x: 10, y: 5 });
    expect(latin1(encodeMouse(modified, 'sgr', pane, 'x10'))).toBe('\x1b[<0;1;1M');
    expect([...encodeMouse(modified, 'default', pane, 'x10')]).toEqual([0x1b, 0x5b, 0x4d, 32, 33, 33]);
    expect(latin1(encodeMouse(modified, 'sgr', pane))).toBe('\x1b[<28;1;1M');
  });
});
