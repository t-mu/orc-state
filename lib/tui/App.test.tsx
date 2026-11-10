import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import React, { act } from 'react';
import { render as inkRender, type Instance } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConnectionState, ProjectWatchState, ProjectWatchUpdate, StatusView } from '../../client.ts';
import { App, KEYS_HINT, KEYS_HINT_STANDALONE, NO_COCKPIT_HINT, type SidebarActions } from './App.tsx';
import { MOUSE_OFF, MOUSE_ON } from './mouse.ts';
import type { TuiAttention, TuiStatus, TuiWatchSource } from './status.ts';

type Kind = TuiAttention['kind'];

const NOW = Date.parse('2026-11-10T12:00:00Z');

interface AgentSpec {
  id: string;
  task?: string;
  phase?: string;
  activity?: string;
  /** Minutes since the run started. */
  minutes?: number;
  attention?: { kind: Kind; detail?: string | null };
}

function status(agents: AgentSpec[], extra: Partial<TuiStatus> = {}): TuiStatus {
  return {
    worker_capacity: {
      configured_slots: 4, used_slots: agents.length, available_slots: 4 - agents.length, warming_slots: 0, unavailable_slots: 0,
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
        started_at: new Date(NOW - (agent.minutes ?? 0) * 60_000).toISOString(),
        current_activity: agent.activity ? { text: agent.activity, source: 'note', ts: '2026-11-09T10:00:00Z' } as never : null,
      })),
      total: agents.length, awaiting_run_started: 0, in_progress: agents.length, stalled: 0,
    },
    failures: { startup: [], lifecycle: [] },
    recentEvents: [],
    eventReadError: '',
    ...extra,
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

/** The frame without colours, mouse mode sequences or trailing blanks. */
function plain(frame: string | undefined): string {
  return stripVTControlCharacters(frame ?? '').split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
}

/** The last frame Ink drew (not a mouse mode sequence). */
function lastDrawn(frames: string[]): string {
  return plain([...frames].reverse().find(frame => frame !== MOUSE_ON && frame !== MOUSE_OFF));
}

/** Let mount effects and state updates settle (React schedules them on the faked timers). */
async function settle(action: () => void = () => {}): Promise<void> {
  await act(async () => {
    action();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function fakeActions() {
  return {
    selectProject: vi.fn<SidebarActions['selectProject']>(project => Promise.resolve(`Switched to project ${project.project_id}.`)),
    openAgent: vi.fn<SidebarActions['openAgent']>(agent => Promise.resolve(`Opened ${agent.agent_id}.`)),
    focusSlot: vi.fn<SidebarActions['focusSlot']>(),
  };
}

const now = () => NOW;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('sidebar App', () => {
  it('shows each agent on two rows: name, phase and run time, then its activity; attention agents first with badge and text', () => {
    const { source } = fakeSource([project('alpha', 'running', status([
      { id: 'busy-one', task: 'plan/working', phase: 'implement', minutes: 64, activity: 'Running npm test' },
      { id: 'asks-perm', minutes: 2, attention: { kind: 'permission_prompt', detail: 'Allow Bash(rm -rf dist)?' } },
      { id: 'asks-q', attention: { kind: 'question', detail: 'Which\n  schema?' } },
      { id: 'is-stalled', phase: 'review', activity: 'git rebase', attention: { kind: 'stalled' } },
      { id: 'no-moves', attention: { kind: 'no_progress', detail: 'implement' } },
    ], { master: { agent_id: 'boss', status: 'running' } }))]);

    const lines = plain(render(<App source={source} stateDir="/state/alpha" now={now} />).lastFrame()).split('\n');
    const at = (agent: string) => lines.findIndex(line => line.includes(agent));

    expect(lines[at('busy-one')]).toMatch(/busy-one\s+implement 1h04│$/);
    expect(lines[at('busy-one') + 1]).toContain('Running npm test');
    expect(lines[at('asks-perm')]).toMatch(/asks-perm\s+PERMISSION 2m│$/);
    expect(lines[at('asks-perm') + 1]).toContain('? Allow Bash(rm -rf dist)?');
    expect(lines[at('asks-q')]).toContain('QUESTION');
    expect(lines[at('asks-q') + 1]).toContain('? Which schema?');
    expect(lines[at('is-stalled')]).toContain('STALLED');
    expect(lines[at('is-stalled')]).not.toContain('review');
    expect(lines[at('is-stalled') + 1]).toContain('stalled: git rebase');
    expect(lines[at('no-moves') + 1]).toContain('no progress in implement');
    // Needing a human first, by precedence; the busy one last; never the master.
    const order = ['asks-perm', 'asks-q', 'is-stalled', 'no-moves', 'busy-one'].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(lines.join('\n')).not.toContain('boss');
  });

  it('lists every project with its state and attention count, marks the active one, and sums attention in the status box', () => {
    const { source } = fakeSource([
      project('old', 'incompatible', null, 'protocol v9 not supported'),
      project('hung', 'unreachable', null, 'timed out'),
      project('idle', 'stopped', null),
      project('mine', 'running', status([{ id: 'w1', phase: 'explore' }])),
      project('other', 'running', status([{ id: 'o1', attention: { kind: 'question', detail: 'ok?' } }, { id: 'o2', attention: { kind: 'stalled' } }])),
    ]);

    const frame = plain(render(<App source={source} stateDir="/state/mine" now={now} />).lastFrame());

    expect(frame).toMatch(/│ {2}old\s+incompatible│/);
    expect(frame).toMatch(/│ {2}hung\s+stale│/);
    expect(frame).toMatch(/│ {2}idle\s+stopped│/);
    expect(frame).toMatch(/│▸ mine\s+running│/);
    expect(frame).toMatch(/│ {2}other\s+running !2│/);
    expect(frame).toContain('coordinator running');
    expect(frame).toMatch(/workers 1\/4\s+2 need you│/);
    expect(frame).toContain('Agents · mine');
    expect(frame).toContain('w1');
    expect(frame).not.toContain('o1');
  });

  it('says why nothing is shown when the registry cannot be read', async () => {
    const watcher = fakeSource([]);
    const app = render(<App source={watcher.source} stateDir="/state/none" now={now} />);
    expect(plain(app.lastFrame())).toContain('no registered projects');

    await settle();
    await settle(() => watcher.emit({ type: 'registry_error', error: new Error('registry unreadable') }));
    expect(plain(app.lastFrame())).toContain('registry error: registry unreadable');
  });

  it('does not re-render while the data is unchanged, and does when it changes', async () => {
    const watcher = fakeSource([project('alpha', 'running', status([{ id: 'w1', phase: 'explore', minutes: 3 }]))]);
    const app = render(<App source={watcher.source} stateDir="/state/alpha" intervalMs={1000} now={now} />);
    await settle();
    const framesAfterMount = app.frames.length;

    // Interval ticks and watcher updates with equal (but new) data.
    watcher.set([project('alpha', 'running', status([{ id: 'w1', phase: 'explore', minutes: 3 }]))]);
    await settle(() => watcher.emit({ type: 'status', project_id: 'alpha', status: watcher.source.projects()[0].status as StatusView }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(app.frames.length).toBe(framesAfterMount);

    watcher.set([project('alpha', 'running', status([{ id: 'w1', phase: 'implement', minutes: 3 }]))]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(app.frames.length).toBeGreaterThan(framesAfterMount);
    expect(plain(app.lastFrame())).toMatch(/w1\s+implement 3m/);
  });

  it('moves within a box with the arrows, between boxes with Tab, and runs the cockpit action on Enter', async () => {
    const { source } = fakeSource([
      project('alpha', 'running', status([{ id: 'a1' }, { id: 'a2' }])),
      project('beta', 'running', status([{ id: 'b1' }])),
    ]);
    const actions = fakeActions();
    const app = render(<App source={source} stateDir="/state/alpha" now={now} actions={actions} />);
    const frame = () => plain(app.lastFrame());
    const footer = () => frame().split('\n').at(-1);

    await settle();
    expect(footer()).toBe(KEYS_HINT);
    // Agents have the keys first.
    await settle(() => app.stdin.write('\u001B[B'));
    await settle(() => app.stdin.write('\r'));
    expect(actions.openAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ agent_id: 'a2' }),
      expect.objectContaining({ project_id: 'alpha', state_dir: '/state/alpha' }),
    );
    expect(footer()).toBe('Opened a2.');

    // Tab to the projects; down to beta; Enter selects it: the cockpit action, and its agents.
    await settle(() => app.stdin.write('\t'));
    await settle(() => app.stdin.write('j'));
    expect(actions.selectProject).not.toHaveBeenCalled();
    await settle(() => app.stdin.write('\r'));
    expect(actions.selectProject).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'beta' }));
    expect(footer()).toBe('Switched to project beta.');
    expect(frame()).toMatch(/│▸ beta/);
    expect(frame()).toContain('b1');
    expect(frame()).not.toContain('a1');

    // Back to the agents; Esc returns focus to the slot.
    await settle(() => app.stdin.write('\t'));
    await settle(() => app.stdin.write('\r'));
    expect(actions.openAgent).toHaveBeenLastCalledWith(expect.objectContaining({ agent_id: 'b1' }), expect.objectContaining({ project_id: 'beta' }));
    await settle(() => app.stdin.write('\u001B'));
    expect(actions.focusSlot).toHaveBeenCalledTimes(1);
  });

  it('shows a failed action\'s error', async () => {
    const { source } = fakeSource([project('alpha', 'running', status([{ id: 'a1' }]))]);
    const actions = fakeActions();
    actions.openAgent.mockRejectedValue(new Error('another cockpit action is still running'));
    const app = render(<App source={source} stateDir="/state/alpha" now={now} actions={actions} />);
    await settle();
    await settle(() => app.stdin.write('\r'));
    expect(plain(app.lastFrame()).split('\n').at(-1)).toBe('another cockpit action is still running');
  });

  it('shows why Esc could not focus the slot, and keeps a refused project from becoming active', async () => {
    const { source } = fakeSource([
      project('alpha', 'running', status([{ id: 'a1' }])),
      project('beta', 'running', status([{ id: 'b1' }])),
    ]);
    const actions = fakeActions();
    actions.focusSlot.mockImplementation(() => { throw new Error('tmux select-pane failed'); });
    actions.selectProject.mockRejectedValue(new Error('unknown project beta'));
    const app = render(<App source={source} stateDir="/state/alpha" now={now} actions={actions} />);
    const frame = () => plain(app.lastFrame());
    await settle();
    await settle(() => app.stdin.write('\u001B'));
    expect(frame().split('\n').at(-1)).toBe('tmux select-pane failed');

    await settle(() => app.stdin.write('\t'));
    await settle(() => app.stdin.write('j'));
    await settle(() => app.stdin.write('\r'));
    expect(frame().split('\n').at(-1)).toBe('unknown project beta');
    expect(frame()).toMatch(/│▸ alpha/);
    expect(frame()).toContain('a1');
    expect(frame()).not.toContain('b1');
  });

  it('outside a cockpit selects but runs no action, and says where terminals open', async () => {
    const { source } = fakeSource([
      project('alpha', 'running', status([{ id: 'a1' }])),
      project('beta', 'running', status([{ id: 'b1' }])),
    ]);
    const app = render(<App source={source} stateDir="/state/alpha" now={now} />);
    const frame = () => plain(app.lastFrame());
    await settle();
    expect(frame().split('\n').at(-1)).toBe(KEYS_HINT_STANDALONE);
    await settle(() => app.stdin.write('\r'));
    expect(frame().split('\n').at(-1)).toBe(NO_COCKPIT_HINT);
    await settle(() => app.stdin.write('\t'));
    await settle(() => app.stdin.write('j'));
    await settle(() => app.stdin.write('\r'));
    expect(frame()).toMatch(/│▸ beta/);
    expect(frame()).toContain('b1');
    // Esc has nothing to focus.
    await settle(() => app.stdin.write('\u001B'));
    expect(frame()).toContain('b1');
  });

  it('follows the cockpit\'s active project when it changes there', async () => {
    const { source } = fakeSource([
      project('alpha', 'running', status([{ id: 'a1' }])),
      project('beta', 'running', status([{ id: 'b1' }])),
    ]);
    let active: string | null = 'alpha';
    const app = render(<App source={source} stateDir="/state/alpha" intervalMs={1000} now={now} activeProject={() => active} />);
    await settle();
    expect(plain(app.lastFrame())).toContain('a1');
    active = 'beta';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(plain(app.lastFrame())).toMatch(/│▸ beta/);
    expect(plain(app.lastFrame())).toContain('b1');
  });

  it('selects a project or an agent with a mouse click on its row', async () => {
    const { source } = fakeSource([
      project('alpha', 'running', status([{ id: 'a1', activity: 'reading' }, { id: 'a2', activity: 'testing' }])),
      project('beta', 'running', status([])),
    ]);
    const actions = fakeActions();
    const app = render(<App source={source} stateDir="/state/alpha" now={now} actions={actions} mouse />);
    await settle();
    expect(app.frames).toContain(MOUSE_ON);
    const rowOf = (text: string) => lastDrawn(app.frames).split('\n').findIndex(line => line.includes(text));
    const click = (y: number) => `\u001B[<0;5;${y + 1}M\u001B[<0;5;${y + 1}m`;

    // The second row of an agent counts as the agent.
    await settle(() => app.stdin.write(click(rowOf('testing'))));
    expect(actions.openAgent).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'a2' }), expect.objectContaining({ project_id: 'alpha' }));
    expect(actions.openAgent).toHaveBeenCalledTimes(1);

    await settle(() => app.stdin.write(click(rowOf(' beta '))));
    expect(actions.selectProject).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'beta' }));
    // A click on a border or the status box does nothing; nor does a right click.
    await settle(() => app.stdin.write(click(0)));
    await settle(() => app.stdin.write(`\u001B[<2;5;${rowOf('alpha') + 1}M`));
    expect(actions.selectProject).toHaveBeenCalledTimes(1);
    expect(actions.openAgent).toHaveBeenCalledTimes(1);

    const before = app.frames.length;
    await settle(() => app.unmount());
    expect(app.frames.slice(before)).toContain(MOUSE_OFF);
  });
});

/** A terminal of fixed size that records the frames Ink writes. */
class FakeStdout extends EventEmitter {
  frames: string[] = [];
  constructor(public rows: number, public columns: number) { super(); }
  write = (frame: string) => { this.frames.push(frame); return true; };
}

class FakeStdin extends EventEmitter {
  constructor(public isTTY = false) { super(); }
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read() { return null; }
}

describe('sidebar App in a terminal', () => {
  let instance: Instance | null = null;

  afterEach(() => {
    instance?.unmount();
    instance = null;
  });

  function renderIn(rows: number, columns: number, states: ProjectWatchState[] | ReturnType<typeof fakeSource>, tty = false): FakeStdout {
    const stdout = new FakeStdout(rows, columns);
    const source = Array.isArray(states) ? fakeSource(states).source : states.source;
    instance = inkRender(<App source={source} stateDir="/state/alpha" intervalMs={1000} now={now} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin(tty) as unknown as NodeJS.ReadStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    return stdout;
  }

  it('fits 32 columns: no line wider, names cut before phase and time, badges and counts visible', () => {
    const stdout = renderIn(40, 32, [
      project('alpha-with-a-long-project-name', 'running', status([
        { id: 'wretched-cave-worker-with-a-long-name', phase: 'implement', minutes: 75, activity: 'Running the whole test suite with coverage' },
        { id: 'asks-perm', attention: { kind: 'permission_prompt', detail: 'Allow Bash(npm publish --access public --tag next)?' } },
      ])),
      project('beta', 'incompatible', null, 'coordinator speaks control protocol v9'),
    ]);

    const lines = lastDrawn(stdout.frames).split('\n');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(32);
    const frame = lines.join('\n');
    expect(frame).toMatch(/│wretched-cave-… implement 1h15│/);
    expect(frame).toContain('PERMISSION');
    expect(frame).toContain('1 needs you│');
    expect(frame).toMatch(/│▸ alpha-with-a-lon… running !1│/);
    expect(frame).toContain('beta');
    expect(frame).toContain('incompatible');
    // Every box closes on the right edge.
    expect(lines.filter(line => line.length > 0).every(line => /[│╮╯]$/.test(line) || line === KEYS_HINT_STANDALONE)).toBe(true);
  });

  it.each([false, true])('stays below a short terminal, cutting agents but never one needing attention (keys read: %s)', (tty) => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, phase: 'implement' }));
    const stdout = renderIn(20, 34, [project('alpha', 'running', status([
      ...many,
      { id: 'needs-me', attention: { kind: 'question', detail: 'ok?' } },
      { id: 'needs-me-too', attention: { kind: 'permission_prompt', detail: 'allow?' } },
    ]))], tty);

    const frame = lastDrawn(stdout.frames);
    expect(frame.split('\n').length).toBeLessThan(20);
    expect(frame).toContain('needs-me ');
    expect(frame).toContain('needs-me-too');
    expect(frame).toMatch(/\+\d+ more/);
    if (tty) expect(frame.split('\n').at(-1)).toBe(KEYS_HINT_STANDALONE);
  });

  it('keeps attention agents even when they alone overflow the height', () => {
    const stdout = renderIn(14, 34, [project('alpha', 'running', status([
      ...Array.from({ length: 4 }, (_, i) => ({ id: `ask${i}`, attention: { kind: 'question' as Kind, detail: 'ok?' } })),
      { id: 'quiet' },
    ]))]);
    const frame = lastDrawn(stdout.frames);
    for (let i = 0; i < 4; i += 1) expect(frame).toContain(`ask${i}`);
    expect(frame).toContain('+1 more');
  });

  it.each([[34, 30], [32, 16]])('renders %ix%i without shifted or duplicated rows across refreshes', async (columns, rows) => {
    const states = (step: number) => [
      project('alpha', 'running', status(
        Array.from({ length: 1 + step }, (_, i) => ({ id: `w${i}`, phase: 'implement', minutes: i, ...(i % 2 ? { activity: `step ${step}` } : {}) })),
        { master: { agent_id: 'master', status: 'running' } },
      )),
      project('beta', 'stopped', null),
    ];
    const watcher = fakeSource(states(0));
    const stdout = renderIn(rows, columns, watcher, true);
    await settle();

    for (let step = 0; step < 5; step += 1) {
      await settle(() => {
        watcher.set(states(step));
        watcher.emit({ type: 'status', project_id: 'alpha', status: watcher.source.projects()[0].status as StatusView });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const lines = lastDrawn(stdout.frames).split('\n');
      expect(lines.length).toBeLessThan(rows);
      expect(lines[0]).toMatch(/^╭─ Status ─+╮$/);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(columns);
      expect(lines.filter(line => line.includes('master'))).toEqual([]);
      for (let i = 0; i < 1 + step; i += 1) expect(lines.filter(line => line.startsWith(`│w${i} `)).length).toBeLessThanOrEqual(1);
      expect(lines.at(-1)).toBe(KEYS_HINT_STANDALONE);
    }
  });
});
