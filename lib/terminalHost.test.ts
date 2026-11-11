import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalFrame } from './controlProtocol.ts';
import { TerminalStreams, TmuxControlParser, decodeTmuxOutput, type TerminalConnection, type TerminalSource,
  type TmuxControlEvent, type TmuxControlReplyEvent } from './terminalHost.ts';

describe('decodeTmuxOutput', () => {
  it('turns octal escapes back into bytes and passes everything else through', () => {
    // As observed on tmux 3.3a (docs/terminal-streaming.md, Q5).
    const payload = Buffer.concat([Buffer.from('T\\011E\\033[1mB\\134U'), Buffer.from('ä€', 'utf8'), Buffer.from('Z\\015\\012')]);
    expect(decodeTmuxOutput(payload).toString('utf8')).toBe('T\tE\x1b[1mB\\Uä€Z\r\n');
  });

  it('leaves a backslash that is not followed by three octal digits alone', () => {
    expect(decodeTmuxOutput(Buffer.from('a\\9bc\\01')).toString()).toBe('a\\9bc\\01');
  });
});

describe('TmuxControlParser', () => {
  it('returns output and exit notifications and skips command replies', () => {
    const parser = new TmuxControlParser();
    const events = parser.push(Buffer.from([
      '%begin 1 1 0', 'attach reply', '%output %9 not-output-inside-a-reply', '%end 1 1 0',
      '%session-changed $0 a1',
      '%output %0 hi\\015\\012',
      '%extended-output %0 12 : late',
      '%exit',
      '',
    ].join('\n')));
    expect(events.map((event) => event.type === 'output' ? [event.pane, event.data.toString()] : event)).toEqual([
      ['%0', 'hi\r\n'], ['%0', 'late'], { type: 'exit', reason: 'terminal exited' },
    ]);
  });

  it('joins lines split across chunks, including a split UTF-8 character', () => {
    const parser = new TmuxControlParser();
    const line = Buffer.concat([Buffer.from('%output %1 '), Buffer.from('€', 'utf8'), Buffer.from('\n')]);
    expect(parser.push(line.subarray(0, 12))).toEqual([]);
    const [event] = parser.push(line.subarray(12));
    expect(event).toMatchObject({ type: 'output', pane: '%1' });
    expect((event as { data: Buffer }).data.toString('utf8')).toBe('€');
    expect(parser.push(Buffer.from('%layout-change @1 b25d,80x24,0,0,0 b25d,100x30,0,0,0 *\n')))
      .toEqual([{ type: 'resize', columns: 100, rows: 30 }]);
    expect(parser.push(Buffer.from('%exit detached\n'))).toEqual([{ type: 'exit', reason: 'detached' }]);
  });
});

describe('TmuxControlParser with replies', () => {
  it('returns reply blocks with body lines, an error flag and the %begin flags', () => {
    const parser = new TmuxControlParser<TmuxControlEvent | TmuxControlReplyEvent>({ replies: true });
    const events = parser.push(Buffer.from([
      '%begin 1 1 0', '%end 1 1 0',
      '%begin 2 2 1', '%0 100 30', 'caf\u00e9', '%end 2 2 1',
      '%begin 3 3 1', 'parse error: unknown command: x', '%error 3 3 1',
      '',
    ].join('\n'), 'utf8'));
    expect(events).toEqual([
      { type: 'reply', lines: [], error: false, flags: 0 },
      { type: 'reply', lines: ['%0 100 30', 'caf\u00e9'], error: false, flags: 1 },
      { type: 'reply', lines: ['parse error: unknown command: x'], error: true, flags: 1 },
    ]);
  });

  it('returns %sessions-changed and other notifications; %layout-change also as resize', () => {
    const parser = new TmuxControlParser<TmuxControlEvent | TmuxControlReplyEvent>({ replies: true });
    const events = parser.push(Buffer.from([
      '%sessions-changed',
      '%layout-change @1 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *',
      '%session-changed $0 a1',
      '%output %0 x',
      '%exit',
      '',
    ].join('\n')));
    expect(events.map((event) => event.type === 'output' ? event.type : event)).toEqual([
      { type: 'sessions-changed' },
      { type: 'resize', columns: 80, rows: 24 },
      { type: 'notification', line: '%layout-change @1 b25d,80x24,0,0,0 b25d,80x24,0,0,0 *' },
      { type: 'notification', line: '%session-changed $0 a1' },
      'output',
      { type: 'exit', reason: 'terminal exited' },
    ]);
  });

  it('ends a block only on the %end/%error matching its %begin; other % lines are body text', () => {
    const parser = new TmuxControlParser<TmuxControlEvent | TmuxControlReplyEvent>({ replies: true });
    const events = parser.push(Buffer.from([
      '%begin 10 5 1', 'foo', '%end of story', '%error at line 3', '%begin 1 1 1', '%end 10 5 0', '%error 11 5 1', 'bar', '%end 10 5 1',
      '%begin 10 6 1', '%end 10 6 1 trailing', '%end 10 6 1', '%error 10 6 1',
      '%begin 10 7 1', 'boom', '%error 10 7 1',
      '%output %0 x',
      '',
    ].join('\n')));
    expect(events.map((event) => event.type === 'output' ? event.type : event)).toEqual([
      { type: 'reply', lines: ['foo', '%end of story', '%error at line 3', '%begin 1 1 1', '%end 10 5 0', '%error 11 5 1', 'bar'], error: false, flags: 1 },
      { type: 'reply', lines: ['%end 10 6 1 trailing'], error: false, flags: 1 },
      { type: 'notification', line: '%error 10 6 1' },
      { type: 'reply', lines: ['boom'], error: true, flags: 1 },
      'output',
    ]);
  });

  it('returns none of them without the option', () => {
    const events = new TmuxControlParser().push(Buffer.from('%begin 1 1 0\nbody\n%error 1 1 0\n%sessions-changed\n%window-add @1\n'));
    expect(events).toEqual([]);
  });
});

class FakeConnection implements TerminalConnection {
  stopped = false;
  output: Array<(data: Buffer) => void> = [];
  exits: Array<(reason: string) => void> = [];
  resizes: Array<(columns: number, rows: number) => void> = [];
  onOutput(listener: (data: Buffer) => void): void { this.output.push(listener); }
  onResize(listener: (columns: number, rows: number) => void): void { this.resizes.push(listener); }
  onExit(listener: (reason: string) => void): void { this.exits.push(listener); }
  resize(columns: number, rows: number): void { for (const listener of this.resizes) listener(columns, rows); }
  emit(text: string): void { for (const listener of this.output) listener(Buffer.from(text)); }
  stop(): void { this.stopped = true; }
}

function source() {
  const connections = new Map<string, FakeConnection[]>();
  const live = new Set(['a', 'b']);
  let duringSnapshot: (() => void) | null = null;
  const fake: TerminalSource = {
    alive: (handle) => live.has(handle),
    snapshot: (handle) => {
      duringSnapshot?.();
      return { screen: `screen ${handle}\n`, cursor_x: 0, cursor_y: 0, columns: 80, rows: 24 };
    },
    connect: (handle) => {
      const connection = new FakeConnection();
      connections.set(handle, [...(connections.get(handle) ?? []), connection]);
      return connection;
    },
  };
  return { fake, connections, live, onSnapshot: (fn: () => void) => { duringSnapshot = fn; } };
}

function viewer() {
  const frames: TerminalFrame[] = [];
  let ended = false;
  return { frames, ended: () => ended, send: (frame: TerminalFrame) => { frames.push(frame); }, end: () => { ended = true; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('TerminalStreams', () => {
  it('sends a new viewer its snapshot before any output, even output that arrives while it is taken', () => {
    const { fake, connections, onSnapshot } = source();
    const streams = new TerminalStreams(fake);
    const first = viewer();
    streams.open('a', first);
    const connection = connections.get('a')![0];
    const second = viewer();
    onSnapshot(() => connection.emit('during'));
    streams.open('a', second);
    connection.emit('after');
    expect(first.frames.map((frame) => frame.type)).toEqual(['snapshot', 'output', 'output']);
    expect(second.frames.map((frame) => frame.type)).toEqual(['snapshot', 'output']);
    expect(second.frames[1]).toEqual({ type: 'output', data: Buffer.from('after').toString('base64') });
    streams.close();
  });

  it('shares one connection per terminal and stops it with the last viewer', () => {
    const { fake, connections } = source();
    const streams = new TerminalStreams(fake);
    const closeA1 = streams.open('a', viewer());
    const closeA2 = streams.open('a', viewer());
    const b = viewer();
    const closeB = streams.open('b', b);
    expect(connections.get('a')).toHaveLength(1);
    expect(connections.get('b')).toHaveLength(1);
    connections.get('a')![0].emit('only a');
    expect(b.frames).toHaveLength(1);
    closeA1();
    expect(connections.get('a')![0].stopped).toBe(false);
    closeA2();
    closeA2();
    expect(connections.get('a')![0].stopped).toBe(true);
    expect(connections.get('b')![0].stopped).toBe(false);
    closeB();
    expect(streams.viewers('b')).toBe(0);
  });

  it('ends all viewers with exit on a lost connection or a dead terminal, without reconnecting', () => {
    vi.useFakeTimers();
    const { fake, connections, live } = source();
    const streams = new TerminalStreams(fake, { livenessMs: 50 });
    const a = viewer();
    streams.open('a', a);
    connections.get('a')![0].exits[0]('control client closed');
    expect(a.frames.at(-1)).toEqual({ type: 'exit', reason: 'control client closed' });
    expect(a.ended()).toBe(true);
    expect(connections.get('a')).toHaveLength(1);

    const b = viewer();
    streams.open('b', b);
    live.delete('b');
    vi.advanceTimersByTime(60);
    expect(b.frames.at(-1)).toEqual({ type: 'exit', reason: 'terminal exited' });
    expect(connections.get('b')![0].stopped).toBe(true);
  });

  it('does not keep a connection whose first snapshot failed', () => {
    const { fake, connections } = source();
    const streams = new TerminalStreams({ ...fake, snapshot: () => { throw new Error('gone'); } });
    expect(() => streams.open('a', viewer())).toThrow('gone');
    expect(connections.get('a')![0].stopped).toBe(true);
    expect(streams.viewers('a')).toBe(0);
  });
});
