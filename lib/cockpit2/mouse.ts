/**
 * lib/cockpit2/mouse.ts
 *
 * Mouse reports from the real terminal (SGR, mode 1006) → events, which events
 * a pane's app asked for (xterm modes 9/1000/1002/1003), and events → the bytes
 * that app expects (SGR 1006, UTF-8 1005 or the default X10 encoding), with
 * coordinates relative to the pane. `routeSlotMouse` decides who gets an event
 * in the slot: the pane's app, or the cockpit's scrollback and selection.
 * Pure, apart from the motion coalescer's timer.
 */
import type { Region } from './frame.ts';
import type { Token } from './input.ts';
import type { MouseEncoding, MouseTracking } from './screen.ts';

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
 * Whether an app in `mode` (none, X10 9, VT200 1000, button-event 1002,
 * any-event 1003) gets `event`, per xterm: x10 only presses; vt200
 * presses and releases (no wheel release); drag adds motion with a button held; any adds all motion.
 */
export function appWants(event: MouseEvent, mode: MouseTracking): boolean {
  if (mode === 'none') return false;
  if (event.motion) return mode === 'any' || (mode === 'drag' && event.button !== 'none');
  // xterm reports no wheel release.
  if (event.release) return mode !== 'x10' && !event.button.startsWith('wheel');
  return event.button !== 'none';
}

/** `value` clamped into 0..size-1 (0 for an empty size). */
const clamp = (value: number, size: number) => Math.min(Math.max(value, 0), Math.max(size - 1, 0));

/** UTF-8 bytes of one code point (mode 1005 encodes each value this way). */
function utf8Value(value: number): number[] {
  return value < 0x80 ? [value] : [0xc0 | (value >> 6), 0x80 | (value & 0x3f)];
}

/**
 * `event` as the bytes an app expects (SGR 1006, UTF-8 1005 or the default X10
 * bytes), its cell made relative to the pane's `region` and clamped into it. The default and UTF-8 encodings report a release as button
 * 3 and cap coordinates (223 and 2015, 1-based); in `x10` mode the modifiers
 * are left out, as xterm does.
 */
export function encodeMouse(event: MouseEvent, encoding: MouseEncoding, region: Region, mode: MouseTracking = 'any'): Buffer {
  const x = clamp(event.x - region.x, region.cols) + 1;
  const y = clamp(event.y - region.y, region.rows) + 1;
  let code = buttonCode(event.button);
  if (mode !== 'x10') code += (event.shift ? SHIFT : 0) + (event.alt ? ALT : 0) + (event.ctrl ? CTRL : 0);
  if (event.motion) code += MOTION;
  if (encoding === 'sgr') return Buffer.from(`\x1b[<${code};${x};${y}${event.release ? 'm' : 'M'}`, 'latin1');
  if (event.release) code = (code & ~(3 | 64 | 128)) | 3;
  const prefix = [0x1b, 0x5b, 0x4d];
  if (encoding === 'utf8') return Buffer.from([...prefix, ...utf8Value(32 + code), ...utf8Value(32 + Math.min(x, 2015)), ...utf8Value(32 + Math.min(y, 2015))]);
  return Buffer.from([...prefix, 32 + code, 32 + Math.min(x, 223), 32 + Math.min(y, 223)]);
}

// ── routing in the slot ───────────────────────────────────────────────────────

/** What the slot does with a mouse event. */
export type SlotMouseRoute =
  /** Re-encode it for the pane's app. */
  | 'forward'
  /** Scroll the cockpit's scrollback of the pane: up (back) or down (towards live). */
  | 'scrollUp' | 'scrollDown'
  /** The cockpit's selection: a left press anchors it, left motion extends it, the release copies it. */
  | 'selectStart' | 'selectExtend' | 'selectEnd'
  | 'drop';

export interface SlotMouseContext {
  /** The pane's app mouse mode. */
  tracking: MouseTracking;
  /** The tab forwards no mouse event: a worker or scout tab in view mode. */
  viewOnly: boolean;
  /** A cockpit selection drag is in progress: its motion and release stay with the cockpit. */
  selecting: boolean;
}

/**
 * Who gets a slot mouse event. A selection drag in progress keeps its events.
 * The app gets what its mode wants, unless Shift is held or the tab is view
 * only; an app that asked for the mouse gets nothing else. Otherwise the
 * cockpit: the wheel scrolls, a left drag selects.
 */
export function routeSlotMouse(event: MouseEvent, context: SlotMouseContext): SlotMouseRoute {
  if (context.selecting && event.button === 'left' && (event.motion || event.release)) return event.release ? 'selectEnd' : 'selectExtend';
  if (!event.shift && !context.viewOnly && context.tracking !== 'none') return appWants(event, context.tracking) ? 'forward' : 'drop';
  if (event.motion) return 'drop';
  if (event.button === 'wheelUp') return event.release ? 'drop' : 'scrollUp';
  if (event.button === 'wheelDown') return event.release ? 'drop' : 'scrollDown';
  if (event.button === 'left' && !event.release) return 'selectStart';
  return 'drop';
}

// ── motion coalescing ─────────────────────────────────────────────────────────

export interface MotionCoalescer {
  /** Sends `bytes`; motion waits for the next interval, where only the latest motion is sent. Any other event flushes waiting motion first. */
  push(bytes: Buffer, motion: boolean): void;
  /** Drops waiting motion (another tab is shown, the app quits); the coalescer stays usable. */
  cancel(): void;
}

/** At most one motion report per `intervalMs` (the frame interval) reaches `send`; presses, releases and wheel go at once, in order. */
export function createMotionCoalescer(send: (bytes: Buffer) => void, intervalMs: number): MotionCoalescer {
  let pending: Buffer | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const bytes = pending;
    pending = null;
    if (bytes) send(bytes);
  };
  return {
    push(bytes, motion) {
      if (!motion) {
        flush();
        send(bytes);
        return;
      }
      pending = bytes;
      timer ??= setTimeout(flush, intervalMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
