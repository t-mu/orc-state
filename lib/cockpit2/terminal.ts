/**
 * lib/cockpit2/terminal.ts — the real terminal cockpit2 draws on.
 *
 * Opening it puts the terminal in raw mode, enters the alternate screen and
 * turns on any-motion SGR mouse reporting and bracketed paste. Every exit path
 * restores it with one synchronous write: a normal quit (`restore()`), process
 * exit, an uncaught exception, an unhandled rejection, SIGTERM, SIGHUP and
 * SIGINT. All output goes through the injected synchronous `write`, so a
 * restore can never overtake a frame still queued in a stream.
 */
import { writeSync as fsWriteSync } from 'node:fs';

const ESC = '\x1b';

/** Alternate screen, any-motion mouse tracking in SGR encoding, bracketed paste; the renderer draws the rest. */
export const ENTER_SEQUENCE = `${ESC}[?1049h${ESC}[?1003h${ESC}[?1006h${ESC}[?2004h`;

/**
 * Ends a synchronized update a crash may have left open, resets the style,
 * mouse tracking (every mode and encoding), bracketed paste and cursor key
 * mode, clears and leaves the alternate screen and shows the cursor. The
 * clear matters after a resize: a terminal that grew while on the alternate
 * screen (tmux does this) can keep its cells in the area the main screen did
 * not have.
 */
export const RESTORE_SEQUENCE = `${ESC}[?2026l${ESC}[0m`
  + `${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l${ESC}[?1006l${ESC}[?1005l`
  + `${ESC}[?2004l${ESC}[?1l${ESC}[H${ESC}[2J${ESC}[?1049l${ESC}[?25h`;

export interface TerminalInput {
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TerminalOutput {
  readonly columns: number;
  readonly rows: number;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

/** The process events the terminal restores on; tests pass a fake. */
export interface ExitHooks {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code: number): unknown;
}

export interface TerminalOptions {
  input: TerminalInput;
  output: TerminalOutput;
  /** Writes to the real terminal synchronously (see `fdWriter`). */
  write: (data: string) => void;
  hooks?: ExitHooks;
  /** Where a crash's error goes after the terminal is restored. */
  report?: (text: string) => void;
}

export interface TerminalSession {
  size(): { cols: number; rows: number };
  write(data: string): void;
  onInput(listener: (chunk: Buffer) => void): () => void;
  onResize(listener: () => void): () => void;
  /** Puts the terminal back as it was; idempotent. */
  restore(): void;
}

/** Exit codes for a signal: 128 plus its number. */
const SIGNAL_EXIT: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** A synchronous UTF-8 writer for a file descriptor; retries the rest of a partial write and EAGAIN. */
export function fdWriter(fd: number, writeSync: (fd: number, data: Uint8Array) => number = fsWriteSync): (data: string) => void {
  return (data) => {
    let rest = Buffer.from(data, 'utf8');
    while (rest.length > 0) {
      try {
        rest = rest.subarray(writeSync(fd, rest));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
      }
    }
  };
}

export function openTerminal(options: TerminalOptions): TerminalSession {
  const { input, output, write } = options;
  const hooks: ExitHooks = options.hooks ?? process;
  const report = options.report ?? ((text: string) => process.stderr.write(text));
  const inputListeners = new Set<(chunk: Buffer) => void>();
  const resizeListeners = new Set<() => void>();
  let restored = false;

  const onData = (chunk: Buffer) => { for (const listener of inputListeners) listener(chunk); };
  const onResize = () => { for (const listener of resizeListeners) listener(); };

  const restore = () => {
    if (restored) return;
    restored = true;
    input.off('data', onData);
    output.off('resize', onResize);
    for (const [event, listener] of exitListeners) hooks.off(event, listener);
    // The terminal may already be gone (SIGHUP): restoring is best effort, exiting must still happen.
    try { input.setRawMode?.(false); } catch { /* not a TTY any more */ }
    try { write(RESTORE_SEQUENCE); } catch { /* nowhere to write */ }
    input.pause();
  };

  const crash = (error: unknown) => {
    restore();
    report(`orc cockpit2: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    hooks.exit(1);
  };
  const exitListeners: Array<[string, (...args: unknown[]) => void]> = [
    ['exit', () => restore()],
    ['uncaughtException', crash],
    ['unhandledRejection', crash],
    ...Object.entries(SIGNAL_EXIT).map(([signal, code]): [string, () => void] => [signal, () => { restore(); hooks.exit(code); }]),
  ];
  for (const [event, listener] of exitListeners) hooks.on(event, listener);

  input.setRawMode?.(true);
  input.on('data', onData);
  input.resume();
  output.on('resize', onResize);
  write(ENTER_SEQUENCE);

  return {
    size: () => ({ cols: output.columns, rows: output.rows }),
    write: (data) => { if (!restored) write(data); },
    onInput(listener) {
      inputListeners.add(listener);
      return () => inputListeners.delete(listener);
    },
    onResize(listener) {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    restore,
  };
}
