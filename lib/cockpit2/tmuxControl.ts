/**
 * lib/cockpit2/tmuxControl.ts — a tmux control-mode client for one session.
 *
 * `tmux -C attach-session` speaks a line protocol (docs/terminal-streaming.md):
 * each command written to stdin gets one reply block in FIFO order, its
 * `%begin` flags 1; the attach itself is answered by a block with flags 0;
 * `%output` carries pane bytes; other `%` lines are notifications. The
 * client turns that into a promise per command and events.
 *
 * Sizing: an owned client (`ignoreSize: false`) sizes its window with
 * `resize()`; an `ignoreSize` client attaches with `-f ignore-size` and never
 * changes the agent's window size.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { TmuxControlParser, type TmuxControlEvent, type TmuxControlReplyEvent } from '../terminalHost.ts';
import type { PaneModes } from './screen.ts';

/** The part of a child process the client uses; tests pass a fake. */
export interface ControlProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): boolean;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnControl = (binary: string, args: string[]) => ControlProcess;

export interface TmuxControlOptions {
  /** The tmux binary; injected so lib/cockpit2 needs no adapter or path module. */
  tmuxBinary: string;
  /** The server's socket name (`tmux -L`). */
  socket: string;
  session: string;
  /** Attach with `-f ignore-size`: the client never resizes the window. */
  ignoreSize: boolean;
  spawn?: SpawnControl;
}

/** What `paneModes()` reports: the pane, its size and cursor, and its terminal modes (the screen model's `PaneModes`). */
export interface PaneReport extends PaneModes {
  paneId: string;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
}

export type TmuxControlEvents = {
  output: [paneId: string, bytes: Buffer];
  /** A `%layout-change`: the window's new size (also sent when the size stayed, e.g. a split). */
  resize: [cols: number, rows: number];
  /** `%sessions-changed`: a session was created or destroyed on the server. */
  sessionsChanged: [];
  /** Any other `%` notification line. */
  notification: [line: string];
  exit: [reason: string];
};

/** Bytes per `send-keys -H` command: 3 characters each, so a command line stays near 1.5 KB. */
export const SEND_CHUNK_BYTES = 512;

const PANE_MODE_FORMATS = ['pane_id', 'pane_width', 'pane_height', 'cursor_x', 'cursor_y', 'alternate_on',
  'mouse_any_flag', 'mouse_button_flag', 'mouse_standard_flag', 'mouse_sgr_flag', 'mouse_utf8_flag',
  'keypad_cursor_flag', 'cursor_flag'];

/**
 * `text` as one double-quoted tmux argument that tmux reads back unchanged:
 * `\`, `"`, `$` and `~` backslash-escaped, every control byte (newlines
 * included) as a three-digit octal escape, everything else as is.
 */
export function quoteTmuxArgument(text: string): string {
  let quoted = '"';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) quoted += `\\${code.toString(8).padStart(3, '0')}`;
    else if (char === '\\' || char === '"' || char === '$' || char === '~') quoted += `\\${char}`;
    else quoted += char;
  }
  return `${quoted}"`;
}

/**
 * Whether a tmux server reporting `version` (`#{version}`: `3.6a`, `next-3.8`,
 * `master`) passes paste-buffer data through vis(3), so a raw paste needs
 * `paste-buffer -S`. tmux 3.7 started escaping control bytes there (an ESC
 * arrives as `^[`) and added -S; older servers paste raw and reject -S.
 */
export function pasteNeedsRawFlag(version: string): boolean {
  const text = version.trim();
  if (text === 'master') return true;
  const match = /^(?:next-)?(\d+)\.(\d+)/.exec(text);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 3 || (major === 3 && minor >= 7);
}

/** The first command a client sends: the server's version, which decides `paste-buffer -S`. */
export const SERVER_VERSION_COMMAND = "display-message -p '#{version}'";

interface Pending { resolve: (lines: string[]) => void; reject: (error: Error) => void }

let pasteCounter = 0;

export class TmuxControlClient extends EventEmitter<TmuxControlEvents> {
  private readonly proc: ControlProcess;
  private readonly parser = new TmuxControlParser<TmuxControlEvent | TmuxControlReplyEvent>({ replies: true });
  private readonly pending: Pending[] = [];
  /**
   * tmux can run a command already written to stdin before the attach-session (then on no session),
   * so commands wait here until the attach reply: the first block whose `%begin` flags are 0.
   */
  private unattached: string[] | null = [];
  private exited: string | null = null;
  /** `-S` for a tmux 3.7+ server's paste-buffer, '' for an older one; null until the version reply. */
  private rawPasteFlag: string | null = null;
  private readonly serverVersion: Promise<void>;
  /** Parsed events waiting for `dispatch`, which runs them a turn after a reply that settled a command. */
  private backlog: Array<TmuxControlEvent | TmuxControlReplyEvent> = [];
  private dispatchScheduled = false;
  private afterResize = false;
  private corked = false;

  constructor(options: TmuxControlOptions) {
    super();
    const args = ['-L', options.socket, '-C', 'attach-session',
      ...(options.ignoreSize ? ['-f', 'ignore-size'] : []), '-t', `=${options.session}`];
    this.proc = (options.spawn ?? defaultSpawn)(options.tmuxBinary, args);
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stdin.on('error', () => { /* the client already exited; 'close' reports it */ });
    this.proc.on('error', (error) => this.end(`control client failed: ${error.message}`));
    this.proc.on('close', () => this.end('control client closed'));
    // Asked first, so the reply is in before any paste the user can make; a client that
    // exits first rejects its paste anyway, so the failure itself is dropped here.
    this.serverVersion = this.command(SERVER_VERSION_COMMAND).then(
      ([version = '']) => { this.rawPasteFlag = pasteNeedsRawFlag(version) ? ' -S' : ''; },
      () => {},
    );
  }

  /**
   * Writes to tmux. What is written in one tick goes out as one write, so tmux
   * reads those commands together and runs them back to back, with no pane
   * output read in between (a capture and a mode query issued together agree).
   */
  private write(text: string): void {
    if (!this.corked) {
      this.corked = true;
      this.proc.stdin.cork();
      process.nextTick(() => { this.corked = false; this.proc.stdin.uncork(); });
    }
    this.proc.stdin.write(text);
  }

  /** Runs one tmux command; resolves with its reply lines, rejects on `%error` or exit. Commands run in the order issued. */
  command(line: string): Promise<string[]> {
    if (this.exited !== null) return Promise.reject(new Error(`tmux control client exited: ${this.exited}`));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      if (this.unattached) this.unattached.push(line);
      else this.write(`${line}\n`);
    });
  }

  /** Types bytes into a pane as hex (`send-keys -H`), in chunks sent in order. */
  async sendBytes(paneId: string, bytes: Buffer): Promise<void> {
    const sends: Array<Promise<string[]>> = [];
    for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK_BYTES) {
      const hex = [...bytes.subarray(offset, offset + SEND_CHUNK_BYTES)].map((byte) => byte.toString(16).padStart(2, '0'));
      sends.push(this.command(`send-keys -t ${paneId} -H ${hex.join(' ')}`));
    }
    await Promise.all(sends);
  }

  /**
   * Pastes text through a uniquely named buffer that `paste-buffer -d` deletes.
   * tmux replaces LF with CR and adds bracketed-paste markers only when the
   * app enabled mode 2004; on tmux 3.7+ `-S` keeps control bytes raw (see
   * pasteNeedsRawFlag). Empty text sends nothing: tmux creates no buffer
   * for it, so `paste-buffer` would fail.
   */
  async paste(paneId: string, text: string): Promise<void> {
    if (text === '') return;
    // Only a paste made before the version reply waits (and so may follow keys sent meanwhile).
    if (this.rawPasteFlag === null) await this.serverVersion;
    const buffer = `cockpit2-paste-${process.pid}-${++pasteCounter}`;
    await Promise.all([
      this.command(`set-buffer -b ${buffer} ${quoteTmuxArgument(text)}`),
      this.command(`paste-buffer -p -d${this.rawPasteFlag ?? ''} -b ${buffer} -t ${paneId}`),
    ]);
  }

  /** Sizes the window as this client sees it; only meaningful for an owned, non-ignore-size client. */
  async resize(cols: number, rows: number): Promise<void> {
    await this.command(`refresh-client -C ${cols}x${rows}`);
  }

  async paneModes(target: string): Promise<PaneReport> {
    const format = PANE_MODE_FORMATS.map((name) => `#{${name}}`).join(' ');
    const [line = ''] = await this.command(`display-message -p -t ${target} '${format}'`);
    const [paneId, ...values] = line.split(' ');
    const [cols, rows, cursorX, cursorY] = values.slice(0, 4).map(Number);
    const [alternateOn, mouseAny, mouseButton, mouseStandard, mouseSgr, mouseUtf8, keypadCursor, cursorVisible] =
      values.slice(4).map((value) => value === '1');
    return { paneId, cols, rows, cursorX, cursorY, alternateOn, mouseAny, mouseButton, mouseStandard, mouseSgr,
      mouseUtf8, keypadCursor, cursorVisible };
  }

  /**
   * The pane's visible screen with its escape sequences (`capture-pane -p -e`), one entry per line.
   * With `saved`, the main screen tmux keeps while the pane is on the alternate screen
   * (`capture-pane -a`; empty when there is none). With `history`, up to that many
   * lines of the pane's history come first (`-S -<history>`).
   */
  capture(paneId: string, { saved = false, history = 0 }: { saved?: boolean; history?: number } = {}): Promise<string[]> {
    const start = history > 0 ? `-S -${Math.floor(history)} ` : '';
    return this.command(`capture-pane ${saved ? '-a -q ' : ''}-p -e ${start}-t ${paneId}`);
  }

  async pause(paneId: string): Promise<void> {
    await this.command(`refresh-client -A '${paneId}:pause'`);
  }

  async resume(paneId: string): Promise<void> {
    await this.command(`refresh-client -A '${paneId}:continue'`);
  }

  /** Ends this client; the session keeps running. */
  close(): void {
    this.end('closed');
    this.proc.stdin.end();
    this.proc.kill();
  }

  private onData(chunk: Buffer): void {
    this.backlog.push(...this.parser.push(chunk));
    if (!this.dispatchScheduled) this.dispatch();
  }

  /**
   * Hands parsed events on in order. After a reply that settles a command, the
   * events behind it wait a turn (setImmediate), so the code awaiting that
   * command runs before any of them: it sees exactly what tmux sent after its
   * reply. PaneSession's restore relies on this, dropping output until the
   * capture's reply and keeping what follows; dispatched at once, output in the
   * same read as the reply would be dropped yet missing from the capture.
   */
  private dispatch(): void {
    this.dispatchScheduled = false;
    const events = this.backlog;
    this.backlog = [];
    for (let index = 0; index < events.length; index++) {
      if (this.exited !== null) return;
      const event = events[index];
      // The parser follows a decoded %layout-change's `resize` with the line as a `notification`; that line is not re-sent.
      const decodedLayout = this.afterResize;
      this.afterResize = event.type === 'resize';
      let settled = false;
      switch (event.type) {
        case 'reply': settled = this.onReply(event.lines, event.error, event.flags); break;
        case 'output': this.emit('output', event.pane, event.data); break;
        case 'exit': this.end(event.reason); break;
        case 'resize': this.emit('resize', event.columns, event.rows); break;
        case 'sessions-changed': this.emit('sessionsChanged'); break;
        case 'notification':
          if (!(decodedLayout && event.line.startsWith('%layout-change'))) this.emit('notification', event.line);
          break;
      }
      if (settled && index + 1 < events.length) {
        this.backlog = events.slice(index + 1);
        this.dispatchScheduled = true;
        setImmediate(() => this.dispatch());
        return;
      }
    }
  }

  /**
   * Only blocks flagged 1 answer commands from stdin (tmux cmd-queue.c: the guard's flags are
   * CMDQ_STATE_CONTROL); a block flagged 0 is the attach, or another command tmux ran for this
   * client, and never consumes a pending command. True when the reply settled a command.
   */
  private onReply(lines: string[], error: boolean, flags: number): boolean {
    if (flags === 1) {
      if (this.unattached) return false; // nothing written yet, so not ours
      const waiter = this.pending.shift();
      if (!waiter) return false;
      if (error) waiter.reject(new Error(lines.join('\n') || 'tmux command failed'));
      else waiter.resolve(lines);
      return true;
    }
    if (this.unattached) {
      // A failed attach ends the client with %exit; its 'exit' rejects the held commands.
      if (!error) for (const line of this.unattached) this.write(`${line}\n`);
      this.unattached = null;
    }
    return false;
  }

  /** Fires `exit` once and rejects every pending command. */
  private end(reason: string): void {
    if (this.exited !== null) return;
    this.exited = reason;
    for (const waiter of this.pending.splice(0)) waiter.reject(new Error(`tmux control client exited: ${reason}`));
    this.emit('exit', reason);
  }
}

function defaultSpawn(binary: string, args: string[]): ControlProcess {
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return spawnProcess(binary, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
}
