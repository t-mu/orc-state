import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import React, { act } from 'react';
import { render as inkRender, type Instance } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConnectionState, ProjectWatchState, ProjectWatchUpdate, StatusView } from '../../client.ts';
import { App } from './App.tsx';
import type { TuiAttention, TuiRecentEvent, TuiStatus, TuiWatchSource } from './status.ts';

type Kind = TuiAttention['kind'];

interface AgentSpec { id: string; task?: string; phase?: string; activity?: string; attention?: { kind: Kind; detail?: string | null } }

function status(agents: AgentSpec[], recentEvents: TuiRecentEvent[] = []): TuiStatus {
  return {
    worker_capacity: {
      configured_slots: agents.length, used_slots: agents.length, available_slots: 0, warming_slots: 0, unavailable_slots: 0,
      provider: 'claude', dispatch_ready_count: 0, waiting_for_capacity: 0,
      slots: agents.map(agent => ({
        agent_id: agent.id, role: 'worker', provider: 'claude', model: null, status: 'running', session_handle: null,
        slot_state: 'busy', active_run_id: `run-${agent.id}`, active_task_ref: agent.task ?? null,
        last_status_change_at: null, last_heartbeat_at: null,
        attention: agent.attention
          ? { kind: agent.attention.kind, run_id: `run-${agent.id}`, since: null, detail: agent.attention.detail ?? null, request_id: null }
          : null,
      })),
    },
    scouts: [],
    tasks: { counts: {}, total: 0 },
    claims: {
      active: agents.map(agent => ({
        run_id: `run-${agent.id}`, task_ref: agent.task ?? null, agent_id: agent.id, state: 'in_progress',
        age_seconds: 1, idle_seconds: 1, activity_seconds: 1, heartbeat_seconds: 1, current_phase: agent.phase ?? null,
        current_activity: agent.activity ? { text: agent.activity, source: 'note', ts: '2026-11-09T10:00:00Z' } as never : null,
      })),
      total: agents.length, awaiting_run_started: 0, in_progress: agents.length, stalled: 0,
    },
    failures: { startup: [], lifecycle: [] },
    recentEvents,
    eventReadError: '',
  };
}

function project(id: string, connection: ProjectConnectionState, s: TuiStatus | null, error: string | null = null): ProjectWatchState {
  return {
    project: {
      id, name: id, target_repo_root: `/repo/${id}`, state_dir: `/state/${id}`,
      repo_present: true, control_socket: null, coordinator_running: connection === 'running',
    },
    connection,
    error,
    status: s as unknown as StatusView | null,
    cursor: s ? 0 : null,
  };
}

/** A watcher whose projects the test sets, and whose updates it emits. */
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
    emit(update: ProjectWatchUpdate) { for (const listener of listeners) listener(update); },
  };
}

function plain(frame: string | undefined): string {
  return stripVTControlCharacters(frame ?? '').trimEnd();
}

/** Let mount effects and state updates settle (React schedules them on the faked timers). */
async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => {
    action();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('dashboard App', () => {
  it('gives each attention kind its own badge on the agent row and counts them per project', () => {
    const { source } = fakeSource([project('alpha', 'running', status([
      { id: 'busy-one', task: 'plan/working', activity: 'Running npm test' },
      { id: 'asks-perm', attention: { kind: 'permission_prompt', detail: 'Allow Bash(rm -rf dist)?' } },
      { id: 'asks-q', attention: { kind: 'question', detail: 'Which\n  schema?' } },
      { id: 'is-stalled', attention: { kind: 'stalled' } },
      { id: 'no-moves', attention: { kind: 'no_progress', detail: 'implement' } },
    ]))]);

    const frame = plain(render(<App source={source} stateDir="/state/alpha" intervalMs={1000} />).lastFrame());
    const lines = frame.split('\n');
    const row = (agent: string) => lines.find(line => line.includes(agent)) ?? '';

    expect(row('asks-perm')).toContain(' PERMISSION');
    expect(row('asks-q')).toContain(' QUESTION');
    expect(row('is-stalled')).toContain(' STALLED');
    expect(row('no-moves')).toContain(' NO PROGRESS');
    expect(row('busy-one')).not.toMatch(/PERMISSION|QUESTION|STALLED|NO PROGRESS/);
    expect(frame).toContain('? Allow Bash(rm -rf dist)?');
    expect(frame).toContain('? Which schema?');
    expect(frame).toContain('no progress in implement');
    expect(frame).toContain('└ Running npm test');

    expect(frame).toContain('alpha running ⚠ 4');
    expect(frame).toContain('1 permission · 1 question · 1 stalled · 1 no progress');
    expect(frame).toContain('4 NEED YOU');
    // Agents needing a human come first, by precedence; the busy one last.
    const order = ['asks-perm', 'asks-q', 'is-stalled', 'no-moves', 'busy-one'].map(agent => lines.indexOf(row(agent)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('shows stopped, incompatible and unreachable projects as such, the current project first', () => {
    const { source } = fakeSource([
      project('old', 'incompatible', null, 'protocol v9 not supported'),
      project('gone', 'stopped', status([{ id: 'last-seen', task: 'x/y' }])),
      project('idle', 'stopped', null),
      project('mine', 'running', status([])),
    ]);

    const frame = plain(render(<App source={source} stateDir="/state/mine" intervalMs={1000} />).lastFrame());

    expect(frame).toContain('4 projects');
    expect(frame).toMatch(/▸ mine running\n\s+\(no live agents\)/);
    expect(frame).toContain('old incompatible');
    expect(frame).toContain('incompatible: protocol v9 not supported');
    expect(frame).toContain('gone stopped (last known)');
    expect(frame).toContain('last-seen');
    expect(frame).toMatch(/idle stopped\n\s+\(coordinator not running\)/);
    expect(frame.indexOf('mine')).toBeLessThan(frame.indexOf('old'));
  });

  it('says why nothing is shown when the registry cannot be read', async () => {
    const watcher = fakeSource([]);
    const app = render(<App source={watcher.source} stateDir="/state/none" intervalMs={1000} />);
    expect(plain(app.lastFrame())).toContain('no registered projects');

    await settle();
    await settle(() => watcher.emit({ type: 'registry_error', error: new Error('registry unreadable') }));
    expect(plain(app.lastFrame())).toContain('registry error: registry unreadable');
  });

  it('feeds notification events from every project, newest first', async () => {
    const watcher = fakeSource([
      project('alpha', 'running', status([], [
        { seq: 1, ts: '2026-11-09T10:00:00Z', event: 'run_finished', agent_id: 'a1', task_ref: 'plan/first' },
        { seq: 2, ts: '2026-11-09T10:01:00Z', event: 'heartbeat', agent_id: 'a1', task_ref: 'plan/first' },
      ])),
      project('beta', 'running', status([], [
        { seq: 7, ts: '2026-11-09T10:02:00Z', event: 'input_requested', agent_id: 'b1', task_ref: 'plan/second' },
      ])),
    ]);
    const app = render(<App source={watcher.source} stateDir="/state/alpha" intervalMs={1000} />);
    await settle();
    let frame = plain(app.lastFrame());

    expect(frame).toContain('Notifications');
    expect(frame).not.toContain('heartbeat');
    expect(frame.indexOf('input_requested beta b1 second')).toBeGreaterThan(-1);
    expect(frame.indexOf('input_requested beta b1 second')).toBeLessThan(frame.indexOf('run_finished alpha a1 first'));

    // A streamed event joins the feed on top, with the attention reason.
    await settle(() => watcher.emit({
      type: 'event', project_id: 'alpha',
      row: { seq: 3, event: { event: 'worker_needs_attention', ts: '2026-11-09T10:03:00Z', agent_id: 'a2', payload: { reason: 'no_progress' } } as never },
    }));
    frame = plain(app.lastFrame());
    expect(frame.indexOf('worker_needs_attention:no_progress alpha a2')).toBeGreaterThan(-1);
    expect(frame.indexOf('worker_needs_attention:no_progress alpha a2')).toBeLessThan(frame.indexOf('input_requested beta b1'));
  });

  it('does not re-render while the data is unchanged, and does when it changes', async () => {
    const watcher = fakeSource([project('alpha', 'running', status([{ id: 'w1', task: 'plan/a', phase: 'explore' }]))]);
    const app = render(<App source={watcher.source} stateDir="/state/alpha" intervalMs={1000} />);
    await settle();
    const framesAfterMount = app.frames.length;

    // Interval ticks and watcher updates with equal (but new) data.
    watcher.set([project('alpha', 'running', status([{ id: 'w1', task: 'plan/a', phase: 'explore' }]))]);
    await settle(() => watcher.emit({ type: 'status', project_id: 'alpha', status: watcher.source.projects()[0].status as StatusView }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(app.frames.length).toBe(framesAfterMount);

    watcher.set([project('alpha', 'running', status([{ id: 'w1', task: 'plan/a', phase: 'implement' }]))]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(app.frames.length).toBeGreaterThan(framesAfterMount);
    expect(plain(app.lastFrame())).toContain('plan/a · implement');
  });

  it('moves the selection through agents of every project with the arrow keys and j/k', async () => {
    const { source } = fakeSource([
      project('alpha', 'running', status([{ id: 'a1' }, { id: 'a2' }])),
      project('beta', 'running', status([{ id: 'b1' }])),
    ]);
    const app = render(<App source={source} stateDir="/state/alpha" intervalMs={1000} />);
    const selectedRow = () => plain(app.lastFrame()).split('\n').find(line => line.startsWith('› ')) ?? '';

    await settle();
    expect(selectedRow()).toContain('a1');
    await settle(() => app.stdin.write('\u001B[B'));
    expect(selectedRow()).toContain('a2');
    await settle(() => app.stdin.write('j'));
    expect(selectedRow()).toContain('b1');
    await settle(() => app.stdin.write('j'));
    expect(selectedRow()).toContain('b1');
    await settle(() => app.stdin.write('k'));
    expect(selectedRow()).toContain('a2');
  });
});

/** A terminal of fixed size that records the frames Ink writes. */
class FakeStdout extends EventEmitter {
  frames: string[] = [];
  constructor(public rows: number, public columns: number) { super(); }
  write = (frame: string) => { this.frames.push(frame); return true; };
  lastFrame(): string { return this.frames[this.frames.length - 1] ?? ''; }
}

class FakeStdin extends EventEmitter {
  isTTY = false;
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() { return null; }
}

describe('dashboard App in a terminal', () => {
  let instance: Instance | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  function renderIn(rows: number, columns: number, states: ProjectWatchState[]): FakeStdout {
    const stdout = new FakeStdout(rows, columns);
    instance = inkRender(<App source={fakeSource(states).source} stateDir="/state/alpha" intervalMs={1000} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    return stdout;
  }

  it('fits a 40-column side pane: no line wider, badges and counts still visible', () => {
    const stdout = renderIn(40, 40, [
      project('alpha-with-a-long-project-name', 'running', status([
        { id: 'wretched-cave-worker', task: 'cockpit/dashboard-pane-with-a-long-slug', phase: 'implement', activity: 'Running the whole test suite with coverage' },
        { id: 'asks-perm', task: 'cockpit/x', attention: { kind: 'permission_prompt', detail: 'Allow Bash(npm publish --access public --tag next)?' } },
      ], [{ seq: 1, ts: '2026-11-09T10:00:00Z', event: 'run_failed', agent_id: 'wretched-cave-worker', task_ref: 'cockpit/dashboard-pane-with-a-long-slug' }])),
      project('beta', 'incompatible', null, 'coordinator speaks control protocol v9, this client supports v1 and v2'),
    ]);

    const lines = plain(stdout.lastFrame()).split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(40);
    const frame = lines.join('\n');
    expect(frame).toContain(' PERMISSION');
    expect(frame).toContain('1 permission');
    expect(frame).toContain('beta incompatible');
    expect(frame).toContain('run_failed');
  });

  it('stays below the terminal height, collapsing agent rows and cutting long lists', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, task: `plan/t${i}`, phase: 'implement' }));
    const stdout = renderIn(16, 40, [project('alpha', 'running', status([
      ...many,
      { id: 'needs-me', attention: { kind: 'question', detail: 'ok?' } },
    ]))]);

    const frame = plain(stdout.lastFrame());
    expect(frame.split('\n').length).toBeLessThan(16);
    // The agent needing a human sorts first, so it survives the cut.
    expect(frame).toContain('needs-me  QUESTION');
    expect(frame).toMatch(/\+\d+ more/);
    expect(frame).toContain('Notifications');
  });
});
