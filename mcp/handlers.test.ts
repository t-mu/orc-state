import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, readBacklog, seedProjectTasks, TEST_PROJECT_ID, type SeedTask } from '../test-fixtures/stateHelpers.ts';
import { initProjectTaskStore, refreshBacklogProjection } from '../lib/projectTasks.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryEvents } from '../lib/eventLog.ts';

import {
  handleGetAgentWorkview,
  handleGetStatus,
  handleGetTask,
  handleListAgents,
  handleListRuns,
  handleListTasks,
  handleCreateTask,
  handleUpdateTask,
  handleGetRun,
  handleQueryEvents,
  handleListWorktrees,
  handleMemoryWakeUp,
  handleMemorySearch,
  handleMemoryStore,
  handleMemoryStatus,
  closeMemoryDb,
} from './handlers.ts';
import { cancelTask, delegateTask, resetTask, respondInput } from '../lib/operatorMutations.ts';
import { writeRunActivity } from '../lib/runActivityStore.ts';
import { startControlServer } from '../lib/controlServer.ts';

let dir: string;

function seedBacklog(features: Array<{ ref: string; title: string; tasks: SeedTask[] }>) {
  seedProjectTasks(dir, features.flatMap((feature) => feature.tasks));
}

/** Adds tasks to the project task store. */
function seedTasks(tasks: SeedTask[]) {
  seedProjectTasks(dir, tasks);
}

/** Sets a seeded task's runtime-owned dispatch fields in the project task store. */
function setTaskOwner(taskRef: string, owner: string | null) {
  initProjectTaskStore(dir).setDispatchState(taskRef, { owner });
  refreshBacklogProjection(dir);
}

function seedAgents(agents: unknown[]) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }, null, 2));
}

function seedClaims(claims: unknown[]) {
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }, null, 2));
}

function seedEventsLines(lines: string[]) {
  const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
  writeFileSync(join(dir, 'events.jsonl'), body);
}

beforeEach(() => {
  dir = createTempStateDir('orc-mcp-handlers-test-');
  seedBacklog([
    {
      ref: 'project',
      title: 'Project',
      tasks: [
        {
          ref: 'project/todo-one',
          title: 'Todo one',
          status: 'todo',
          task_type: 'implementation',
          planning_state: 'ready_for_dispatch',
          delegated_by: 'master',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          ref: 'project/done-one',
          title: 'Done one',
          status: 'done',
          task_type: 'implementation',
          planning_state: 'ready_for_dispatch',
          delegated_by: 'master',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
    {
      ref: 'infra',
      title: 'Infra',
      tasks: [
        {
          ref: 'infra/blocked-one',
          title: 'Blocked one',
          status: 'blocked',
          task_type: 'refactor',
          planning_state: 'ready_for_dispatch',
          delegated_by: 'master',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  ]);
  seedAgents([
    {
      agent_id: 'master',
      provider: 'claude',
      role: 'master',
      status: 'idle',
      session_handle: null,
      last_heartbeat_at: null,
      registered_at: '2026-01-01T00:00:00.000Z',
    },
    {
      agent_id: 'orc-1',
      provider: 'codex',
      role: 'worker',
      status: 'running',
      session_handle: 'tmux:1',
      last_heartbeat_at: '2026-01-01T00:01:00.000Z',
      registered_at: '2026-01-01T00:00:00.000Z',
    },
    {
      agent_id: 'orc-dead',
      provider: 'codex',
      role: 'worker',
      status: 'dead',
      session_handle: null,
      last_heartbeat_at: '2026-01-01T00:01:00.000Z',
      registered_at: '2026-01-01T00:00:00.000Z',
    },
  ]);
  seedClaims([
    {
      run_id: 'run-1',
      task_ref: 'project/todo-one',
      agent_id: 'orc-1',
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:00:05.000Z',
      last_heartbeat_at: '2026-01-01T00:00:06.000Z',
      lease_expires_at: '2026-01-01T00:10:00.000Z',
    },
    {
      run_id: 'run-2',
      task_ref: 'project/done-one',
      agent_id: 'orc-2',
      state: 'claimed',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      last_heartbeat_at: null,
      lease_expires_at: '2026-01-01T00:10:00.000Z',
    },
    {
      run_id: 'run-3',
      task_ref: 'infra/blocked-one',
      agent_id: 'orc-3',
      state: 'released',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      last_heartbeat_at: null,
      lease_expires_at: '2026-01-01T00:10:00.000Z',
    },
  ]);
  seedEventsLines([
    JSON.stringify({ seq: 1, event: 'task_added', task_ref: 'project/todo-one' }),
    'malformed{',
    JSON.stringify({ seq: 2, event: 'task_delegated', task_ref: 'project/todo-one' }),
    JSON.stringify({ seq: 3, event: 'run_started', task_ref: 'project/todo-one' }),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempStateDir(dir);
});

describe('mcp read handlers', () => {
  it('handleListTasks returns non-terminal tasks by default and supports status/feature filters', () => {
    // Default excludes done to keep payload small.
    const all = handleListTasks(dir);
    expect(all).toHaveLength(2);
    expect(all.map((task) => task.ref)).toEqual(['infra/blocked-one', 'project/todo-one']);
    expect(all.every((task) => typeof task.feature_ref === 'string')).toBe(true);

    // Verbose fields are stripped in list view.
    expect(all.every((task) => !('description' in task))).toBe(true);
    expect(all.every((task) => !('acceptance_criteria' in task))).toBe(true);
    expect(all.every((task) => typeof task.priority === 'string')).toBe(true);
    expect(all.find((task) => task.ref === 'project/todo-one')?.priority).toBe('normal');

    // Explicit status= includes terminal tasks.
    const done = handleListTasks(dir, { status: 'done' });
    expect(done.map((task) => task.ref)).toEqual(['project/done-one']);

    expect(() => handleListTasks(dir, { status: 'released' })).toThrow('Invalid status: released');
    const todo = handleListTasks(dir, { status: 'todo' });
    expect(todo.map((task) => task.ref)).toEqual(['project/todo-one']);

    const infra = handleListTasks(dir, { feature: 'infra' });
    expect(infra.map((task) => task.ref)).toEqual(['infra/blocked-one']);
  });

  it('handleListTasks excludes cancelled tasks by default and returns them when requested', () => {
    seedTasks([{
      ref: 'project/cancelled-one',
      title: 'Cancelled one',
      status: 'cancelled',
      task_type: 'implementation',
      planning_state: 'ready_for_dispatch',
      delegated_by: 'master',
      created_at: '2026-01-01T00:00:00.000Z',
    }]);

    expect(handleListTasks(dir).some((task) => task.ref === 'project/cancelled-one')).toBe(false);
    expect(handleListTasks(dir, { status: 'cancelled' }).map((task) => task.ref)).toEqual(['project/cancelled-one']);
  });

  it('handleListAgents omits dead by default, includes dead when requested, and supports role filter', () => {
    const all = handleListAgents(dir) as Array<Record<string, unknown>>;
    expect(all).toHaveLength(2);
    expect(all.some((agent) => agent.agent_id === 'orc-dead')).toBe(false);
    expect(all.find((agent) => agent.agent_id === 'orc-1')?.active_task_ref).toBe('project/todo-one');
    expect(all.find((agent) => agent.agent_id === 'master')?.active_task_ref).toBeNull();

    const withDead = handleListAgents(dir, { include_dead: true }) as Array<Record<string, unknown>>;
    expect(withDead).toHaveLength(3);
    expect(withDead.some((agent) => agent.agent_id === 'orc-dead')).toBe(true);
    expect(withDead.find((agent) => agent.agent_id === 'orc-dead')?.active_task_ref).toBeNull();

    const workers = handleListAgents(dir, { role: 'worker' }) as Array<Record<string, unknown>>;
    expect(workers).toHaveLength(1);
    expect(workers[0].agent_id).toBe('orc-1');
    expect(workers[0].active_task_ref).toBe('project/todo-one');
  });

  it('handleListAgents lists a scout by id and state, without worker fields', () => {
    seedAgents([{
      agent_id: 'scout-1',
      provider: 'claude',
      role: 'scout',
      status: 'running',
      session_handle: 'tmux:scout-1',
      session_token: 'secret',
      last_heartbeat_at: null,
      registered_at: '2026-01-01T00:00:00.000Z',
    }]);
    expect(handleListAgents(dir, { role: 'scout' })).toEqual([{
      agent_id: 'scout-1',
      role: 'scout',
      provider: 'claude',
      model: null,
      status: 'running',
      session_handle: 'tmux:scout-1',
      launched_at: '2026-01-01T00:00:00.000Z',
    }]);
  });

  it('handleListRuns lists live runs (claimed/in_progress) with the shared row shape', () => {
    const now = new Date('2026-01-01T00:20:00.000Z').getTime();
    const { runs } = handleListRuns(dir, { now_ms: now });
    expect(runs.map((run) => run.run_id).sort()).toEqual(['run-1', 'run-2']);
    expect(runs.find((run) => run.run_id === 'run-1')).toEqual({
      run_id: 'run-1', task_ref: 'project/todo-one', agent_id: 'orc-1', state: 'in_progress',
      phase: null, age_seconds: 1195, idle_seconds: 1194, stalled: true,
    });
  });

  it('handleListRuns state=stalled applies stale_after_ms', () => {
    const now = new Date('2026-01-01T00:20:00.000Z').getTime();
    const stale = handleListRuns(dir, { state: 'stalled', stale_after_ms: 60_000, now_ms: now }).runs;
    // run-2 is claimed with no TASK_START delivered yet: no idle anchor, so it is never stalled.
    expect(stale.map((run) => [run.run_id, run.idle_seconds])).toEqual([['run-1', 1194]]);
    expect(handleListRuns(dir, { state: 'stalled', stale_after_ms: 1_300_000, now_ms: now }).runs).toEqual([]);
  });

  it('handleListRuns state=stalled counts hook activity and skips a run with a tool call still running', () => {
    const now = new Date('2026-01-01T00:20:00.000Z').getTime();
    writeRunActivity(dir, {
      'run-1': {
        run_id: 'run-1', agent_id: 'orc-1', label: 'Bash: npm test', source: 'tool', label_ts: '2026-01-01T00:19:30.000Z',
        last_tool: 'Bash', last_tool_brief: 'npm test', last_tool_ts: '2026-01-01T00:19:30.000Z',
      },
      'run-2': {
        run_id: 'run-2', agent_id: 'orc-2', label: null, source: null, label_ts: null,
        last_tool: null, last_tool_brief: null, last_tool_ts: null, open_tools: { toolu_1: '2026-01-01T00:05:00.000Z' },
      },
    });
    expect(handleListRuns(dir, { state: 'stalled', stale_after_ms: 60_000, now_ms: now }).runs).toEqual([]);
    const later = handleListRuns(dir, { state: 'stalled', stale_after_ms: 20_000, now_ms: now }).runs;
    expect(later.map((run) => [run.run_id, run.idle_seconds])).toEqual([['run-1', 30]]);
  });

  it('handleListRuns state=stalled skips a run waiting for an input response (shared isStalled)', () => {
    const now = new Date('2026-01-01T00:20:00.000Z').getTime();
    seedClaims([
      { run_id: 'run-1', task_ref: 'project/todo-one', agent_id: 'orc-1', state: 'in_progress', claimed_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: '2026-01-01T00:00:06.000Z', lease_expires_at: '2026-01-01T00:30:00.000Z', input_state: 'awaiting_input' },
      { run_id: 'run-2', task_ref: 'project/done-one', agent_id: 'orc-2', state: 'in_progress', claimed_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: '2026-01-01T00:00:06.000Z', lease_expires_at: '2026-01-01T00:30:00.000Z' },
    ]);
    const stale = handleListRuns(dir, { state: 'stalled', stale_after_ms: 60_000, now_ms: now }).runs;
    expect(stale.map((run) => run.run_id)).toEqual(['run-2']);
  });

  it('handleListRuns reports the latest phase of each run', () => {
    seedEventsLines([
      JSON.stringify({ seq: 10, ts: '2026-01-01T00:01:00.000Z', event: 'phase_started', actor_type: 'agent', actor_id: 'orc-1', run_id: 'run-1', task_ref: 'project/todo-one', agent_id: 'orc-1', phase: 'explore' }),
      JSON.stringify({ seq: 11, ts: '2026-01-01T00:02:00.000Z', event: 'phase_started', actor_type: 'agent', actor_id: 'orc-1', run_id: 'run-1', task_ref: 'project/todo-one', agent_id: 'orc-1', phase: 'implement' }),
    ]);
    const run1 = handleListRuns(dir).runs.find((run) => run.run_id === 'run-1');
    expect(run1?.phase).toBe('implement');
  });

  it('handleListRuns rejects an unknown state and a negative stale_after_ms', () => {
    expect(() => handleListRuns(dir, { state: 'done' })).toThrow(/state must be one of active, stalled, waiting_input/);
    expect(() => handleListRuns(dir, { stale_after_ms: -1 })).toThrow(/stale_after_ms/);
  });

  it('handleGetTask returns task or not_found error', () => {
    const task = handleGetTask(dir, { task_ref: 'project/todo-one' }) as Record<string, unknown>;
    expect(task.ref).toBe('project/todo-one');

    const missing = handleGetTask(dir, { task_ref: 'project/missing' });
    expect(missing).toEqual({ error: 'not_found', task_ref: 'project/missing' });
  });

  it('handleGetStatus names the registered project a state directory belongs to', async () => {
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'p-1', name: 'demo', target_repo_root: '/tmp/demo' }));
    expect((await handleGetStatus(dir)).project).toEqual({ id: 'p-1', name: 'demo', target_repo_root: '/tmp/demo' });
  });

  it('handleGetStatus returns aggregate keys and expected value shapes', async () => {
    const status = await handleGetStatus(dir);

    expect(Object.keys(status).sort()).toEqual(
      ['active_tasks', 'agents', 'coordinator', 'last_notification_seq', 'project', 'stalled_runs', 'task_counts', 'waiting_input'].sort(),
    );
    // No coordinator runs in a temp state directory.
    expect(status.coordinator).toEqual({ running: false, pid: null, version: null, started_at: null, stale: null });
    expect(status.waiting_input).toBe(0);
    expect((status.agents as Array<Record<string, unknown>>).every((agent) =>
      ['agent_id', 'role', 'status', 'provider', 'active_task_ref'].every((key) => Object.hasOwn(agent, key)))).toBe(true);
    expect((status.agents as Array<Record<string, unknown>>).some((agent) => agent.agent_id === 'orc-dead')).toBe(false);
    expect(status.task_counts).toEqual({
      todo: 1,
      claimed: 0,
      in_progress: 0,
      blocked: 1,
    });
    expect((status.active_tasks as Array<Record<string, unknown>>).every((task) =>
      ['ref', 'title', 'status', 'feature_ref', 'owner'].every((key) => Object.hasOwn(task, key)))).toBe(true);
    expect((status.active_tasks as Array<Record<string, unknown>>).some((task) => task.status === 'done')).toBe(false);
    expect(status.last_notification_seq).toBe(0);
    expect(status.stalled_runs).toBe(1);
    expect(status.project).toMatchObject({ id: TEST_PROJECT_ID });
  });

  it('handleGetStatus reports a running coordinator with the pid, version and start time from its health', async () => {
    const control = await startControlServer(dir);
    // This test process stands in for the coordinator process; health comes from the real control server.
    vi.resetModules();
    vi.doMock('../lib/coordinatorLiveness.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../lib/coordinatorLiveness.ts')>(),
      findLiveCoordinator: () => ({ pid: process.pid, source: 'pid_file' }),
    }));
    try {
      const fresh = await import('./handlers.ts');
      expect((await fresh.handleGetStatus(dir)).coordinator).toEqual({
        running: true, pid: process.pid, version: expect.any(String), started_at: expect.any(String), stale: null,
      });
    } finally {
      vi.doUnmock('../lib/coordinatorLiveness.ts');
      vi.resetModules();
      await control.close();
    }
  });

  it('handleGetStatus counts live runs waiting for input, not legacy finished claims', async () => {
    seedClaims([
      { run_id: 'run-w', task_ref: 'project/todo-one', agent_id: 'orc-1', state: 'in_progress', input_state: 'awaiting_input',
        claimed_at: '2026-01-01T00:00:00.000Z', lease_expires_at: '2026-01-01T00:10:00.000Z' },
      { run_id: 'run-old', task_ref: 'project/done-one', agent_id: 'orc-2', state: 'failed', input_state: 'awaiting_input',
        claimed_at: '2026-01-01T00:00:00.000Z', lease_expires_at: '2026-01-01T00:10:00.000Z' },
    ]);
    expect((await handleGetStatus(dir)).waiting_input).toBe(1);
  });

  it('handleGetStatus includes done and cancelled counts when include_done_count=true', async () => {
    seedTasks([
      {
        ref: 'project/done-two',
        title: 'Done two',
        status: 'done',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        ref: 'project/cancelled-one',
        title: 'Cancelled one',
        status: 'cancelled',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const status = await handleGetStatus(dir, { include_done_count: true });
    expect((status.task_counts as Record<string, unknown>).done).toBe(2);
    expect((status.task_counts as Record<string, unknown>).released).toBeUndefined();
    expect((status.task_counts as Record<string, unknown>).cancelled).toBe(1);
  });

  it('handleGetStatus response stays <= 2KB for 3 workers and 10 active tasks', async () => {
    seedAgents([
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-3', provider: 'codex', role: 'worker', status: 'running' },
    ]);
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      ref: `project/task-${i + 1}`,
      title: `Task ${i + 1}`,
      status: i < 3 ? 'in_progress' : 'todo',
      task_type: 'implementation',
      planning_state: 'ready_for_dispatch',
      delegated_by: 'master',
      owner: i % 3 === 0 ? 'orc-1' : (i % 3 === 1 ? 'orc-2' : 'orc-3'),
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }));
    seedBacklog([{ ref: 'project', title: 'Project', tasks }]);
    seedClaims([
      {
        run_id: 'run-1',
        task_ref: 'project/task-1',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:00:05.000Z',
        last_heartbeat_at: '2026-01-01T00:00:06.000Z',
        lease_expires_at: '2026-01-01T00:10:00.000Z',
      },
      {
        run_id: 'run-2',
        task_ref: 'project/task-2',
        agent_id: 'orc-2',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T00:10:00.000Z',
      },
    ]);

    const status = await handleGetStatus(dir);
    expect(Buffer.byteLength(JSON.stringify(status), 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('handleGetAgentWorkview returns idle view when the agent has no assigned work', () => {
    const workview = handleGetAgentWorkview(dir, { agent_id: 'master' }) as Record<string, unknown>;
    expect((workview.agent as Record<string, unknown>).agent_id).toBe('master');
    expect(workview.active_run).toBeNull();
    expect(workview.recommended_action).toBe('idle');
  });

  it('handleGetAgentWorkview returns start_run recommendation for claimed work', () => {
    seedClaims([
      {
        run_id: 'run-9',
        task_ref: 'project/todo-one',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T00:10:00.000Z',
      },
    ]);
    const workview = handleGetAgentWorkview(dir, { agent_id: 'orc-1' });
    expect(workview.active_run?.state).toBe('claimed');
    expect(workview.recommended_action).toBe('start_run');
  });

  it('handleGetAgentWorkview returns heartbeat recommendation for in_progress work', () => {
    const workview = handleGetAgentWorkview(dir, { agent_id: 'orc-1' });
    expect(workview.active_run?.state).toBe('in_progress');
    expect(workview.recommended_action).toBe('heartbeat');
  });

  it('get_status and get_agent_workview return current_activity for the active run', async () => {
    writeRunActivity(dir, {
      'run-1': {
        run_id: 'run-1', agent_id: 'orc-1', label: 'Writing tests', source: 'todo', label_ts: '2026-01-01T00:00:30.000Z',
        last_tool: 'Bash', last_tool_brief: 'npm test', last_tool_ts: '2026-01-01T00:00:40.000Z',
      },
    });
    const expected = { text: 'Writing tests', source: 'todo', ts: '2026-01-01T00:00:30.000Z' };

    const status = await handleGetStatus(dir);
    const task = (status.active_tasks as Array<Record<string, unknown>>).find((t) => t.ref === 'project/todo-one');
    expect(task?.current_activity).toEqual(expected);
    // A task without an active run carries no current_activity field.
    const idle = (status.active_tasks as Array<Record<string, unknown>>).find((t) => t.ref !== 'project/todo-one' && t.ref !== 'project/done-one');
    expect(idle && Object.hasOwn(idle, 'current_activity')).toBe(false);

    const workview = handleGetAgentWorkview(dir, { agent_id: 'orc-1' });
    expect(workview.active_run?.current_activity).toEqual(expected);
  });

  it('handleGetStatus stays <= 2KB with long activity text on active runs', async () => {
    const long = (runId: string, agentId: string) => ({
      run_id: runId, agent_id: agentId, label: 'n'.repeat(1000), source: 'note' as const, label_ts: new Date().toISOString(),
      last_tool: 'Bash', last_tool_brief: 'b'.repeat(1000), last_tool_ts: new Date().toISOString(),
    });
    writeRunActivity(dir, { 'run-1': long('run-1', 'orc-1'), 'run-2': long('run-2', 'orc-2') });
    const status = await handleGetStatus(dir);
    const withActivity = (status.active_tasks as Array<Record<string, unknown>>).filter((t) => t.current_activity);
    expect(withActivity.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(status), 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('get_agent_workview returns current_activity null when the run has no snapshot', () => {
    const workview = handleGetAgentWorkview(dir, { agent_id: 'orc-1' });
    expect(workview.active_run?.current_activity).toBeNull();
  });

  it('handleGetAgentWorkview includes blockers for owned tasks that are not actionable', () => {
    // The project store holds only ready_for_dispatch/archived planning states, so planning_state
    // blockers cannot arise here; a dependency that is not done can.
    seedTasks([{
      ref: 'project/owned-blocked',
      title: 'Owned blocked',
      status: 'todo',
      owner: 'orc-1',
      task_type: 'implementation',
      depends_on: ['infra/blocked-one'],
      delegated_by: 'master',
      created_at: '2026-01-01T00:00:00.000Z',
    }]);

    const workview = handleGetAgentWorkview(dir, { agent_id: 'orc-1' }) as Record<string, unknown>;
    const ownedBlocked = (workview.queued_tasks as Array<Record<string, unknown>>).find((task) => task.ref === 'project/owned-blocked') as Record<string, unknown>;
    expect(ownedBlocked.blockers).toContain('dependency_not_done:infra/blocked-one');
  });

  it('handleGetAgentWorkview reports planning_state and missing-dependency blockers from an in-memory backlog', async () => {
    // The project store cannot hold a waiting_for_input planning state or a dependency on an
    // unknown ref, so serve the handler an in-memory backlog that does.
    const backlog = {
      version: '1',
      features: [{
        ref: 'project',
        title: 'Project',
        tasks: [{
          ref: 'project/owned-blocked',
          title: 'Owned blocked',
          status: 'todo',
          owner: 'orc-1',
          task_type: 'implementation',
          planning_state: 'waiting_for_input',
          depends_on: ['project/missing-dep'],
          delegated_by: 'master',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        }],
      }],
    };
    vi.resetModules();
    vi.doMock('../lib/stateReader.ts', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../lib/stateReader.ts')>()),
      readBacklog: () => backlog,
    }));
    try {
      const { handleGetAgentWorkview: workviewOver } = await import('./handlers.ts');
      const workview = workviewOver(dir, { agent_id: 'orc-1' }) as Record<string, unknown>;
      const ownedBlocked = (workview.queued_tasks as Array<Record<string, unknown>>).find((task) => task.ref === 'project/owned-blocked') as Record<string, unknown>;
      expect(ownedBlocked.blockers).toContain('planning_state:waiting_for_input');
      expect(ownedBlocked.blockers).toContain('dependency_not_done:project/missing-dep');
    } finally {
      vi.doUnmock('../lib/stateReader.ts');
      vi.resetModules();
    }
  });

  it('throws validation errors for invalid filter inputs', async () => {
    expect(() => handleListTasks(dir, { status: 'invalid' })).toThrow(/Invalid status/);
    expect(() => handleListAgents(dir, { role: 'invalid' })).toThrow(/Invalid role/);
    expect(() => handleListAgents(dir, { include_dead: 'yes' })).toThrow(/include_dead must be a boolean/);
    expect(() => handleQueryEvents(dir, { limit: -1 })).toThrow(/limit/);
    await expect(handleGetStatus(dir, { include_done_count: 'yes' })).rejects.toThrow(/include_done_count must be a boolean/);
  });

  it('handleCreateTask and handleUpdateTask refuse a state directory without a project task store', () => {
    // A state directory without runtime.db.
    const storelessDir = createTempStateDir('orc-mcp-handlers-no-store-');
    try {
      expect(() => handleCreateTask(storelessDir, { title: 'Anything' })).toThrow(/Project task store is missing.*restore it from a backup, or run orc init/);
      expect(() => handleUpdateTask(storelessDir, { task_ref: 'project/todo-one', priority: 'high' })).toThrow(/Project task store is missing/);
    } finally {
      cleanupTempStateDir(storelessDir);
    }
  });

  it('delegateTask assigns explicit target and appends task_delegated event', () => {
    seedClaims([]);
    const result = delegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });

    const backlog = readBacklog(dir);
    const projectFeature = backlog.features.find(feature => feature.ref === 'project');
    const updated = projectFeature?.tasks.find((task) => task.ref === 'project/todo-one');
    expect(updated?.owner).toBe('orc-1');
    expect(updated?.delegated_by).toBe('master');

    const delegatedEvents = queryEvents(dir, { event_type: 'task_delegated' });
    expect(delegatedEvents.length).toBeGreaterThanOrEqual(1);
    const delegatedEvent = delegatedEvents.at(-1) as unknown as Record<string, unknown>;
    expect(delegatedEvent.agent_id).toBe('orc-1');
  });

  it('delegateTask transitions blocked task to todo and updates planning fields', () => {
    seedClaims([]);
    const before = readBacklog(dir).features.find(feature => feature.ref === 'infra')?.tasks
      .find((task) => task.ref === 'infra/blocked-one');
    expect(before?.status).toBe('blocked');

    const result = delegateTask(dir, {
      task_ref: 'infra/blocked-one',
      target_agent_id: 'orc-1',
      task_type: 'refactor',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'infra/blocked-one', assigned_to: 'orc-1' });

    const after = readBacklog(dir).features.find(feature => feature.ref === 'infra')?.tasks
      .find((task) => task.ref === 'infra/blocked-one');
    expect(after?.status).toBe('todo');
    expect(after?.planning_state).toBe('ready_for_dispatch');
    expect(after?.updated_at).not.toBe(before?.updated_at);
  });

  it('delegateTask returns warning when no eligible worker exists', () => {
    seedAgents([{ agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' }]);
    const result = delegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result.warning).toBe('no_eligible_worker');
    expect(result.task_ref).toBe('project/todo-one');
    expect(result.message).toContain('No eligible worker');
    expect(Array.isArray(result.candidate_diagnostics)).toBe(true);
  });

  it('delegateTask clears stale owner when no eligible worker exists', () => {
    setTaskOwner('project/todo-one', 'orc-1');

    seedAgents([{ agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' }]);
    const result = delegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result.warning).toBe('no_eligible_worker');
    expect(result.task_ref).toBe('project/todo-one');
    const refreshed = readBacklog(dir).features.find(feature => feature.ref === 'project')?.tasks
      .find((candidate) => candidate.ref === 'project/todo-one');
    expect(refreshed).not.toHaveProperty('owner');
  });

  it('delegateTask auto-selects first eligible worker when target is omitted', () => {
    seedClaims([]);
    const result = delegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });
  });

  it('delegateTask auto-selection uses round-robin across eligible workers (A then B then A)', () => {
    seedTasks([
      {
        ref: 'project/todo-two',
        title: 'Todo two',
        status: 'todo',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        ref: 'project/todo-three',
        title: 'Todo three',
        status: 'todo',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    seedClaims([]);
    seedAgents([
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running' },
    ]);

    const first = delegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    const second = delegateTask(dir, {
      task_ref: 'project/todo-two',
      task_type: 'implementation',
      actor_id: 'master',
    });
    const third = delegateTask(dir, {
      task_ref: 'project/todo-three',
      task_type: 'implementation',
      actor_id: 'master',
    });

    // Round-robin: consecutive delegations alternate workers, third wraps back to first.
    expect(first.assigned_to).not.toBe(second.assigned_to);
    expect(third.assigned_to).toBe(first.assigned_to);
  });

  it('delegateTask in-memory round-robin state persists across calls', () => {
    seedTasks([{
      ref: 'project/todo-two',
      title: 'Todo two',
      status: 'todo',
      task_type: 'implementation',
      planning_state: 'ready_for_dispatch',
      delegated_by: 'master',
      created_at: '2026-01-01T00:00:00.000Z',
    }]);
    seedClaims([]);
    seedAgents([
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running' },
    ]);

    // In-memory round-robin state persists across calls: consecutive delegations
    // always alternate between workers regardless of which agent was last assigned.
    const first = delegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    const second = delegateTask(dir, {
      task_ref: 'project/todo-two',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(first.assigned_to).not.toBe(second.assigned_to);
    expect(['orc-1', 'orc-2']).toContain(first.assigned_to);
    expect(['orc-1', 'orc-2']).toContain(second.assigned_to);
  });

  it('delegateTask errors on invalid target and missing task', () => {
    expect(() => delegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'missing-worker',
      actor_id: 'master',
    })).toThrow(/Target agent not found/);
    expect(() => delegateTask(dir, {
      task_ref: 'project/missing-task',
      actor_id: 'master',
    })).toThrow(/Task not found/);
  });

  it('delegateTask rejects explicit target when agent already has an active run', () => {
    expect(() => delegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/Target agent orc-1 already has active run run-1/);
  });

  it('delegateTask explicit target is unaffected by round-robin state', () => {
    seedClaims([]);
    seedAgents([
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running' },
    ]);

    // Explicit target always wins regardless of in-memory round-robin state.
    const result = delegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });
  });

  it('delegateTask rejects targets that cannot execute task type', () => {
    expect(() => delegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'master',
      task_type: 'implementation',
      actor_id: 'master',
    })).toThrow(/cannot execute task: role_ineligible:master/);
  });

  it('delegateTask surfaces provider mismatch for explicit target rejection', () => {
    seedClaims([]);
    // The required provider is part of the task definition, so seed a task that carries it.
    seedTasks([{ ref: 'project/gemini-one', title: 'Gemini one', status: 'todo', task_type: 'implementation', required_provider: 'gemini' }]);

    expect(() => delegateTask(dir, {
      task_ref: 'project/gemini-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/provider_mismatch:gemini/);
    expect(() => delegateTask(dir, {
      task_ref: 'project/gemini-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/task requires provider 'gemini'/);
  });

  it('delegateTask returns owner and provider diagnostics when auto-selection fails', () => {
    seedClaims([]);
    seedTasks([{ ref: 'project/gemini-one', title: 'Gemini one', status: 'todo', task_type: 'implementation', owner: 'orc-2', required_provider: 'gemini' }]);

    const result = delegateTask(dir, {
      task_ref: 'project/gemini-one',
      task_type: 'implementation',
      actor_id: 'master',
    });

    expect(result.warning).toBe('no_eligible_worker');
    expect(result.candidate_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_id: 'orc-1',
          reasons: expect.arrayContaining(['reserved_owner_conflict:orc-2', 'provider_mismatch:gemini']),
          reason_messages: expect.arrayContaining([
            "task is reserved for owner 'orc-2'",
            "task requires provider 'gemini'",
          ]),
        }),
      ]),
    );
  });

  it('delegateTask validates actor_id registration for non-human actors', () => {
    expect(() => delegateTask(dir, {
      task_ref: 'project/todo-one',
      actor_id: 'ghost-agent',
    })).toThrow(/Actor agent not found/);
  });

  it('cancelTask sets todo task to cancelled and returns cancelled=true', () => {
    seedClaims([]);
    const result = cancelTask(dir, {
      task_ref: 'project/todo-one',
      reason: 'cancelled by operator',
      actor_id: 'master',
    });
    expect(result).toEqual({
      cancelled: true,
      task_ref: 'project/todo-one',
      status: 'cancelled',
    });

    const task = readBacklog(dir).features.flatMap(feature => feature.tasks).find((entry) => entry.ref === 'project/todo-one')!;
    expect(task.status).toBe('cancelled');

    const cancelledEvents = queryEvents(dir, { event_type: 'task_cancelled' });
    expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);
    const event = cancelledEvents.at(-1) as unknown as Record<string, unknown>;
    expect(event.event).toBe('task_cancelled');
    expect(event.task_ref).toBe('project/todo-one');
  });

  it('cancelTask removes active in_progress claim, emits run_cancelled, and deposits TASK_COMPLETE notification', () => {
    const result = cancelTask(dir, {
      task_ref: 'project/todo-one',
      reason: 'manual cancellation',
      actor_id: 'master',
    }) as Record<string, unknown>;
    expect(result.cancelled).toBe(true);
    expect(result.cancelled_run_id).toBe('run-1');

    const remainingClaims = readFileSync(join(dir, 'claims.json'), 'utf8');
    expect(remainingClaims).not.toContain('"run_id":"run-1"');

    const allEvents = queryEvents(dir, {});
    const eventTypes = allEvents.map((e) => (e as unknown as Record<string, unknown>).event);
    expect(eventTypes).toContain('run_cancelled');
    expect(eventTypes).toContain('task_cancelled');
    const runIds = allEvents.map((e) => (e as unknown as Record<string, unknown>).run_id).filter(Boolean);
    expect(runIds).toContain('run-1');

    const cancelledEvents = queryEvents(dir, { event_type: 'run_cancelled' });
    expect(cancelledEvents.filter((e) => (e as unknown as Record<string, unknown>).task_ref === 'project/todo-one')).toHaveLength(1);
  });

  it('cancelTask returns already_terminal on done task without state change', () => {
    const before = readBacklog(dir);
    const result = cancelTask(dir, {
      task_ref: 'project/done-one',
      actor_id: 'master',
    });
    expect(result).toEqual({
      error: 'already_terminal',
      task_ref: 'project/done-one',
      status: 'done',
    });
    expect(readBacklog(dir)).toEqual(before);
  });

  it('cancelTask cancels a blocked task and reports a repeat cancel as already_terminal', () => {
    const first = cancelTask(dir, {
      task_ref: 'infra/blocked-one',
      actor_id: 'master',
    }) as Record<string, unknown>;
    const second = cancelTask(dir, {
      task_ref: 'infra/blocked-one',
      actor_id: 'master',
    }) as Record<string, unknown>;
    expect(first.cancelled).toBe(true);
    expect(first.status).toBe('cancelled');
    expect(second).toEqual({ error: 'already_terminal', task_ref: 'infra/blocked-one', status: 'cancelled' });
  });

  it('respondInput clears awaiting_input state and appends input_response', () => {
    seedClaims([{
      run_id: 'run-input-1',
      task_ref: 'project/todo-one',
      agent_id: 'orc-1',
      state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00.000Z',
      started_at: '2026-01-01T00:01:00.000Z',
      lease_expires_at: '2099-01-01T00:00:00.000Z',
      last_heartbeat_at: '2026-01-01T00:01:00.000Z',
      finished_at: null,
      finalization_state: null,
      finalization_retry_count: 0,
      finalization_blocked_reason: null,
      input_state: 'awaiting_input',
      input_requested_at: '2026-01-01T00:02:00.000Z',
    }]);
    seedEventsLines([
      JSON.stringify({
        seq: 1,
        ts: '2026-01-01T00:02:00.000Z',
        event: 'input_requested',
        actor_type: 'agent',
        actor_id: 'orc-1',
        run_id: 'run-input-1',
        task_ref: 'project/todo-one',
        agent_id: 'orc-1',
        payload: { question: 'Proceed?' },
      }),
    ]);

    const result = respondInput(dir, {
      run_id: 'run-input-1',
      agent_id: 'orc-1',
      response: 'yes',
    });

    expect(result.ok).toBe(true);
    const claims = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
    expect(claims.claims[0].input_state).toBeNull();
    expect(claims.claims[0].input_requested_at).toBeNull();
    const responseEvents = queryEvents(dir, { event_type: 'input_response', run_id: 'run-input-1' });
    expect(responseEvents.some((event) => {
      const ev = event as unknown as Record<string, unknown>;
      return ev.event === 'input_response'
        && ev.run_id === 'run-input-1'
        && (ev.payload as Record<string, unknown>)?.response === 'yes';
    })).toBe(true);
  });
});

describe('handleGetRun', () => {
  it('returns claim details merged with task_title and worktree_path', () => {
    const result = handleGetRun(dir, { run_id: 'run-1' }) as Record<string, unknown>;
    expect(result.run_id).toBe('run-1');
    expect(result.task_ref).toBe('project/todo-one');
    expect(result.agent_id).toBe('orc-1');
    expect(result.task_title).toBe('Todo one');
    expect(result.worktree_path).toBeNull();
  });

  it('returns not_found for unknown run_id', () => {
    const result = handleGetRun(dir, { run_id: 'no-such-run' }) as Record<string, unknown>;
    expect(result.error).toBe('not_found');
  });

  it('throws when run_id is missing', () => {
    expect(() => handleGetRun(dir, {})).toThrow('run_id is required');
  });
});

describe('handleListRuns state=waiting_input', () => {
  it('returns empty when no claims await input', () => {
    expect(handleListRuns(dir, { state: 'waiting_input' })).toEqual({ runs: [] });
  });

  it('leaves out a finished claim that still carries awaiting_input (legacy runs)', () => {
    seedClaims([
      {
        run_id: 'run-legacy',
        task_ref: 'project/todo-one',
        agent_id: 'orc-1',
        state: 'failed',
        input_state: 'awaiting_input',
        claimed_at: '2026-01-01T00:00:00.000Z',
        lease_expires_at: '2026-01-01T00:10:00.000Z',
      },
    ]);
    expect(handleListRuns(dir, { state: 'waiting_input' })).toEqual({ runs: [] });
    expect(handleListRuns(dir)).toEqual({ runs: [] });
  });

  it('returns waiting runs with question, request_id and waiting_seconds; other states carry them too', () => {
    seedClaims([
      {
        run_id: 'run-waiting',
        task_ref: 'project/todo-one',
        agent_id: 'orc-1',
        state: 'in_progress',
        input_state: 'awaiting_input',
        input_requested_at: '2026-01-01T00:05:00.000Z',
        claimed_at: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:00:05.000Z',
        last_heartbeat_at: '2026-01-01T00:00:06.000Z',
        lease_expires_at: '2026-01-01T00:10:00.000Z',
      },
      {
        run_id: 'run-busy',
        task_ref: 'project/done-one',
        agent_id: 'orc-2',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00.000Z',
        started_at: '2026-01-01T00:00:05.000Z',
        lease_expires_at: '2026-01-01T00:10:00.000Z',
      },
    ]);
    seedEventsLines([
      JSON.stringify({
        seq: 1,
        ts: '2026-01-01T00:05:00.000Z',
        event: 'input_requested',
        run_id: 'run-waiting',
        agent_id: 'orc-1',
        payload: { question: 'Should I proceed?', request_id: 'req-9' },
      }),
    ]);

    const now = new Date('2026-01-01T00:06:00.000Z').getTime();
    const { runs } = handleListRuns(dir, { state: 'waiting_input', now_ms: now });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: 'run-waiting', question: 'Should I proceed?', request_id: 'req-9', waiting_seconds: 60, stalled: false });
    const active = handleListRuns(dir, { now_ms: now }).runs;
    expect(active.map((run) => run.run_id).sort()).toEqual(['run-busy', 'run-waiting']);
    expect(active.find((run) => run.run_id === 'run-busy')).not.toHaveProperty('question');
    expect(active.find((run) => run.run_id === 'run-waiting')).toHaveProperty('request_id', 'req-9');
  });
});

describe('handleQueryEvents', () => {
  type Page = { events: Array<Record<string, unknown>>; last_seq: number; has_more: boolean };

  it('returns the newest page, skipping malformed rows', () => {
    const result = handleQueryEvents(dir) as Page;
    expect(result.events).toHaveLength(3); // 3 valid lines (1 malformed excluded)
    expect(result.has_more).toBe(false);
  });

  it('filters by event_type and after_seq', () => {
    expect((handleQueryEvents(dir, { event_type: 'run_started' }) as Page).events.map((e) => e.event)).toEqual(['run_started']);
    const after = handleQueryEvents(dir, { after_seq: 2 }) as Page;
    expect(after.events.map((e) => e.seq)).toEqual([3]);
    expect(after.last_seq).toBe(3);
  });

  it('pages with limit', () => {
    const page = handleQueryEvents(dir, { limit: 1 }) as Page;
    expect(page.events).toHaveLength(1);
    expect(page.has_more).toBe(true);
  });

  it('rejects a malformed fts_query', () => {
    expect(() => handleQueryEvents(dir, { fts_query: '"unclosed' })).toThrow(/invalid fts_query/);
  });

  it('notifications_only drops non-notification events', () => {
    seedEventsLines([
      JSON.stringify({ seq: 1, event_id: 'e1', event: 'heartbeat', actor_type: 'agent', actor_id: 'orc-1', agent_id: 'orc-1', ts: '2026-01-01T00:00:01.000Z' }),
      JSON.stringify({ seq: 2, event_id: 'e2', event: 'run_cancelled', actor_type: 'agent', actor_id: 'orc-1', run_id: 'run-1', task_ref: 'project/todo-one', agent_id: 'orc-1', ts: '2026-01-01T00:00:03.000Z' }),
    ]);
    const page = handleQueryEvents(dir, { notifications_only: true }) as Page;
    expect(page.events.map((e) => e.event)).toEqual(['run_cancelled']);
    expect(page.last_seq).toBe(2);
  });

  it('returns an empty page when no events file exists', () => {
    rmSync(join(dir, 'events.jsonl'));
    expect(handleQueryEvents(dir)).toEqual({ events: [], last_seq: 0, has_more: false });
  });
});

describe('resetTask', () => {
  it('resets task to todo and cancels active claims', () => {
    const result = resetTask(dir, { task_ref: 'project/todo-one', actor_id: 'master' }) as Record<string, unknown>;
    expect(result.reset).toBe(true);
    expect(result.previous_status).toBe('todo');
    expect(result.cancelled_claims).toBe(1); // run-1 is in_progress

    const task = readBacklog(dir).features.flatMap((feature) => feature.tasks).find((t) => t.ref === 'project/todo-one');
    expect(task?.status).toBe('todo');
  });

  it('uses human as default actor_id', () => {
    expect(() => resetTask(dir, { task_ref: 'project/todo-one' })).not.toThrow();
  });

  it('throws on missing task_ref', () => {
    expect(() => resetTask(dir, {})).toThrow('task_ref is required');
  });

  it('throws on invalid actor_id', () => {
    expect(() => resetTask(dir, { task_ref: 'project/todo-one', actor_id: 'INVALID!' })).toThrow('Invalid actor_id');
  });

  it('throws when task not found', () => {
    expect(() => resetTask(dir, { task_ref: 'no/such-task', actor_id: 'master' })).toThrow('task not found');
  });
});

describe('handleListWorktrees', () => {
  it('returns empty list when no run-worktrees.json exists', () => {
    const result = handleListWorktrees(dir);
    expect(result).toEqual([]);
  });

  it('returns worktree entries merged with claim data', () => {
    writeFileSync(
      join(dir, 'run-worktrees.json'),
      JSON.stringify({
        version: '1',
        runs: [
          {
            run_id: 'run-1',
            agent_id: 'orc-1',
            task_ref: 'project/todo-one',
            worktree_path: '/repo/.worktrees/run-1',
            branch: 'run/run-1',
            created_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const result = handleListWorktrees(dir) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(1);
    expect(result[0].run_id).toBe('run-1');
    expect(result[0].task_ref).toBe('project/todo-one');
    expect(result[0].path).toBe('/repo/.worktrees/run-1');
    expect(result[0].task_title).toBe('Todo one');
  });
});

describe('memory handlers', () => {
  afterEach(() => {
    closeMemoryDb();
  });

  it('handleMemoryStore creates a drawer and returns ID', () => {
    const result = handleMemoryStore(dir, { content: 'test memory content' });
    expect(result).toHaveProperty('id');
    expect(typeof (result as { id: number }).id).toBe('number');
  });

  it('handleMemoryStore uses default wing/hall/room when omitted', () => {
    const result = handleMemoryStore(dir, { content: 'default location test' });
    expect(result).toHaveProperty('id');
    const id = (result as { id: number }).id;
    expect(id).toBeGreaterThan(0);
  });

  it('handleMemoryStore returns same ID for duplicate content', () => {
    const r1 = handleMemoryStore(dir, { content: 'duplicate content' }) as { id: number };
    closeMemoryDb();
    const r2 = handleMemoryStore(dir, { content: 'duplicate content' }) as { id: number };
    expect(r2.id).toBe(r1.id);
  });

  it('handleMemorySearch returns FTS5 results', () => {
    handleMemoryStore(dir, { content: 'the quick brown fox jumps', wing: 'search-test', room: 'animals' });
    closeMemoryDb();
    const result = handleMemorySearch(dir, { query: 'fox' }) as { results: unknown[] };
    expect(result).toHaveProperty('results');
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('handleMemorySearch filters by wing', () => {
    handleMemoryStore(dir, { content: 'elephant in savanna', wing: 'africa', room: 'animals' });
    handleMemoryStore(dir, { content: 'elephant memory test', wing: 'other', room: 'animals' });
    closeMemoryDb();
    const result = handleMemorySearch(dir, { query: 'elephant', wing: 'africa' }) as { results: Array<{ wing: string }> };
    expect(result.results.every((r) => r.wing === 'africa')).toBe(true);
  });

  it('handleMemorySearch without query browses a wing/room as full drawers', () => {
    handleMemoryStore(dir, { content: 'browse content one', wing: 'browse-wing', room: 'browse-room' });
    handleMemoryStore(dir, { content: 'browse content two', wing: 'browse-wing', room: 'other-room' });
    handleMemoryStore(dir, { content: 'browse content three', wing: 'other-wing', room: 'browse-room' });
    closeMemoryDb();
    const room = handleMemorySearch(dir, { wing: 'browse-wing', room: 'browse-room' }) as { results: Array<{ content: string }> };
    expect(room.results.map((r) => r.content)).toEqual(['browse content one']);
    const wing = handleMemorySearch(dir, { wing: 'browse-wing', limit: 1 }) as { results: unknown[] };
    expect(wing.results).toHaveLength(1);
  });

  it('handleMemorySearch throws without query or wing', () => {
    expect(() => handleMemorySearch(dir, {})).toThrow('query or wing is required');
    expect(() => handleMemorySearch(dir, { room: 'r' })).toThrow('query or wing is required');
  });

  it('handleMemoryWakeUp returns formatted text', () => {
    handleMemoryStore(dir, { content: 'wake up memory content', wing: 'general', room: 'notes', importance: 8 });
    closeMemoryDb();
    const result = handleMemoryWakeUp(dir, {}) as { text: string };
    expect(result).toHaveProperty('text');
    expect(typeof result.text).toBe('string');
    expect(result.text).toContain('wake up memory content');
  });

  it('handleMemoryWakeUp returns empty text when no memories exist', () => {
    const result = handleMemoryWakeUp(dir, {}) as { text: string };
    expect(result).toHaveProperty('text');
    expect(result.text).toBe('');
  });

  it('handleMemoryStatus returns stats', () => {
    handleMemoryStore(dir, { content: 'status test content', wing: 'status-wing', room: 'room1' });
    closeMemoryDb();
    const result = handleMemoryStatus(dir) as { stats: { totalDrawers: number; distinctWings: number; dbSizeBytes: number } };
    expect(result).toHaveProperty('stats');
    expect(result.stats.totalDrawers).toBe(1);
    expect(result.stats.distinctWings).toBe(1);
    expect(result.stats.dbSizeBytes).toBeGreaterThan(0);
  });

  it('a memory failure in an existing state directory reports its own cause', () => {
    expect(handleMemorySearch(dir, { query: '"unbalanced' })).toEqual({ error: 'memory failed: unterminated string' });
  });

  it('memory tools return graceful response when memory DB cannot be initialized', () => {
    const badDir = join(dir, 'nonexistent', 'subdir');
    // These four throw internally and return a structured error object
    expect(handleMemoryStore(badDir, { content: 'test' })).toEqual({ error: 'memory system not initialized' });
    expect(handleMemorySearch(badDir, { query: 'test' })).toEqual({ error: 'memory system not initialized' });
    expect(handleMemorySearch(badDir, { wing: 'general' })).toEqual({ error: 'memory system not initialized' });
    expect(handleMemoryStatus(badDir)).toEqual({ error: 'memory system not initialized' });
    // memoryWakeUp handles DB failure internally and returns empty text, so handleMemoryWakeUp returns { text: '' }
    expect(handleMemoryWakeUp(badDir, {})).toEqual({ text: '' });
  });
});
