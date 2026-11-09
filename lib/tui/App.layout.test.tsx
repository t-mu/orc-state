import { EventEmitter } from 'node:events';
import React, { act } from 'react';
import { render, type Instance } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { renderSpriteMap } from './sprites.ts';
import type { TuiWatchSource } from './status.ts';

const { mockBuildStatus } = vi.hoisted(() => ({ mockBuildStatus: vi.fn() }));

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

/** A terminal of fixed size that records the frames Ink writes. */
class FakeStdout extends EventEmitter {
  rows: number;
  columns: number;
  frames: string[] = [];

  constructor(rows: number, columns: number) {
    super();
    this.rows = rows;
    this.columns = columns;
  }

  write = (frame: string) => {
    this.frames.push(frame);
    return true;
  };

  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }

  resize(rows: number, columns: number): void {
    this.rows = rows;
    this.columns = columns;
    this.emit('resize');
  }
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

const sprites = renderSpriteMap();
const now = Date.parse('2026-11-09T10:00:00Z');

function worker(agentId: string, runId: string) {
  return {
    agent_id: agentId,
    role: 'worker',
    provider: 'claude',
    model: 'opus',
    status: 'running',
    session_handle: `pty:${agentId}`,
    slot_state: 'busy',
    active_run_id: runId,
    active_task_ref: `general/${runId}-task`,
    last_status_change_at: null,
    last_heartbeat_at: null,
  };
}

function claim(agentId: string, runId: string) {
  return {
    run_id: runId,
    task_ref: `general/${runId}-task`,
    agent_id: agentId,
    state: 'in_progress',
    age_seconds: 600,
    idle_seconds: 5,
    activity_seconds: 5,
    heartbeat_seconds: 5,
    phase_history: [
      { phase: 'explore', started_at: '2026-11-09T09:50:00Z' },
      { phase: 'implement', started_at: '2026-11-09T09:55:00Z' },
    ],
    current_activity: { text: 'Editing lib/tui/App.tsx', source: 'tool', ts: '2026-11-09T09:59:55Z' },
  };
}

function busyStatus({ scouts = 3, runs = 2, events = 30 } = {}) {
  const workers = [worker('amber-anchor', 'run-1'), worker('brisk-badger', 'run-2')];
  const claims = [claim('amber-anchor', 'run-1'), claim('brisk-badger', 'run-2')];
  for (let i = 3; i <= runs; i += 1) claims.push(claim(`queued-${i}`, `run-${i}`));
  return {
    worker_capacity: {
      configured_slots: 2,
      used_slots: 2,
      available_slots: 0,
      warming_slots: 0,
      unavailable_slots: 0,
      provider: 'claude',
      dispatch_ready_count: 0,
      waiting_for_capacity: 0,
      slots: workers,
    },
    tasks: { counts: { todo: 4 }, total: 6 },
    scouts: Array.from({ length: scouts }, (_, i) => ({
      agent_id: `scout-${i + 1}`,
      provider: 'claude',
      model: null,
      status: 'running',
      session_handle: `pty:scout-${i + 1}`,
      launched_at: null,
    })),
    claims: {
      active: claims.slice(0, runs),
      total: runs,
      awaiting_run_started: 0,
      in_progress: runs,
      stalled: 0,
    },
    failures: { startup: [], lifecycle: [] },
    recentEvents: Array.from({ length: events }, (_, i) => ({
      seq: i + 1,
      event: 'heartbeat',
      agent_id: i % 2 === 0 ? 'amber-anchor' : 'brisk-badger',
      task_ref: `general/event-${i + 1}`,
    })),
    eventReadError: '',
  };
}

let instance: Instance | null = null;

function renderApp(stdout: FakeStdout): Instance {
  instance = render(<App source={source} stateDir="/tmp/state" sprites={sprites} intervalMs={60_000} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  return instance;
}

function lineCount(frame: string): number {
  return frame.split('\n').length;
}

beforeEach(() => {
  vi.useFakeTimers({ now });
  mockBuildStatus.mockReset();
});

afterEach(() => {
  instance?.unmount();
  instance = null;
  vi.useRealTimers();
});

describe('App height budget', () => {
  it('keeps the frame below 40 rows with 2 workers and a full event feed', () => {
    mockBuildStatus.mockReturnValue(busyStatus());
    const stdout = new FakeStdout(40, 120);
    renderApp(stdout);

    const frame = stdout.lastFrame();
    expect(lineCount(frame)).toBeLessThan(40);
    expect(frame).toContain('amber-anchor');
    expect(frame).toContain('brisk-badger');
    // The newest event is kept; older ones are counted.
    expect(frame).toContain('event-30');
    expect(frame).toMatch(/\+\d+ more/);
  });

  it('stays below the terminal height on every render, sprite animation included', async () => {
    mockBuildStatus.mockReturnValue(busyStatus());
    const stdout = new FakeStdout(40, 120);
    renderApp(stdout);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(stdout.frames.length).toBeGreaterThan(0);
    for (const frame of stdout.frames) {
      expect(lineCount(frame)).toBeLessThan(40);
    }
  });

  it('re-budgets the sections when the terminal is resized', async () => {
    mockBuildStatus.mockReturnValue(busyStatus({ scouts: 6, runs: 6, events: 10 }));
    const stdout = new FakeStdout(80, 120);
    renderApp(stdout);
    // Let React run the effects that subscribe to resize (fake timers hold them).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const tall = stdout.lastFrame();
    expect(lineCount(tall)).toBeLessThan(80);
    expect(tall).not.toMatch(/\+\d+ more/);
    expect(tall).toContain('scout-6');

    act(() => {
      stdout.resize(30, 80);
    });

    const short = stdout.lastFrame();
    expect(lineCount(short)).toBeLessThan(30);
    expect(short).toMatch(/\+\d+ more/);

    act(() => {
      stdout.resize(80, 120);
    });
    expect(stdout.lastFrame()).toContain('scout-6');
  });

  it('two workers that wrap onto two rows still fit a 40-row terminal', () => {
    mockBuildStatus.mockReturnValue(busyStatus());
    const stdout = new FakeStdout(40, 60);
    renderApp(stdout);

    const frame = stdout.lastFrame();
    expect(lineCount(frame)).toBeLessThan(40);
    expect(frame).toContain('amber-anchor');
    expect(frame).toContain('brisk-badger');
  });
});
