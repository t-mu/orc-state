import { describe, expect, it } from 'vitest';
import type { SessionTerminalView, TerminalFrame } from './controlProtocol.ts';
import { lastLines, snapshotLineCount, stripTerminalEscapes, terminalSnapshot, type TerminalReader } from './terminalSnapshot.ts';

function session(overrides: Partial<SessionTerminalView> = {}): SessionTerminalView {
  return {
    session_id: 's1', agent_id: 'w1', run_id: 'run-1', provider: 'claude', transport: 'tmux',
    state: 'running', state_reason: null, terminal_id: 'provider:s1', writer: null, ...overrides,
  } as SessionTerminalView;
}

/**
 * A control client that answers only the read calls a snapshot may make. Any other method
 * (acquireTerminal, inputTerminal, resizeTerminal, …) is recorded and throws, so a write would fail the test.
 */
function fakeClient(screen: string, sessions: SessionTerminalView[] = [session()]) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let signal: AbortSignal | undefined;
  const reader: TerminalReader = {
    sessions: () => { calls.push({ method: 'sessions', args: [] }); return Promise.resolve({ sessions }); },
    openTerminal: (...args) => {
      calls.push({ method: 'openTerminal', args });
      return Promise.resolve({ terminal: { terminal_id: 'provider:s1' } as Awaited<ReturnType<TerminalReader['openTerminal']>>['terminal'] });
    },
    async *streamTerminal(terminalId, options, abort) {
      calls.push({ method: 'streamTerminal', args: [terminalId, options] });
      signal = abort instanceof AbortSignal ? abort : abort?.signal;
      const frames: TerminalFrame[] = [
        { type: 'snapshot', screen, cursor_x: 0, cursor_y: 0, columns: 80, rows: 24 },
        { type: 'output', data: Buffer.from('later').toString('base64') },
      ];
      for (const frame of frames) yield frame;
      await Promise.resolve();
    },
  };
  const client = new Proxy(reader, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof TerminalReader];
      return (...args: unknown[]) => { calls.push({ method: prop, args }); throw new Error(`unexpected call: ${prop}`); };
    },
  });
  return { client, calls, signal: () => signal };
}

describe('stripTerminalEscapes', () => {
  it('removes colours, cursor moves, OSC titles and carriage returns', () => {
    expect(stripTerminalEscapes('\x1b[1;31mred\x1b[0m \x1b[?25lx\x1b]0;title\x07y\r\n\x1b(Bz\tq')).toBe('red xy\nz\tq');
  });
});

describe('lastLines', () => {
  it('drops the empty bottom of the pane, then keeps the last N lines', () => {
    expect(lastLines('a\nb  \nc\n\n\n', 2)).toBe('b\nc');
    expect(lastLines('a\nb', 10)).toBe('a\nb');
  });
});

describe('snapshotLineCount', () => {
  it('defaults to 40 and accepts 1–200', () => {
    expect(snapshotLineCount(undefined)).toBe(40);
    expect(snapshotLineCount(1)).toBe(1);
    expect(snapshotLineCount(200)).toBe(200);
  });

  it('rejects over 200, zero and non-integers', () => {
    for (const bad of [201, 0, 1.5, '10']) expect(() => snapshotLineCount(bad)).toThrow(/lines must be an integer from 1 to 200/);
  });
});

describe('terminalSnapshot', () => {
  const screen = Array.from({ length: 60 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`).join('\n') + '\n\n';

  it('returns the last 40 stripped lines by default', async () => {
    const { client } = fakeClient(screen);
    const view = await terminalSnapshot(client, 'run-1');
    expect(view.lines).toBe(40);
    expect(view.screen.split('\n')).toHaveLength(40);
    expect(view.screen.split('\n')[0]).toBe('line 21');
    expect(view.screen.endsWith('line 60')).toBe(true);
    expect(view.screen).not.toContain('\x1b');
  });

  it('returns the last N lines when asked and refuses more than 200 before touching the coordinator', async () => {
    const { client, calls } = fakeClient(screen);
    expect((await terminalSnapshot(client, 'run-1', 3)).screen).toBe('line 58\nline 59\nline 60');
    calls.length = 0;
    await expect(terminalSnapshot(client, 'run-1', 201)).rejects.toMatchObject({ code: 'bad_request' });
    expect(calls).toEqual([]);
  });

  it('only reads: no lease, no input, no resize, and closes the stream after the snapshot', async () => {
    const { client, calls, signal } = fakeClient(screen);
    await terminalSnapshot(client, 'run-1', 5);
    expect(calls.map((call) => call.method)).toEqual(['sessions', 'openTerminal', 'streamTerminal']);
    expect(calls[1].args).toEqual(['provider', 'run-1']);
    // No lease_id and no size: a sized viewer would resize the pane.
    expect(calls[2].args).toEqual(['provider:s1', {}]);
    expect(signal()?.aborted).toBe(true);
  });

  it('refuses a run with no live session and a run with an app: session', async () => {
    const none = fakeClient(screen, [session({ state: 'recoverable' }), session({ run_id: 'other' })]);
    await expect(terminalSnapshot(none.client, 'run-1')).rejects.toMatchObject({ code: 'unavailable', message: 'Run run-1 has no live session' });
    const app = fakeClient(screen, [session({ transport: 'app-server', terminal_id: null })]);
    await expect(terminalSnapshot(app.client, 'run-1')).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('app:') });
    expect([...none.calls, ...app.calls].map((call) => call.method)).toEqual(['sessions', 'sessions']);
  });
});
