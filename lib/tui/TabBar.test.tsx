import { stripVTControlCharacters } from 'node:util';
import React, { act } from 'react';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectWatchState, ProjectWatchUpdate, StatusView } from '../../client.ts';
import { MOUSE_OFF, MOUSE_ON } from './mouse.ts';
import type { TuiWatchSource } from './status.ts';
import { TabBar, type TabBarActions } from './TabBar.tsx';
import type { TabBarState } from './tabBarModel.ts';

const tabState = (tabs: string[], active: string | null): TabBarState => ({ activeProject: 'p-1', projects: [{ projectId: 'p-1', tabs, active }] });

function watched(attention: Record<string, 'question' | 'stalled'>): ProjectWatchState {
  const slots = Object.entries(attention).map(([agentId, kind]) => ({
    agent_id: agentId, role: 'worker', attention: { kind, run_id: null, since: null, detail: null, request_id: null },
  }));
  return {
    project: { id: 'p-1', name: 'p-1', target_repo_root: '/repo', state_dir: '/state/p-1', repo_present: true, control_socket: null, coordinator_running: true },
    connection: 'running',
    error: null,
    status: { worker_capacity: { slots } } as unknown as StatusView,
    cursor: 0,
  };
}

function fakeSource(initial: ProjectWatchState[]) {
  let states = initial;
  const listeners = new Set<(update: ProjectWatchUpdate) => void>();
  const source: TuiWatchSource = {
    projects: () => states,
    onUpdate: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    set(next: ProjectWatchState[]) { states = next; },
    emit() { for (const listener of listeners) listener({ type: 'status', project_id: 'p-1', status: states[0]?.status as StatusView }); },
  };
}

/** A change signal the test fires. */
function fakeChanges() {
  let listener: (() => void) | null = null;
  return {
    changes: (onChange: () => void) => {
      listener = onChange;
      return () => { listener = null; };
    },
    fire: () => listener?.(),
  };
}

function fakeActions() {
  return {
    select: vi.fn<TabBarActions['select']>(tab => Promise.resolve(`Switched to ${tab}.`)),
    close: vi.fn<TabBarActions['close']>(agentId => Promise.resolve(`Closed ${agentId}.`)),
    focusSlot: vi.fn<TabBarActions['focusSlot']>(),
  };
}

function plain(frame: string | undefined): string {
  return stripVTControlCharacters(frame ?? '').split('\n').map(line => line.trimEnd()).join('\n');
}

/** The last frame Ink drew (not a mouse mode sequence). */
function lastDrawn(frames: string[]): string {
  return plain([...frames].reverse().find(frame => frame !== MOUSE_ON && frame !== MOUSE_OFF));
}

async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => {
    action();
    await vi.advanceTimersByTimeAsync(0);
  });
}

const click = (x: number, y = 1) => `\u001B[<0;${x + 1};${y + 1}M\u001B[<0;${x + 1};${y + 1}m`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TabBar', () => {
  it('shows master first, then the agent tabs, the active one open to the slot, attention as a badge', async () => {
    const { source } = fakeSource([watched({ w2: 'question' })]);
    const app = render(<TabBar read={() => tabState(['w1', 'w2'], 'w1')} source={source} />);
    await settle();
    const [top, middle, bottom] = plain(app.lastFrame()).split('\n');
    expect(top).toMatch(/^╭─+╮╭─+╮╭─+╮$/);
    expect(middle).toBe('│ 1 master ││ 2 w1 × ││ 3 w2 QUESTION × │');
    // The active tab (w1) has no bottom border: it opens onto the slot.
    expect(bottom.startsWith('┴──────────┴╯        ╰┴')).toBe(true);
  });

  it('redraws on a change signal and a watcher update, and not while nothing changed', async () => {
    let state = tabState(['w1'], null);
    const watcher = fakeSource([watched({})]);
    const signal = fakeChanges();
    const app = render(<TabBar read={() => state} source={watcher.source} changes={signal.changes} intervalMs={5000} />);
    await settle();
    const framesAfterMount = app.frames.length;

    // Equal (but new) state from a signal, a watcher update and the fallback re-read.
    state = tabState(['w1'], null);
    await settle(() => signal.fire());
    await settle(() => watcher.emit());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(app.frames.length).toBe(framesAfterMount);

    state = tabState(['w1', 'w2'], 'w2');
    await settle(() => signal.fire());
    expect(app.frames.length).toBeGreaterThan(framesAfterMount);
    expect(lastDrawn(app.frames)).toContain('3 w2');

    watcher.set([watched({ w1: 'stalled' })]);
    await settle(() => watcher.emit());
    expect(lastDrawn(app.frames)).toContain('2 w1 STALLED');
  });

  it('rebuilds from the last read tab state on a watcher update, without reading it again', async () => {
    const read = vi.fn(() => tabState(['w1'], null));
    const watcher = fakeSource([watched({})]);
    const app = render(<TabBar read={read} source={watcher.source} />);
    await settle();
    const calls = read.mock.calls.length;
    watcher.set([watched({ w1: 'question' })]);
    await settle(() => watcher.emit());
    expect(lastDrawn(app.frames)).toContain('2 w1 QUESTION');
    expect(read.mock.calls.length).toBe(calls);
  });

  it('re-reads at the fallback interval, never faster', async () => {
    const read = vi.fn(() => tabState([], null));
    render(<TabBar read={read} source={fakeSource([]).source} intervalMs={5000} />);
    await settle();
    const calls = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(read.mock.calls.length).toBe(calls);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read.mock.calls.length).toBe(calls + 1);
  });

  it('shows a tab with a click, closes an agent tab at its close marker, and gives the slot the focus after each click', async () => {
    const actions = fakeActions();
    const app = render(<TabBar read={() => tabState(['w1'], 'w1')} source={fakeSource([]).source} actions={actions} mouse />);
    await settle();
    expect(app.frames).toContain(MOUSE_ON);
    const middle = lastDrawn(app.frames).split('\n')[1];

    await settle(() => app.stdin.write(click(middle.indexOf('master'), 0)));
    expect(actions.select).toHaveBeenLastCalledWith('master');
    expect(actions.focusSlot).toHaveBeenCalledTimes(1);

    await settle(() => app.stdin.write(click(middle.indexOf('w1'), 2)));
    expect(actions.select).toHaveBeenLastCalledWith('w1');

    await settle(() => app.stdin.write(click(middle.indexOf('×'))));
    expect(actions.close).toHaveBeenCalledWith('w1');
    expect(actions.select).toHaveBeenCalledTimes(2);

    // Past the tabs: nothing to run, but the focus still goes back to the slot.
    await settle(() => app.stdin.write(click(middle.length + 5)));
    expect(actions.select).toHaveBeenCalledTimes(2);
    expect(actions.close).toHaveBeenCalledTimes(1);
    expect(actions.focusSlot).toHaveBeenCalledTimes(4);

    // A key that reaches the bar goes back to the slot too; a right click does nothing.
    await settle(() => app.stdin.write('x'));
    expect(actions.focusSlot).toHaveBeenCalledTimes(5);
    await settle(() => app.stdin.write('\u001B[<2;3;2M'));
    expect(actions.focusSlot).toHaveBeenCalledTimes(5);

    const before = app.frames.length;
    await settle(() => app.unmount());
    expect(app.frames.slice(before)).toContain(MOUSE_OFF);
  });

  it('shows why an action or the focus failed, until the next click', async () => {
    const actions = fakeActions();
    actions.select.mockImplementation(() => Promise.reject(new Error('Unknown tab w9.')));
    actions.focusSlot.mockImplementation(() => { throw new Error('the cockpit has no slot'); });
    const app = render(<TabBar read={() => tabState([], null)} source={fakeSource([]).source} actions={actions} mouse />);
    await settle();
    await settle(() => app.stdin.write(click(2)));
    expect(lastDrawn(app.frames).split('\n')[2]).toBe('Unknown tab w9.');

    actions.select.mockImplementation(() => Promise.resolve('ok'));
    await settle(() => app.stdin.write(click(2)));
    expect(lastDrawn(app.frames).split('\n')[2]).toMatch(/^┴?╯?.*─+$/);
    expect(lastDrawn(app.frames)).not.toContain('Unknown tab');

    await settle(() => app.stdin.write('k'));
    expect(lastDrawn(app.frames).split('\n')[2]).toBe('the cockpit has no slot');
  });

  it('shows a read failure and the no-project notice in place of the tabs', async () => {
    const failing = render(<TabBar read={() => { throw new Error('no server'); }} source={fakeSource([]).source} />);
    await settle();
    expect(plain(failing.lastFrame())).toContain('orc cockpit bar: no server');
    const none = render(<TabBar read={() => ({ activeProject: null, projects: [] })} source={fakeSource([]).source} />);
    await settle();
    expect(plain(none.lastFrame())).toContain('No project is open');
  });
});
