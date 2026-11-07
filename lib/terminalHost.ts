/**
 * Live terminal streams (docs/terminal-streaming.md). One control connection
 * per viewed terminal, shared by all its viewers: started by the first viewer,
 * stopped when the last one leaves. There is no reconnect: when the connection
 * or the terminal ends, every viewer gets an `exit` frame and reopens.
 * tmux control mode (`tmux -C`) is the only backend.
 */
import type { TerminalFrame } from './controlProtocol.ts';

export interface TerminalSnapshot { screen: string; cursor_x: number; cursor_y: number; columns: number; rows: number }

/** A live connection to one terminal's output. Callbacks never fire after `stop()`. */
export interface TerminalConnection {
  onOutput(listener: (data: Buffer) => void): void;
  /** Fires at most once: the terminal ended or the connection was lost. */
  onExit(listener: (reason: string) => void): void;
  stop(): void;
}

/** What the host needs from a backend; `TmuxTerminalDriver` in `terminalBroker.ts` is the tmux one. */
export interface TerminalSource {
  alive(handle: string): boolean;
  snapshot(handle: string): TerminalSnapshot;
  connect(handle: string): TerminalConnection;
}

export interface TerminalViewer {
  send(frame: TerminalFrame): void;
  /** The stream is over; the viewer closes its side. */
  end(): void;
}

/**
 * Decodes one `%output` payload: tmux writes bytes below 0x20 and `\` as
 * `\ooo` octal and every other byte raw, UTF-8 included.
 */
export function decodeTmuxOutput(payload: Buffer): Buffer {
  const out = Buffer.alloc(payload.length);
  let length = 0;
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i];
    if (byte === 0x5c && isOctal(payload[i + 1]) && isOctal(payload[i + 2]) && isOctal(payload[i + 3])) {
      out[length++] = ((payload[i + 1] - 0x30) << 6) | ((payload[i + 2] - 0x30) << 3) | (payload[i + 3] - 0x30);
      i += 3;
    } else {
      out[length++] = byte;
    }
  }
  return out.subarray(0, length);
}

function isOctal(byte: number | undefined): boolean { return byte !== undefined && byte >= 0x30 && byte <= 0x37; }

export type TmuxControlEvent = { type: 'output'; pane: string; data: Buffer } | { type: 'exit'; reason: string };

const OUTPUT_PREFIX = /^%output (%\d+) /;
const EXTENDED_OUTPUT_PREFIX = /^%extended-output (%\d+) \d+[^:]*: /;

/**
 * Splits a control client's stdout into lines (as bytes: a UTF-8 character
 * may straddle two chunks) and returns its output and exit notifications.
 * Command replies (`%begin` … `%end`|`%error`) and other notifications are skipped.
 */
export class TmuxControlParser {
  private pending: Buffer = Buffer.alloc(0);
  private inReply = false;

  push(chunk: Buffer): TmuxControlEvent[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const events: TmuxControlEvent[] = [];
    let start = 0;
    for (let newline = this.pending.indexOf(0x0a, start); newline >= 0; newline = this.pending.indexOf(0x0a, start)) {
      const event = this.line(this.pending.subarray(start, newline));
      if (event) events.push(event);
      start = newline + 1;
    }
    this.pending = this.pending.subarray(start);
    return events;
  }

  private line(line: Buffer): TmuxControlEvent | null {
    const text = line.toString('latin1');
    if (this.inReply) {
      if (/^%(end|error) /.test(text)) this.inReply = false;
      return null;
    }
    if (text.startsWith('%begin ')) { this.inReply = true; return null; }
    const match = OUTPUT_PREFIX.exec(text) ?? EXTENDED_OUTPUT_PREFIX.exec(text);
    if (match) return { type: 'output', pane: match[1], data: decodeTmuxOutput(line.subarray(match[0].length)) };
    if (text === '%exit' || text.startsWith('%exit ')) return { type: 'exit', reason: text.slice(6) || 'terminal exited' };
    return null;
  }
}

interface Entry { connection: TerminalConnection; viewers: Set<TerminalViewer>; timer: NodeJS.Timeout }

/** How often a viewed terminal is checked: a provider pane kept by `remain-on-exit` dies without `%exit`. */
const DEFAULT_LIVENESS_MS = 1_000;

export class TerminalStreams {
  private readonly source: TerminalSource;
  private readonly livenessMs: number;
  private readonly entries = new Map<string, Entry>();

  constructor(source: TerminalSource, options: { livenessMs?: number } = {}) {
    this.source = source;
    this.livenessMs = options.livenessMs ?? DEFAULT_LIVENESS_MS;
  }

  viewers(handle: string): number { return this.entries.get(handle)?.viewers.size ?? 0; }

  /**
   * Adds a viewer: it gets a `snapshot` frame now and `output` frames after it.
   * The snapshot is read synchronously, so no output is delivered between the
   * two. Output already queued in the client's pipe when the snapshot is taken
   * still arrives after it and may repeat a few bytes the snapshot shows; the
   * redraw after sizing corrects that. Returns the function that removes this viewer.
   */
  open(handle: string, viewer: TerminalViewer): () => void {
    let entry = this.entries.get(handle);
    if (!entry) entry = this.start(handle);
    try {
      viewer.send({ type: 'snapshot', ...this.source.snapshot(handle) });
    } catch (error) {
      if (entry.viewers.size === 0) this.stop(handle);
      throw error;
    }
    entry.viewers.add(viewer);
    return () => this.leave(handle, viewer);
  }

  private start(handle: string): Entry {
    const connection = this.source.connect(handle);
    const viewers = new Set<TerminalViewer>();
    const timer = setInterval(() => {
      if (!this.source.alive(handle)) this.end(handle, 'terminal exited');
    }, this.livenessMs);
    timer.unref();
    const entry: Entry = { connection, viewers, timer };
    this.entries.set(handle, entry);
    connection.onOutput((data) => {
      const frame: TerminalFrame = { type: 'output', data: data.toString('base64') };
      for (const viewer of viewers) viewer.send(frame);
    });
    connection.onExit((reason) => this.end(handle, reason));
    return entry;
  }

  private leave(handle: string, viewer: TerminalViewer): void {
    const entry = this.entries.get(handle);
    if (!entry || !entry.viewers.delete(viewer)) return;
    if (entry.viewers.size === 0) this.stop(handle);
  }

  private end(handle: string, reason: string): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.stop(handle);
    for (const viewer of entry.viewers) {
      viewer.send({ type: 'exit', reason });
      viewer.end();
    }
  }

  private stop(handle: string): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    this.entries.delete(handle);
    clearInterval(entry.timer);
    entry.connection.stop();
  }

  /** Ends every stream; the server calls this on shutdown. */
  close(): void {
    for (const handle of [...this.entries.keys()]) this.end(handle, 'control daemon is shutting down');
  }
}
