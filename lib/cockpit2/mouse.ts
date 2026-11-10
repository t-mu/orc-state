/**
 * lib/cockpit2/mouse.ts
 *
 * Mouse reports from the real terminal (SGR, mode 1006) → events, which events
 * a pane's app asked for (xterm modes 9/1000/1002/1003), and events → the bytes
 * that app expects (SGR 1006, UTF-8 1005 or the default X10 encoding), with
 * coordinates relative to the pane. Pure.
 */
import type { Token } from './input.ts';

export type MouseButton =
  | 'left' | 'middle' | 'right' | 'none'
  | 'wheelUp' | 'wheelDown' | 'wheelLeft' | 'wheelRight'
  | 'button8' | 'button9' | 'button10' | 'button11';

export interface MouseEvent {
  button: MouseButton;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  /** Pointer motion (with `button` held, or `none`). */
  motion: boolean;
  release: boolean;
  /** 0-based screen cell. */
  x: number;
  y: number;
}

/** What a pane's app asked for: none, X10 (9), VT200 / normal (1000), button-event (1002), any-event (1003). */
export type MouseMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any';
/** How it wants reports encoded: SGR (1006), UTF-8 (1005) or the default X10 bytes. */
export type MouseEncoding = 'sgr' | 'utf8' | 'default';

/** The pane's screen rectangle (0-based cells); events are translated into it and clamped to it. */
export interface PaneOrigin { x: number; y: number; width: number; height: number }

const BUTTONS: MouseButton[] = [
  'left', 'middle', 'right', 'none',
  'wheelUp', 'wheelDown', 'wheelLeft', 'wheelRight',
  'button8', 'button9', 'button10', 'button11',
];

const SHIFT = 4;
const ALT = 8;
const CTRL = 16;
const MOTION = 32;

/** The report code of `button`: 0-3, the wheel group from 64, the extra buttons from 128. */
function buttonCode(button: MouseButton): number {
  const index = BUTTONS.indexOf(button);
  return [0, 64, 128][index >> 2] + (index & 3);
}

/** An SGR report (`ESC [ < b ; x ; y M|m`) as an event; null for any other token or a malformed report. */
export function parseSgrMouse(token: Token): MouseEvent | null {
  if (token.kind !== 'mouse') return null;
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(token.raw.toString('latin1'));
  if (!match) return null;
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (x < 1 || y < 1) return null;
  const group = code & 64 ? 1 : code & 128 ? 2 : 0;
  if ((code & 192) === 192) return null;
  return {
    button: BUTTONS[group * 4 + (code & 3)],
    shift: (code & SHIFT) !== 0,
    alt: (code & ALT) !== 0,
    ctrl: (code & CTRL) !== 0,
    motion: (code & MOTION) !== 0,
    release: match[4] === 'm',
    x: x - 1,
    y: y - 1,
  };
}

/**
 * Whether an app in `mode` gets `event`, per xterm: x10 only presses; vt200
 * presses and releases (no wheel release); drag adds motion with a button held; any adds all motion.
 */
export function appWants(event: MouseEvent, mode: MouseMode): boolean {
  if (mode === 'none') return false;
  if (event.motion) return mode === 'any' || (mode === 'drag' && event.button !== 'none');
  // xterm reports no wheel release.
  if (event.release) return mode !== 'x10' && !event.button.startsWith('wheel');
  return event.button !== 'none';
}

/** UTF-8 bytes of one code point (mode 1005 encodes each value this way). */
function utf8Value(value: number): number[] {
  return value < 0x80 ? [value] : [0xc0 | (value >> 6), 0x80 | (value & 0x3f)];
}

/**
 * `event` as the bytes an app expects, its cell made relative to `origin` and
 * clamped into it. The default and UTF-8 encodings report a release as button
 * 3 and cap coordinates (223 and 2015, 1-based); in `x10` mode the modifiers
 * are left out, as xterm does.
 */
export function encodeMouse(event: MouseEvent, encoding: MouseEncoding, origin: PaneOrigin, mode: MouseMode = 'any'): Buffer {
  const clamp = (value: number, size: number) => Math.min(Math.max(value, 0), Math.max(size - 1, 0));
  const x = clamp(event.x - origin.x, origin.width) + 1;
  const y = clamp(event.y - origin.y, origin.height) + 1;
  let code = buttonCode(event.button);
  if (mode !== 'x10') code += (event.shift ? SHIFT : 0) + (event.alt ? ALT : 0) + (event.ctrl ? CTRL : 0);
  if (event.motion) code += MOTION;
  if (encoding === 'sgr') return Buffer.from(`\x1b[<${code};${x};${y}${event.release ? 'm' : 'M'}`, 'latin1');
  if (event.release) code = (code & ~(3 | 64 | 128)) | 3;
  const prefix = [0x1b, 0x5b, 0x4d];
  if (encoding === 'utf8') return Buffer.from([...prefix, ...utf8Value(32 + code), ...utf8Value(32 + Math.min(x, 2015)), ...utf8Value(32 + Math.min(y, 2015))]);
  return Buffer.from([...prefix, 32 + code, 32 + Math.min(x, 223), 32 + Math.min(y, 223)]);
}
