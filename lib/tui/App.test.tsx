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
    expect(mockBuildStatus).toHaveBeenCalledTimes(3);
  });
});
