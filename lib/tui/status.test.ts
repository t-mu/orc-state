import { describe, it, expect } from 'vitest';
import type { ProjectWatchState, StatusView } from '../../client.ts';
import { buildProjectViews, buildWorkerSlotViewModels, describeConnection } from './status.ts';
import type { TuiStatus } from './status.ts';

const liveSlot: TuiStatus['worker_capacity']['slots'][number] = {
  agent_id: 'orc-1',
  role: 'worker',
  provider: 'claude',
  model: null,
  status: 'running',
  session_handle: 'tmux:orc-1',
  slot_state: 'busy',
  active_run_id: null,
  active_task_ref: null,
  last_status_change_at: null,
  last_heartbeat_at: null,
};

describe('buildWorkerSlotViewModels — live workers only', () => {
  const baseStatus: TuiStatus = {
    worker_capacity: {
      configured_slots: 3,
      used_slots: 0,
      available_slots: 3,
      warming_slots: 0,
      unavailable_slots: 0,
      provider: 'claude',
      dispatch_ready_count: 0,
      waiting_for_capacity: 0,
      slots: [],
    },
    scouts: [],
    tasks: { counts: {}, total: 0 },
    claims: { active: [], total: 0, awaiting_run_started: 0, in_progress: 0, stalled: 0 },
    failures: { startup: [], lifecycle: [] },
    recentEvents: [],
    eventReadError: '',
  };

  it('returns empty array when no workers are registered, even if configured_slots > 0', () => {
    const vms = buildWorkerSlotViewModels(baseStatus);
    expect(vms).toHaveLength(0);
  });

  it('renders only registered live workers, not phantom orc-N slot placeholders', () => {
    const status: TuiStatus = {
      ...baseStatus,
      worker_capacity: {
        ...baseStatus.worker_capacity,
        used_slots: 1,
        available_slots: 2,
        slots: [{ ...liveSlot, agent_id: 'amber-anchor', active_run_id: 'run-1', active_task_ref: 'feat/task-1' }],
      },
    };
    const vms = buildWorkerSlotViewModels(status);
    expect(vms).toHaveLength(1);
    expect(vms[0].slot_id).toBe('amber-anchor');
  });

  it('removes a worker from the view when its task-scoped session ends', () => {
    const statusWithWorker: TuiStatus = {
      ...baseStatus,
      worker_capacity: { ...baseStatus.worker_capacity, slots: [{ ...liveSlot, agent_id: 'amber-anchor' }] },
    };
    expect(buildWorkerSlotViewModels(statusWithWorker)).toHaveLength(1);

    const statusAfterEnd: TuiStatus = {
      ...baseStatus,
      worker_capacity: { ...baseStatus.worker_capacity, slots: [] },
    };
    expect(buildWorkerSlotViewModels(statusAfterEnd)).toHaveLength(0);
  });
});

describe('buildWorkerSlotViewModels — one live slot', () => {
  const baseStatus: TuiStatus = {
    worker_capacity: {
      configured_slots: 1,
      used_slots: 1,
      available_slots: 0,
      warming_slots: 0,
      unavailable_slots: 0,
      provider: 'claude',
      dispatch_ready_count: 0,
      waiting_for_capacity: 0,
      slots: [liveSlot],
    },
    scouts: [],
    tasks: { counts: {}, total: 0 },
    claims: { active: [], total: 0, awaiting_run_started: 0, in_progress: 0, stalled: 0 },
    failures: { startup: [], lifecycle: [] },
    recentEvents: [],
    eventReadError: '',
  };

  it('keeps scouts out of the worker slots', () => {
    const vms = buildWorkerSlotViewModels({
      ...baseStatus,
      scouts: [{ agent_id: 'scout-1', provider: 'claude', model: null, status: 'running', session_handle: 'tmux:s', launched_at: null }],
    });
    expect(vms.map((vm) => vm.slot_id)).toEqual(['orc-1']);
  });

  it('carries current_activity from the active claim', () => {
    const activity = { text: 'Running npm test', source: 'tool' as const, ts: '2026-01-01T00:00:00Z' };
    const vms = buildWorkerSlotViewModels({
      ...baseStatus,
      claims: {
        ...baseStatus.claims,
        active: [{
          run_id: 'run-1', task_ref: 't/1', agent_id: 'orc-1', state: 'in_progress', age_seconds: 1, idle_seconds: 1,
          activity_seconds: 1, heartbeat_seconds: 1, current_phase: 'implement', current_activity: activity,
        }],
      },
    });
    expect(vms[0].current_activity).toEqual(activity);
    expect(vms[0].activity_label).toBe('Running npm test');
    expect(buildWorkerSlotViewModels(baseStatus)[0].current_activity).toBeNull();
    expect(buildWorkerSlotViewModels(baseStatus)[0].activity_label).toBeNull();
  });

  it('carries the slot attention from the status view', () => {
    const attention = { kind: 'question' as const, run_id: 'run-1', since: '2026-01-01T00:00:00Z', detail: 'Use v2?', request_id: 'req-1' };
    const vms = buildWorkerSlotViewModels({
      ...baseStatus,
      worker_capacity: { ...baseStatus.worker_capacity, slots: [{ ...liveSlot, attention }] },
    });
    expect(vms[0].attention).toEqual(attention);
    expect(buildWorkerSlotViewModels(baseStatus)[0].attention).toBeNull();
  });

  it('marks the slot whose run waits for input, with the question on one line', () => {
    const claim = {
      run_id: 'run-1', task_ref: 't/1', agent_id: 'orc-1', state: 'in_progress', age_seconds: 1, idle_seconds: 1,
      activity_seconds: 1, heartbeat_seconds: 1, current_phase: 'implement',
    };
    const vms = buildWorkerSlotViewModels({
      ...baseStatus,
      claims: { ...baseStatus.claims, active: [claim] },
      waiting_input: [{ run_id: 'run-1', agent_id: 'orc-1', task_ref: 't/1', question: 'Which\n  schema?', waiting_seconds: 42 }],
    });
    expect(vms[0].waiting_input).toEqual({ waiting_seconds: 42, question: 'Which schema?' });

    // A waiting row for another run leaves this slot alone.
    const other = buildWorkerSlotViewModels({
      ...baseStatus,
      claims: { ...baseStatus.claims, active: [claim] },
      waiting_input: [{ run_id: 'run-old', agent_id: 'orc-1', task_ref: 't/0', question: 'q', waiting_seconds: 1 }],
    });
    expect(other[0].waiting_input).toBeNull();
  });
});

describe('project views from the watcher', () => {
  const project = (id: string, stateDir: string) => ({
    id, name: `name-${id}`, target_repo_root: `/repo/${id}`, state_dir: stateDir,
    repo_present: true, control_socket: null, coordinator_running: true,
  });
  const status = { cursor: 3, project: { id: 'a', name: 'name-a', target_repo_root: '/repo/a' } } as unknown as StatusView;
  const states: ProjectWatchState[] = [
    { project: project('a', '/state/a'), connection: 'running', error: null, status, cursor: 3 },
    { project: project('b', '/state/b'), connection: 'stopped', error: null, status, cursor: 3 },
    { project: project('c', '/state/c'), connection: 'unreachable', error: 'connect ECONNREFUSED', status: null, cursor: null },
  ];

  it('builds one view per watched project, marking a kept status of a not-running project stale', () => {
    const views = buildProjectViews(states);
    expect(views.map((v) => [v.project_id, v.name, v.state_dir, v.connection, v.stale])).toEqual([
      ['a', 'name-a', '/state/a', 'running', false],
      ['b', 'name-b', '/state/b', 'stopped', true],
      ['c', 'name-c', '/state/c', 'unreachable', false],
    ]);
    expect(views[0].status).toBe(status);
    expect(views[2].status).toBeNull();
  });

  it('describes the connection, with the error when there is one', () => {
    expect(describeConnection({ connection: 'running', error: null })).toBe('running');
    expect(describeConnection({ connection: 'stopped', error: null })).toBe('stopped (coordinator not running)');
    expect(describeConnection({ connection: 'unreachable', error: 'connect ECONNREFUSED' })).toBe('unreachable: connect ECONNREFUSED');
  });
});
