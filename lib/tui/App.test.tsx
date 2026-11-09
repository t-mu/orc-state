import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './App.tsx';
import type { SpriteMap } from './sprites.ts';
import type { ProjectWatchUpdate } from '../../client.ts';
import { emptyTuiStatus, type TuiWatchSource } from './status.ts';

const { mockBuildStatus, mockBanner } = vi.hoisted(() => ({
  mockBuildStatus: vi.fn(),
  mockBanner: vi.fn(() => 'ORC-STATE'),
}));

/** A watcher with one project at /tmp/state: running with `mockBuildStatus()`, or stopped without a status when it throws. */
const source: TuiWatchSource = {
  projects: () => {
    const project = {
      id: 'p1', name: 'demo', target_repo_root: '/repo', state_dir: '/tmp/state',
      repo_present: true, control_socket: null, coordinator_running: true,
    };
    try {
      return [{ project, connection: 'running', error: null, status: mockBuildStatus(), cursor: 0 }];
    } catch {
      return [{ project: { ...project, coordinator_running: false }, connection: 'stopped', error: null, status: null, cursor: null }];
    }
  },
  onUpdate: () => () => {},
};

vi.mock('../banner.ts', () => ({
  renderBanner: mockBanner,
}));

const sprites: SpriteMap = new Map([
  ['idle', ['IDLE-1', 'IDLE-2']],
  ['work', ['WORK-1', 'WORK-2']],
  ['done', ['DONE-1']],
  ['fail', ['FAIL-1']],
]);

beforeEach(() => {
  vi.useFakeTimers();
  mockBuildStatus.mockReset();
  mockBanner.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App', () => {
  it('shows a project whose coordinator is stopped as stopped, with the empty dashboard', () => {
    mockBuildStatus.mockImplementation(() => {
      throw new Error('no coordinator');
    });

    const app = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    expect(frame).toContain('ORC-STATE');
    expect(frame).toContain('project: demo (p1) → /repo');
    expect(frame).toContain('coordinator: stopped (coordinator not running)');
    expect(frame).toContain('Live Workers');
    expect(frame).toContain('Recent Events');
  });

  it('says so when the state directory belongs to no watched project', () => {
    mockBuildStatus.mockReturnValue(emptyTuiStatus());

    const frame = render(<App source={source} stateDir="/tmp/other" sprites={sprites} intervalMs={1000} />).lastFrame() ?? '';

    expect(frame).toContain('project: (none selected)');
    expect(frame).toContain('project not registered: /tmp/other');
  });

  it('re-renders on a watcher update and lists the other projects with their connection', async () => {
    let listener: ((update: ProjectWatchUpdate) => void) | null = null;
    const project = (id: string, stateDir: string) => ({
      id, name: id, target_repo_root: `/repo/${id}`, state_dir: stateDir,
      repo_present: true, control_socket: null, coordinator_running: true,
    });
    let todo = 1;
    const live: TuiWatchSource = {
      projects: () => [
        { project: project('alpha', '/tmp/state'), connection: 'running', error: null, status: { ...emptyTuiStatus(), tasks: { counts: { todo }, total: todo } } as never, cursor: 1 },
        { project: project('beta', '/tmp/beta'), connection: 'unreachable', error: 'connect ECONNREFUSED', status: null, cursor: null },
      ],
      onUpdate: (fn) => {
        listener = fn;
        return () => { listener = null; };
      },
    };

    const app = render(<App source={live} stateDir="/tmp/state" sprites={sprites} intervalMs={60_000} />);
    expect(app.lastFrame()).toContain('coordinator: running');
    expect(app.lastFrame()).toContain('other projects: beta unreachable');
    expect(app.lastFrame()).toContain('todo: 1');

    todo = 4;
    await act(async () => {
      listener?.({ type: 'event', project_id: 'alpha', row: { seq: 2 } as never });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(app.lastFrame()).toContain('todo: 4');

    await act(async () => {
      app.unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listener).toBeNull();
  });

  it('renders only live registered workers without phantom slot placeholders', () => {
    mockBuildStatus.mockReturnValue({
      worker_capacity: {
        configured_slots: 3,
        used_slots: 1,
        available_slots: 2,
        warming_slots: 0,
        unavailable_slots: 0,
        provider: 'codex',
        dispatch_ready_count: 0,
        waiting_for_capacity: 0,
        slots: [
          {
            agent_id: 'amber-anchor',
            role: 'worker',
            provider: 'codex',
            model: null,
            status: 'running',
            session_handle: 'pty:1',
            slot_state: 'busy',
            active_run_id: 'run-1',
            active_task_ref: 'feat/task-1',
            last_status_change_at: null,
            last_heartbeat_at: null,
          },
        ],
      },
      tasks: { counts: { todo: 2 }, total: 2 },
      scouts: [
        {
          agent_id: 'scout-1',
          provider: 'codex',
          model: null,
          status: 'running',
          session_handle: 'pty:scout-1',
          launched_at: null,
        },
      ],
      claims: {
        active: [
          {
            run_id: 'run-1',
            task_ref: 'feat/task-1',
            agent_id: 'amber-anchor',
            state: 'in_progress',
            age_seconds: 12,
            idle_seconds: 3,
          },
        ],
        total: 1,
        awaiting_run_started: 0,
        in_progress: 1,
        stalled: 0,
      },
      failures: { startup: [], lifecycle: [] },
      recentEvents: [],
      eventReadError: '',
    });

    const app = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    // Only the registered live worker appears — no phantom orc-N placeholders
    expect(frame).toContain('amber-anchor');
    expect(frame).not.toContain('orc-2');
    expect(frame).not.toContain('orc-3');
    // Capacity summary is shown separately from the live worker list
    expect(frame).toContain('1/3 capacity');
    expect(frame).toContain('2 available');
    // Scouts are listed by id and state, not drawn as worker slots
    expect(frame).toContain('Scouts (1)');
    expect(frame).toMatch(/scout-1\s+running\s+attached/);
    expect(frame).not.toContain('[SCOUT]');
  });

  it('refreshes status on the polling interval', async () => {
    mockBuildStatus
      .mockReturnValueOnce({
        worker_capacity: {
          configured_slots: 1,
          used_slots: 0,
          available_slots: 1,
          warming_slots: 0,
          unavailable_slots: 0,
          provider: 'codex',
          dispatch_ready_count: 0,
          waiting_for_capacity: 0,
          slots: [],
        },
        tasks: { counts: { todo: 0 }, total: 0 },
        scouts: [],
        claims: { active: [], total: 0, awaiting_run_started: 0, in_progress: 0, stalled: 0 },
        failures: { startup: [], lifecycle: [] },
        recentEvents: [],
        eventReadError: '',
      })
      .mockReturnValue({
        worker_capacity: {
          configured_slots: 1,
          used_slots: 1,
          available_slots: 0,
          warming_slots: 0,
          unavailable_slots: 0,
          provider: 'codex',
          dispatch_ready_count: 0,
          waiting_for_capacity: 0,
          slots: [
            {
              agent_id: 'orc-1',
              role: 'worker',
              provider: 'codex',
              model: null,
              status: 'running',
              session_handle: 'pty:1',
              slot_state: 'busy',
              active_run_id: 'run-1',
              active_task_ref: 'feat/task-1',
              last_status_change_at: null,
              last_heartbeat_at: null,
            },
          ],
        },
        tasks: { counts: { todo: 1 }, total: 1 },
        scouts: [
        {
          agent_id: 'scout-1',
          provider: 'codex',
          model: null,
          status: 'idle',
          session_handle: null,
          launched_at: null,
        },
      ],
        claims: {
          active: [
            {
              run_id: 'run-1',
              task_ref: 'feat/task-1',
              agent_id: 'orc-1',
              state: 'claimed',
              age_seconds: 5,
              idle_seconds: 5,
            },
          ],
          total: 1,
          awaiting_run_started: 1,
          in_progress: 0,
          stalled: 0,
        },
        failures: { startup: [], lifecycle: [] },
        recentEvents: [{ seq: 1, event: 'claimed', run_id: 'run-1' }],
        eventReadError: '',
      });

    const app = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);

    await vi.advanceTimersByTimeAsync(1000);

    expect(app.lastFrame()).toContain('feat/task-1');
    expect(app.lastFrame()).toContain('scout-1');
    expect(mockBuildStatus).toHaveBeenCalledTimes(3);
  });

  it('event feed shows agent_id and task slug instead of run_id', () => {
    mockBuildStatus.mockReturnValue({
      worker_capacity: {
        configured_slots: 1,
        used_slots: 0,
        available_slots: 1,
        warming_slots: 0,
        unavailable_slots: 0,
        provider: 'codex',
        dispatch_ready_count: 0,
        waiting_for_capacity: 0,
        slots: [],
      },
      tasks: { counts: {}, total: 0 },
      scouts: [],
      claims: { active: [], total: 0, awaiting_run_started: 0, in_progress: 0, stalled: 0 },
      failures: { startup: [], lifecycle: [] },
      recentEvents: [
        { seq: 1, event: 'run_started', run_id: 'run-abc', agent_id: 'orc-1', task_ref: 'publish/111-fix-package-json' },
        { seq: 2, event: 'session_started', run_id: null, agent_id: null, task_ref: null },
      ],
      eventReadError: '',
    });

    const app = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    expect(frame).toContain('orc-1 run_started 111-fix-package-json');
    expect(frame).not.toContain('run-abc');
    expect(frame).toContain('session_started');
  });

  it('flags a worker waiting for input on its slot and in the header', () => {
    const slot = (agent_id: string, run: string) => ({
      agent_id, role: 'worker', provider: 'claude', model: null, status: 'running', session_handle: `tmux:${agent_id}`,
      slot_state: 'busy', active_run_id: run, active_task_ref: `feat/${run}`, last_status_change_at: null, last_heartbeat_at: null,
    });
    const claim = (agent_id: string, run: string) => ({
      run_id: run, task_ref: `feat/${run}`, agent_id, state: 'in_progress', age_seconds: 60, idle_seconds: 5,
    });
    const status = {
      worker_capacity: {
        configured_slots: 2, used_slots: 2, available_slots: 0, warming_slots: 0, unavailable_slots: 0,
        provider: 'claude', dispatch_ready_count: 0, waiting_for_capacity: 0,
        slots: [slot('asking-orc', 'run-a'), slot('busy-orc', 'run-b')],
      },
      tasks: { counts: {}, total: 0 },
      scouts: [],
      claims: { active: [claim('asking-orc', 'run-a'), claim('busy-orc', 'run-b')], total: 2, awaiting_run_started: 0, in_progress: 2, stalled: 0 },
      failures: { startup: [], lifecycle: [] },
      waiting_input: [{ run_id: 'run-a', agent_id: 'asking-orc', task_ref: 'feat/run-a', question: 'Use schema v2?', waiting_seconds: 42 }],
      recentEvents: [],
      eventReadError: '',
    };
    mockBuildStatus.mockReturnValue(status);

    const app = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    expect(frame).toContain('1 WAITING FOR INPUT');
    expect(frame).toContain('answer: orc run-input-respond');
    expect(frame.match(/NEEDS INPUT/g)).toHaveLength(1);
    expect(frame).toContain('waiting 42s');
    expect(frame).toContain('? Use schema v2?');

    cleanup();
    mockBuildStatus.mockReturnValue({ ...status, waiting_input: [] });
    const quiet = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />).lastFrame() ?? '';
    expect(quiet).not.toContain('NEEDS INPUT');
    expect(quiet).not.toContain('WAITING FOR INPUT');
  });

  it('worker slot shows activity and heartbeat separately', () => {
    mockBuildStatus.mockReturnValue({
      worker_capacity: {
        configured_slots: 1,
        used_slots: 1,
        available_slots: 0,
        warming_slots: 0,
        unavailable_slots: 0,
        provider: 'codex',
        dispatch_ready_count: 0,
        waiting_for_capacity: 0,
        slots: [
          {
            agent_id: 'orc-1',
            role: 'worker',
            provider: 'codex',
            model: null,
            status: 'running',
            session_handle: 'pty:1',
            slot_state: 'busy',
            active_run_id: 'run-1',
            active_task_ref: 'feat/task-1',
            last_status_change_at: null,
            last_heartbeat_at: null,
          },
        ],
      },
      tasks: { counts: { in_progress: 1 }, total: 1 },
      scouts: [],
      claims: {
        active: [
          {
            run_id: 'run-1',
            task_ref: 'feat/task-1',
            agent_id: 'orc-1',
            state: 'in_progress',
            age_seconds: 120,
            idle_seconds: 12,
            activity_seconds: 12,
            heartbeat_seconds: 48,
          },
        ],
        total: 1,
        awaiting_run_started: 0,
        in_progress: 1,
        stalled: 0,
      },
      failures: { startup: [], lifecycle: [] },
      recentEvents: [],
      eventReadError: '',
    });

    const app = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    expect(frame).toContain('activity: 12s');
    expect(frame).toContain('heartbeat: 48s');
    expect(frame).not.toContain('idle:');
  });
});
