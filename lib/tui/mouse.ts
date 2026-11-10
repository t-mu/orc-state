import { useStdin, useStdout } from 'ink';
import { useEffect, useRef } from 'react';

/**
 * Mouse clicks in an Ink app inside tmux (the cockpit's sidebar and tab bar).
 * The app asks for button presses in SGR encoding (`ESC[?1000h`, `ESC[?1006h`);
 * with tmux's `mouse on`, a click on the pane focuses it and is passed on as
 * `ESC[<b;x;yM` (press) or `...m` (release), with pane-relative 1-based
 * coordinates. No dependency: the sequences are parsed here.
 */

/** Turns button-press reporting in SGR encoding on, and off. */
export const MOUSE_ON = '\u001B[?1000h\u001B[?1006h';
export const MOUSE_OFF = '\u001B[?1006l\u001B[?1000l';

export interface MouseEvent {
  /** SGR button code: 0 left, 1 middle, 2 right, 64/65 wheel; +4 shift, +8 meta, +16 ctrl, +32 motion. */
  button: number;
  /** 0-based column and row in the pane. */
  x: number;
  y: number;
  release: boolean;
}

const SGR_MOUSE = /\u001B?\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Every SGR mouse event in `data` (a chunk may carry several, or none). */
export function parseSgrMouse(data: string): MouseEvent[] {
  return [...data.matchAll(SGR_MOUSE)].map(match => ({
    button: Number(match[1]),
    x: Number(match[2]) - 1,
    y: Number(match[3]) - 1,
    release: match[4] === 'm',
  }));
}

/** The left-button presses in `data`, without modifiers: what counts as a click. */
export function parseClicks(data: string): { x: number; y: number }[] {
  return parseSgrMouse(data)
    .filter(event => event.button === 0 && !event.release)
    .map(({ x, y }) => ({ x, y }));
}

/**
 * Whether `input` (as Ink's `useInput` passes it, the leading ESC stripped) is
 * a mouse report, which a key handler must ignore.
 */
export function isMouseInput(input: string): boolean {
  return /^\u001B?\[<\d+;\d+;\d+[Mm]/.test(input);
}

/**
 * Calls `onClick` with each left click's 0-based pane position while
 * `isActive`; turns mouse reporting on for that time (and off again after).
 */
export function useMouseClicks(onClick: (click: { x: number; y: number }) => void, isActive: boolean): void {
  const { internal_eventEmitter: events } = useStdin();
  const { stdout } = useStdout();
  const handler = useRef(onClick);
  handler.current = onClick;

  useEffect(() => {
    if (!isActive) return;
    stdout.write(MOUSE_ON);
    const onInput = (data: string | Buffer) => {
      for (const click of parseClicks(String(data))) handler.current(click);
    };
    events.on('input', onInput);
    return () => {
      events.off('input', onInput);
      stdout.write(MOUSE_OFF);
    };
  }, [events, isActive, stdout]);
}
