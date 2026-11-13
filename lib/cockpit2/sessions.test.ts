import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Sessions, type PaneClient } from './sessions.ts';
import type { TmuxTarget } from './viewState.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean): Promise<void> {
  const until = Date.now() + 4_000;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await sleep(5);
  }
}

class FakeClient extends EventEmitter {
  calls: string[] = [];
  closed = 0;
  /** Holds the next mode query until released. */
  /** The gate of the next client created. */
  static nextGate: Promise<void> | null = null;
  gate: Promise<void> | null = FakeClient.nextGate;
  /** The cursors the mode queries of the next client created report, in turn (then 0,0). */
  static nextCursors: Array<{ cursorX: number; cursorY: number }> = [];
  cursors = FakeClient.nextCursors.splice(0);
  constructor(readonly target: TmuxTarget, readonly ignoreSize: boolean) { super(); }
  resize(cols: number, rows: number) { this.calls.push(`resize ${cols}x${rows}`); return Promise.resolve(); }
  async paneModes() {
    this.calls.push('modes');
    const cursor = this.cursors.shift() ?? { cursorX: 0, cursorY: 0 };
    if (this.gate) await this.gate;
    return { paneId: '%7', cols: 10, rows: 3, ...cursor, alternateOn: this.alternateOn, mouseAny: false, mouseButton: false,
      mouseStandard: false, mouseSgr: false, mouseUtf8: false, keypadCursor: false, cursorVisible: true };
  }
  /** What the next capture returns; the options of each capture. */
  lines = ['hi'];
  captureOptions: unknown[] = [];
  alternateOn = false;
  capture(_pane: string, options?: unknown) { this.calls.push('capture'); this.captureOptions.push(options); return Promise.resolve(this.lines); }
  sendBytes() { return Promise.resolve(); }
  paste() { return Promise.resolve(); }
  pause(pane: string) { this.calls.push(`pause ${pane}`); return Promise.resolve(); }
  resume(pane: string) { this.calls.push(`resume ${pane}`); return Promise.resolve(); }
  close() { this.closed++; }
}

function sessions(setup: (fake: FakeClient) => void = () => {}, scrollback?: number) {
  const clients: FakeClient[] = [];
  const manager = new Sessions({
    connect: (target, { ignoreSize }) => { const fake = new FakeClient(target, ignoreSize); setup(fake); clients.push(fake); return fake as unknown as PaneClient; },
    onChange: () => {},
    scrollback,
    resyncDelayMs: 1,
  });
  return { manager, clients };
}

const A = { socket: 'orc-s', session: 'orc-a' };
const B = { socket: 'orc-s', session: 'orc-b' };
const SIZE = { cols: 40, rows: 10 };

describe('Sessions', () => {
  it('sizes an owned window to the slot and never sizes a view', async () => {
    const { manager, clients } = sessions();
    manager.show('master', A, true, SIZE);
    manager.show('w1', B, false, SIZE);
    manager.resize({ cols: 50, rows: 12 });
    await sleep(5);
    expect(clients.map((fake) => fake.ignoreSize)).toEqual([false, true]);
    expect(clients[0].calls.filter((call) => call.startsWith('resize'))).toEqual(['resize 40x10']);
    expect(clients[1].calls.filter((call) => call.startsWith('resize'))).toEqual([]);
    manager.show('master', A, true, { cols: 50, rows: 12 });
    await sleep(5);
    expect(clients[0].calls.filter((call) => call.startsWith('resize'))).toEqual(['resize 40x10', 'resize 50x12']);
  });

  it('pauses a tab hidden before its pane was known once the mode query names it, and skips the capture', async () => {
    const { manager, clients } = sessions();
    let release!: () => void;
    FakeClient.nextGate = new Promise((resolve) => { release = resolve; });
    const master = manager.show('master', A, true, SIZE);
    FakeClient.nextGate = null;
    manager.show('w1', B, false, SIZE);
    release();
    await waitFor(() => clients[0].calls.includes('pause %7'));
    await sleep(20);
    expect(clients[0].calls).toEqual(['resize 40x10', 'modes', 'pause %7']);
    expect(master.screen).toBeNull();
    manager.show('master', A, true, SIZE);
    await waitFor(() => master.state.kind === 'live');
    expect(clients[0].calls.slice(3)).toEqual(['resume %7', 'resize 40x10', 'modes', 'capture', 'modes']);
    expect(master.state.kind).toBe('live');
  });

  it('pauses a tab hidden while a restore is under way and abandons that restore', async () => {
    const { manager, clients } = sessions();
    let release!: () => void;
    const master = manager.show('master', A, true, SIZE);
    // The first sync restores; hide during a resync's mode query.
    await waitFor(() => master.state.kind === 'live');
    clients[0].gate = new Promise((resolve) => { release = resolve; });
    clients[0].emit('resize', 40, 10);
    await waitFor(() => clients[0].calls.filter((call) => call === 'modes').length === 3);
    manager.show('w1', B, false, SIZE);
    release();
    await sleep(20);
    expect(clients[0].calls).toEqual(['resize 40x10', 'modes', 'capture', 'modes', 'modes', 'pause %7']);
  });

  it('restores the cursor reported with the capture, not the one from the query a round trip before it', async () => {
    const { manager, clients } = sessions();
    // The pane printed [j] before the first query and [j] again before the capture.
    FakeClient.nextCursors = [{ cursorX: 3, cursorY: 0 }, { cursorX: 6, cursorY: 0 }];
    const master = manager.show('master', A, true, SIZE);
    clients[0].lines = ['[j][j]'];
    await waitFor(() => master.state.kind === 'live');
    clients[0].emit('output', '%7', Buffer.from('[k]'));
    const row = () => master.screen?.row(0).map((cell) => cell.text).join('').trimEnd();
    await waitFor(() => row() === '[j][j][k]');
  });

  it('retries an ended session when its tab is shown again, and keeps it while it stays shown', async () => {
    const { manager, clients } = sessions();
    const first = manager.show('master', A, true, SIZE);
    await waitFor(() => first.state.kind === 'live');
    clients[0].emit('exit', 'session closed');
    expect(first.state).toEqual({ kind: 'ended', reason: 'session closed' });
    expect(manager.show('master', A, true, SIZE)).toBe(first);
    manager.show('w1', B, false, SIZE);
    const retried = manager.show('master', A, true, SIZE);
    expect(retried).not.toBe(first);
    expect(clients[0].closed).toBe(1);
    await waitFor(() => retried.state.kind === 'live');
  });

  it('replaces a session whose target changed; closing only detaches its client', () => {
    const { manager, clients } = sessions();
    manager.show('master', A, true, SIZE);
    manager.show('master', B, true, SIZE);
    expect(clients.map((fake) => fake.target)).toEqual([A, B]);
    expect(clients[0].closed).toBe(1);
    manager.close('master');
    expect(clients[1].closed).toBe(1);
    expect(manager.shown()).toBeNull();
    expect(manager.keys()).toEqual([]);
  });
  it('loads the pane\'s history up to the scrollback on attach, so the wheel reaches output from before it', async () => {
    const { manager, clients } = sessions((fake) => { fake.lines = ['old 1', 'old 2', 'old 3', 'row 1', 'row 2', 'row 3']; }, 50);
    const session = manager.show('master', A, true, SIZE);
    await waitFor(() => session.state.kind === 'live' && session.screen !== null);
    expect(clients[0].captureOptions).toEqual([{ history: 50 }]);
    const screen = session.screen!;
    const row = (y: number) => screen.row(y).map((cell) => cell.text).join('').trimEnd();
    expect([0, 1, 2].map(row)).toEqual(['row 1', 'row 2', 'row 3']);
    screen.scroll(-3);
    expect([0, 1, 2].map(row)).toEqual(['old 1', 'old 2', 'old 3']);
  });

  it('captures no history on the alternate screen, which has no scrollback', async () => {
    const { manager, clients } = sessions((fake) => { fake.alternateOn = true; });
    const session = manager.show('master', A, true, SIZE);
    await waitFor(() => session.state.kind === 'live');
    expect(clients[0].captureOptions).toEqual([{ saved: true }, undefined]);
  });
});
