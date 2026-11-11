/**
 * lib/cockpit2/tmuxControl.ts — a tmux control-mode client for one session.
 *
 * `tmux -C attach-session` speaks a line protocol (docs/terminal-streaming.md):
 * each command gets one reply block in FIFO order, the first block answering
 * the attach itself; `%output` carries pane bytes; other `%` lines are
 * notifications. The client turns that into a promise per command and events.
 *
 * Sizing: an owned client (`ignoreSize: false`) sizes its window with
 * `resize()`; an `ignoreSize` client attaches with `-f ignore-size` and never
 * changes the agent's window size.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { TmuxControlParser, type TmuxControlEvent, type TmuxControlReplyEvent } from '../terminalHost.ts';

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

export interface PaneModes {
  paneId: string;
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  alternateOn: boolean;
  mouseAny: boolean;
  mouseButton: boolean;
  mouseStandard: boolean;
  mouseSgr: boolean;
  mouseUtf8: boolean;
  keypadCursor: boolean;
  cursorVisible: boolean;
}

export type TmuxControlEvents = {
  output: [paneId: string, bytes: Buffer];
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

interface Pending { resolve: (lines: string[]) => void; reject: (error: Error) => void }

let pasteCounter = 0;

export class TmuxControlClient extends EventEmitter<TmuxControlEvents> {
  private readonly proc: ControlProcess;
  private readonly parser = new TmuxControlParser<TmuxControlEvent | TmuxControlReplyEvent>({ replies: true });
  private readonly pending: Pending[] = [];
  /**
   * tmux answers the attach itself with one reply block, but can run a command already written to
   * stdin before the attach (then on no session, and its reply comes first). So commands wait here
   * until the attach reply.
   */
  private unattached: string[] | null = [];
  private exited: string | null = null;

  constructor(options: TmuxControlOptions) {
    super();
    const args = ['-L', options.socket, '-C', 'attach-session',
      ...(options.ignoreSize ? ['-f', 'ignore-size'] : []), '-t', `=${options.session}`];
    this.proc = (options.spawn ?? defaultSpawn)(options.tmuxBinary, args);
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.stdin.on('error', () => { /* the client already exited; 'close' reports it */ });
    this.proc.on('error', (error) => this.end(`control client failed: ${error.message}`));
    this.proc.on('close', () => this.end('control client closed'));
  }

  /** Runs one tmux command; resolves with its reply lines, rejects on `%error` or exit. */
  command(line: string): Promise<string[]> {
    if (this.exited !== null) return Promise.reject(new Error(`tmux control client exited: ${this.exited}`));
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      if (this.unattached) this.unattached.push(line);
      else this.proc.stdin.write(`${line}\n`);
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
   * app enabled mode 2004. Empty text sends nothing: tmux creates no buffer
   * for it, so `paste-buffer` would fail.
   */
  async paste(paneId: string, text: string): Promise<void> {
    if (text === '') return;
    const buffer = `cockpit2-paste-${process.pid}-${++pasteCounter}`;
    await Promise.all([
      this.command(`set-buffer -b ${buffer} ${quoteTmuxArgument(text)}`),
      this.command(`paste-buffer -p -d -b ${buffer} -t ${paneId}`),
    ]);
  }

  /** Sizes the window as this client sees it; only meaningful for an owned, non-ignore-size client. */
  async resize(cols: number, rows: number): Promise<void> {
    await this.command(`refresh-client -C ${cols}x${rows}`);
  }

  async paneModes(target: string): Promise<PaneModes> {
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
   * (`capture-pane -a`; empty when there is none).
   */
  capture(paneId: string, { saved = false }: { saved?: boolean } = {}): Promise<string[]> {
    return this.command(`capture-pane ${saved ? '-a -q ' : ''}-p -e -t ${paneId}`);
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
    for (const event of this.parser.push(chunk)) {
      if (this.exited !== null) return;
      switch (event.type) {
        case 'reply': this.onReply(event.lines, event.error); break;
        case 'output': this.emit('output', event.pane, event.data); break;
        case 'exit': this.end(event.reason); break;
        case 'sessions-changed': this.emit('notification', '%sessions-changed'); break;
        case 'notification': this.emit('notification', event.line); break;
        case 'resize': break; // the matching `notification` carries the %layout-change line
      }
    }
  }

  private onReply(lines: string[], error: boolean): void {
    if (this.unattached) {
      // A failed attach ends the client with %exit; its 'exit' rejects the held commands.
      if (!error) for (const line of this.unattached) this.proc.stdin.write(`${line}\n`);
      this.unattached = null;
      return;
    }
    const waiter = this.pending.shift();
    if (!waiter) return;
    if (error) waiter.reject(new Error(lines.join('\n') || 'tmux command failed'));
    else waiter.resolve(lines);
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
