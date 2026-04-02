import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { App } from './App.tsx';
import type { SpriteMap } from './sprites.ts';

const { mockBuildStatus, mockBanner } = vi.hoisted(() => ({
  mockBuildStatus: vi.fn(),
  mockBanner: vi.fn(() => 'ORC-STATE'),
}));

vi.mock('../statusView.ts', () => ({
  buildStatus: mockBuildStatus,
}));

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
  it('renders without crashing when buildStatus throws for a missing state dir', () => {
    mockBuildStatus.mockImplementation(() => {
      throw new Error('missing state');
    });

    const app = render(<App stateDir="/tmp/nonexistent-orc" sprites={sprites} intervalMs={1000} />);

    expect(app.lastFrame()).toContain('ORC-STATE');
    expect(app.lastFrame()).toContain('Worker Slots');
    expect(app.lastFrame()).toContain('Recent Events');
  });

  it('renders one slot per configured worker slot', () => {
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
      tasks: { counts: { todo: 2 }, total: 2 },
      scout_capacity: {
        total_slots: 1,
        investigating_slots: 1,
        idle_slots: 0,
        warming_slots: 0,
        unavailable_slots: 0,
        slots: [
          {
            agent_id: 'scout-1',
            role: 'scout',
            provider: 'codex',
            model: null,
            status: 'running',
            session_handle: 'pty:scout-1',
            slot_state: 'investigating',
            active_run_id: null,
            active_task_ref: null,
            last_status_change_at: null,
            last_heartbeat_at: null,
          },
        ],
      },
      claims: {
        active: [
          {
            run_id: 'run-1',
            task_ref: 'feat/task-1',
            agent_id: 'orc-1',
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

    const app = render(<App stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    expect(frame).toContain('orc-1');
    expect(frame).toContain('orc-2');
    expect(frame).toContain('orc-3');
    expect(frame).toContain('scout-1');
    expect(frame).toContain('[SCOUT]');
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
        scout_capacity: {
          total_slots: 0,
          investigating_slots: 0,
          idle_slots: 0,
          warming_slots: 0,
          unavailable_slots: 0,
          slots: [],
        },
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
        scout_capacity: {
          total_slots: 1,
          investigating_slots: 0,
          idle_slots: 1,
          warming_slots: 0,
          unavailable_slots: 0,
          slots: [
            {
              agent_id: 'scout-1',
              role: 'scout',
              provider: 'codex',
              model: null,
              status: 'idle',
              session_handle: null,
              slot_state: 'idle',
              active_run_id: null,
              active_task_ref: null,
              last_status_change_at: null,
              last_heartbeat_at: null,
            },
          ],
        },
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

    const app = render(<App stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);

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
      scout_capacity: { total_slots: 0, investigating_slots: 0, idle_slots: 0, warming_slots: 0, unavailable_slots: 0, slots: [] },
      claims: { active: [], total: 0, awaiting_run_started: 0, in_progress: 0, stalled: 0 },
      failures: { startup: [], lifecycle: [] },
      recentEvents: [
        { seq: 1, event: 'run_started', run_id: 'run-abc', agent_id: 'orc-1', task_ref: 'publish/111-fix-package-json' },
        { seq: 2, event: 'session_started', run_id: null, agent_id: null, task_ref: null },
      ],
      eventReadError: '',
    });

    const app = render(<App stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    expect(frame).toContain('orc-1 run_started 111-fix-package-json');
    expect(frame).not.toContain('run-abc');
    expect(frame).toContain('session_started');
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
      scout_capacity: { total_slots: 0, investigating_slots: 0, idle_slots: 0, warming_slots: 0, unavailable_slots: 0, slots: [] },
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

    const app = render(<App stateDir="/tmp/state" sprites={sprites} intervalMs={1000} />);
    const frame = app.lastFrame() ?? '';

    expect(frame).toContain('activity: 12s');
    expect(frame).toContain('heartbeat: 48s');
    expect(frame).not.toContain('idle:');
  });
});
