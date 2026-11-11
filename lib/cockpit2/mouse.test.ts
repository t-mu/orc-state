import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTokenizer, type Token } from './input.ts';
import { appWants, createMotionCoalescer, encodeMouse, parseSgrMouse, routeSlotMouse, type MouseButton, type MouseEvent } from './mouse.ts';
import type { MouseTracking } from './screen.ts';

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
  const EXPECTED: Record<MouseTracking, string[]> = {
    none: [],
    x10: ['press', 'wheel'],
    vt200: ['press', 'wheel', 'release'],
    drag: ['press', 'wheel', 'release', 'drag'],
    any: ['press', 'wheel', 'release', 'drag', 'move'],
  };

  it.each(Object.keys(EXPECTED) as MouseTracking[])('mode %s gets the events xterm sends in it', (mode) => {
    const wanted = Object.entries(EVENTS).filter(([, value]) => appWants(value, mode)).map(([name]) => name);
    expect(wanted).toEqual(EXPECTED[mode]);
  });
});

describe('encodeMouse', () => {
  const pane = { x: 10, y: 5, cols: 80, rows: 24 };
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
      const encoded = encodeMouse(original, 'sgr', { x: 0, y: 0, cols: 100, rows: 50 });
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
    const wide = { x: 0, y: 0, cols: 400, rows: 300 };
    expect([...encodeMouse(event({ x: 222, y: 221 }), 'default', wide)]).toEqual([0x1b, 0x5b, 0x4d, 32, 255, 254]);
    expect([...encodeMouse(event({ x: 350, y: 299 }), 'default', wide)]).toEqual([0x1b, 0x5b, 0x4d, 32, 255, 255]);
  });

  it('encodes UTF-8 (1005) values above 127 as two bytes and caps coordinates at 2015', () => {
    const wide = { x: 0, y: 0, cols: 3000, rows: 3000 };
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

describe('routeSlotMouse', () => {
  const app = (tracking: MouseTracking, extra: Partial<{ viewOnly: boolean; selecting: boolean }> = {}) =>
    ({ tracking, viewOnly: false, selecting: false, ...extra });
  const press = event({});
  const drag = event({ motion: true });
  const release = event({ release: true });
  const wheelUp = event({ button: 'wheelUp' });
  const wheelDown = event({ button: 'wheelDown' });
  const move = event({ button: 'none', motion: true });

  it('forwards what the app\'s mode wants and drops the rest while the app has the mouse', () => {
    expect([press, drag, release, wheelUp, move].map((e) => routeSlotMouse(e, app('any')))).toEqual(['forward', 'forward', 'forward', 'forward', 'forward']);
    expect([press, drag, release, wheelUp, move].map((e) => routeSlotMouse(e, app('drag')))).toEqual(['forward', 'forward', 'forward', 'forward', 'drop']);
    expect([press, drag, release, wheelUp, move].map((e) => routeSlotMouse(e, app('vt200')))).toEqual(['forward', 'drop', 'forward', 'forward', 'drop']);
    expect([press, drag, release, wheelUp, move].map((e) => routeSlotMouse(e, app('x10')))).toEqual(['forward', 'drop', 'drop', 'forward', 'drop']);
  });

  it('gives the wheel to the cockpit scrollback and a left drag to the selection when the app did not ask for the mouse', () => {
    expect([wheelUp, wheelDown, press, drag, release, move].map((e) => routeSlotMouse(e, app('none'))))
      .toEqual(['scrollUp', 'scrollDown', 'selectStart', 'drop', 'drop', 'drop']);
    expect(routeSlotMouse(event({ button: 'right' }), app('none'))).toBe('drop');
    expect(routeSlotMouse(event({ button: 'wheelUp', release: true }), app('none'))).toBe('drop');
  });

  it('keeps a selection drag\'s motion and release with the cockpit', () => {
    expect(routeSlotMouse(drag, app('none', { selecting: true }))).toBe('selectExtend');
    expect(routeSlotMouse(release, app('none', { selecting: true }))).toBe('selectEnd');
    // Even when the app turned its mouse mode on, or Shift was let go, mid-drag.
    expect(routeSlotMouse(drag, app('any', { selecting: true }))).toBe('selectExtend');
    expect(routeSlotMouse(release, app('any', { selecting: true }))).toBe('selectEnd');
  });

  it('gives Shift-held events to the cockpit even when the app wants the mouse', () => {
    const shifted = (e: MouseEvent) => ({ ...e, shift: true });
    expect([press, wheelUp, wheelDown, move].map((e) => routeSlotMouse(shifted(e), app('any')))).toEqual(['selectStart', 'scrollUp', 'scrollDown', 'drop']);
  });

  it('forwards nothing from a view-only tab: the cockpit scrolls and selects there', () => {
    for (const tracking of ['x10', 'vt200', 'drag', 'any'] as const) {
      expect([press, drag, release, wheelUp, move].map((e) => routeSlotMouse(e, app(tracking, { viewOnly: true })))).not.toContain('forward');
    }
    expect(routeSlotMouse(wheelUp, app('any', { viewOnly: true }))).toBe('scrollUp');
    expect(routeSlotMouse(press, app('any', { viewOnly: true }))).toBe('selectStart');
  });
});

describe('createMotionCoalescer', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('sends at most one motion per interval, the latest, and flushes it before a press or release', () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const coalescer = createMotionCoalescer((bytes) => sent.push(bytes.toString()), 16);
    coalescer.push(Buffer.from('m1'), true);
    coalescer.push(Buffer.from('m2'), true);
    coalescer.push(Buffer.from('m3'), true);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(sent).toEqual(['m3']);
    coalescer.push(Buffer.from('m4'), true);
    coalescer.push(Buffer.from('release'), false);
    expect(sent).toEqual(['m3', 'm4', 'release']);
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['m3', 'm4', 'release']);
    coalescer.push(Buffer.from('press'), false);
    expect(sent.at(-1)).toBe('press');
    coalescer.push(Buffer.from('m5'), true);
    coalescer.cancel();
    vi.advanceTimersByTime(50);
    expect(sent).toEqual(['m3', 'm4', 'release', 'press']);
  });
});
