import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleGetRecentEvents,
  handleGetAgentWorkview,
  handleGetStatus,
  handleGetTask,
  handleListActiveRuns,
  handleListAgents,
  handleListStalledRuns,
  handleListTasks,
  handleReadAgents,
  handleReadBacklog,
  handleCreateTask,
  handleUpdateTask,
  handleDelegateTask,
  handleCancelTask,
  handleRespondInput,
  handleGetRun,
  handleListWaitingInput,
  handleQueryEvents,
  handleResetTask,
  handleListWorktrees,
} from './handlers.ts';
import { readPendingNotifications } from '../lib/masterNotifyQueue.ts';

let dir: string;

function seedBacklog(features: unknown[]) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features }, null, 2));
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

function readBacklog(): { version: string; features: Array<{ ref: string; title: string; tasks: Array<Record<string, unknown>> }>; next_task_seq?: number } {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-mcp-handlers-test-'));
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
      capabilities: [],
      last_heartbeat_at: null,
      registered_at: '2026-01-01T00:00:00.000Z',
    },
    {
      agent_id: 'orc-1',
      provider: 'codex',
      role: 'worker',
      status: 'running',
      session_handle: 'pty:1',
      capabilities: ['typescript'],
      last_heartbeat_at: '2026-01-01T00:01:00.000Z',
      registered_at: '2026-01-01T00:00:00.000Z',
    },
    {
      agent_id: 'orc-dead',
      provider: 'codex',
      role: 'worker',
      status: 'dead',
      session_handle: null,
      capabilities: ['typescript'],
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
    {
      run_id: 'run-4',
      task_ref: 'project/todo-one',
      agent_id: 'orc-1',
      state: 'in_progress',
      claimed_at: '2026-01-01T00:19:30.000Z',
      started_at: '2026-01-01T00:19:35.000Z',
      last_heartbeat_at: '2026-01-01T00:19:50.000Z',
      lease_expires_at: '2026-01-01T00:30:00.000Z',
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
  rmSync(dir, { recursive: true, force: true });
});

describe('mcp read handlers', () => {
  it('handleListTasks returns non-terminal tasks by default and supports status/feature filters', () => {
    // Default excludes done/released to keep payload small.
    const all = handleListTasks(dir);
    expect(all).toHaveLength(2);
    expect(all.map((task) => task.ref)).toEqual(['project/todo-one', 'infra/blocked-one']);
    expect(all.every((task) => typeof task.feature_ref === 'string')).toBe(true);

    // Verbose fields are stripped in list view.
    expect(all.every((task) => !('description' in task))).toBe(true);
    expect(all.every((task) => !('acceptance_criteria' in task))).toBe(true);
    expect(all.every((task) => typeof task.priority === 'string')).toBe(true);
    expect(all.find((task) => task.ref === 'project/todo-one')?.priority).toBe('normal');

    // Explicit status= includes done/released tasks.
    const done = handleListTasks(dir, { status: 'done' });
    expect(done.map((task) => task.ref)).toEqual(['project/done-one']);

    const todo = handleListTasks(dir, { status: 'todo' });
    expect(todo.map((task) => task.ref)).toEqual(['project/todo-one']);

    const infra = handleListTasks(dir, { feature: 'infra' });
    expect(infra.map((task) => task.ref)).toEqual(['infra/blocked-one']);
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

  it('handleListActiveRuns returns only claimed/in_progress claims', () => {
    const active = handleListActiveRuns(dir);
    expect(active.map((claim) => claim.run_id).sort()).toEqual(['run-1', 'run-2', 'run-4']);
  });

  it('handleListStalledRuns returns stale runs with stale_for_ms', () => {
    const now = new Date('2026-01-01T00:20:00.000Z').getTime();
    const stale = handleListStalledRuns(dir, { stale_after_ms: 60_000, now_ms: now }) as Array<Record<string, unknown>>;
    expect(stale.map((claim) => claim.run_id).sort()).toEqual(['run-1', 'run-2']);
    const run1 = stale.find((claim) => claim.run_id === 'run-1');
    const run2 = stale.find((claim) => claim.run_id === 'run-2');
    expect(run1?.stale_for_ms).toBe(1_194_000);
    expect(run2?.stale_for_ms).toBe(1_200_000);
  });

  it('handleGetTask returns task or not_found error', () => {
    const task = handleGetTask(dir, { task_ref: 'project/todo-one' }) as Record<string, unknown>;
    expect(task.ref).toBe('project/todo-one');

    const missing = handleGetTask(dir, { task_ref: 'project/missing' });
    expect(missing).toEqual({ error: 'not_found', task_ref: 'project/missing' });
  });

  it('handleGetRecentEvents caps limit and skips malformed lines', () => {
    const events = handleGetRecentEvents(dir, { limit: 2 }) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(2);
    expect(events[1].seq).toBe(3);

    const capped = handleGetRecentEvents(dir, { limit: 999 });
    expect(capped).toHaveLength(3);

    const none = handleGetRecentEvents(dir, { limit: 0 });
    expect(none).toEqual([]);
  });

  it('handleGetRecentEvents reads across rotation archives', () => {
    const archive1 = Array.from({ length: 40 }, (_, idx) =>
      JSON.stringify({ seq: idx + 1, event: 'heartbeat', actor_type: 'agent', actor_id: 'orc-1', agent_id: 'orc-1', ts: '2026-01-01T00:00:00.000Z' }));
    const current = Array.from({ length: 20 }, (_, idx) =>
      JSON.stringify({ seq: idx + 41, event: 'heartbeat', actor_type: 'agent', actor_id: 'orc-1', agent_id: 'orc-1', ts: '2026-01-01T00:00:00.000Z' }));
    writeFileSync(join(dir, 'events.jsonl.1'), `${archive1.join('\n')}\n`, 'utf8');
    writeFileSync(join(dir, 'events.jsonl'), `${current.join('\n')}\n`, 'utf8');

    const events = handleGetRecentEvents(dir, { limit: 50 }) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(50);
    expect(events[0].seq).toBe(11);
    expect(events[49].seq).toBe(60);
  });

  it('handleGetRecentEvents returns empty list when events file is missing', () => {
    rmSync(join(dir, 'events.jsonl'), { force: true });
    expect(handleGetRecentEvents(dir)).toEqual([]);
  });

  it('handleGetStatus returns aggregate keys and expected value shapes', () => {
    writeFileSync(
      join(dir, 'master-notify-queue.jsonl'),
      `${JSON.stringify({ seq: 1, consumed: false, type: 'TASK_COMPLETE', task_ref: 'project/todo-one', agent_id: 'orc-1', success: false, finished_at: '2026-01-01T00:00:00.000Z' })}\n`,
      'utf8',
    );
    const status = handleGetStatus(dir);

    expect(Object.keys(status).sort()).toEqual(
      ['active_tasks', 'agents', 'next_task_seq', 'pending_notifications', 'stalled_runs', 'task_counts'].sort(),
    );
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
    expect((status.active_tasks as Array<Record<string, unknown>>).some((task) => task.status === 'done' || task.status === 'released')).toBe(false);
    expect(status.pending_notifications).toBe(1);
    expect(status.stalled_runs).toBe(3);
    expect(status.next_task_seq).toBe(1);
  });

  it('handleGetStatus includes done and released counts when include_done_count=true', () => {
    const backlog = readBacklog();
    const project = backlog.features.find(feature => feature.ref === 'project')!;
    (project.tasks as unknown[]).push({
      ref: 'project/released-one',
      title: 'Released one',
      status: 'released',
      task_type: 'implementation',
      planning_state: 'ready_for_dispatch',
      delegated_by: 'master',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    const status = handleGetStatus(dir, { include_done_count: true });
    expect((status.task_counts as Record<string, unknown>).done).toBe(1);
    expect((status.task_counts as Record<string, unknown>).released).toBe(1);
  });

  it('handleGetStatus response stays <= 2KB for 3 workers and 10 active tasks', () => {
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

    const status = handleGetStatus(dir);
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

  it('handleGetAgentWorkview includes blockers for owned tasks that are not actionable', () => {
    const backlog = readBacklog();
    backlog.features[0].tasks.push({
      ref: 'project/owned-blocked',
      title: 'Owned blocked',
      status: 'todo',
      owner: 'orc-1',
      task_type: 'implementation',
      planning_state: 'waiting_for_input',
      required_capabilities: ['sql'],
      depends_on: ['project/missing-dep'],
      delegated_by: 'master',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    const workview = handleGetAgentWorkview(dir, { agent_id: 'orc-1' }) as Record<string, unknown>;
    const ownedBlocked = (workview.queued_tasks as Array<Record<string, unknown>>).find((task) => task.ref === 'project/owned-blocked') as Record<string, unknown>;
    expect(ownedBlocked.blockers).toContain('planning_state:waiting_for_input');
    expect(ownedBlocked.blockers).toContain('dependency_not_done:project/missing-dep');
    expect(ownedBlocked.blockers).toContain('missing_capability:sql');
  });

  it('throws validation errors for invalid filter inputs', () => {
    expect(() => handleListTasks(dir, { status: 'invalid' })).toThrow(/Invalid status/);
    expect(() => handleListAgents(dir, { role: 'invalid' })).toThrow(/Invalid role/);
    expect(() => handleListAgents(dir, { include_dead: 'yes' })).toThrow(/include_dead must be a boolean/);
    expect(() => handleListStalledRuns(dir, { stale_after_ms: -1 })).toThrow(/stale_after_ms/);
    expect(() => handleGetRecentEvents(dir, { limit: -1 })).toThrow(/limit/);
    expect(() => handleGetStatus(dir, { include_done_count: 'yes' })).toThrow(/include_done_count must be a boolean/);
  });

  it('handleReadBacklog and handleReadAgents return valid json text', () => {
    const backlog = JSON.parse(handleReadBacklog(dir));
    const agents = JSON.parse(handleReadAgents(dir));
    expect(backlog.features).toHaveLength(2);
    expect(agents.agents).toHaveLength(3);
  });

  it('handleCreateTask creates task, writes backlog, and appends task_added event', () => {
    const created = handleCreateTask(dir, {
      feature: 'project',
      title: 'Add orchestration docs',
      task_type: 'implementation',
      description: 'Document MCP orchestration flow.',
      acceptance_criteria: ['Docs explain read/write tools'],
      depends_on: ['project/todo-one'],
      actor_id: 'master',
    });

    expect(created.ref).toBe('project/add-orchestration-docs');
    const backlog = readBacklog();
    const tasks = backlog.features.find(feature => feature.ref === 'project')?.tasks ?? [];
    expect(tasks.some((task) => task.ref === created.ref)).toBe(true);
    expect(backlog.next_task_seq).toBe(2);

    const eventsRaw = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(eventsRaw).toContain('"event":"task_added"');
    expect(eventsRaw).toContain(`"task_ref":"${created.ref}"`);
    expect(created.priority).toBe('normal');
    expect(created.next_task_seq).toBe(2);
  });

  it('handleCreateTask stores explicit priority when provided', () => {
    const created = handleCreateTask(dir, {
      feature: 'project',
      title: 'High priority task',
      priority: 'high',
      actor_id: 'master',
    });
    expect(created.priority).toBe('high');

    const task = readBacklog().features
      .find(feature => feature.ref === 'project')!
      .tasks.find((entry) => entry.ref === created.ref)!;
    expect(task.priority).toBe('high');
  });

  it('handleCreateTask bootstraps next_task_seq from existing numbered task refs before create and returns the next available value after create', () => {
    const backlog = readBacklog();
    delete backlog.next_task_seq;
    backlog.features[0].tasks.push({
      ref: 'project/task-124-bootstrap-seed',
      title: 'Seed',
      status: 'done',
      task_type: 'implementation',
      planning_state: 'ready_for_dispatch',
      delegated_by: 'master',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    const statusBefore = handleGetStatus(dir);
    expect(statusBefore.next_task_seq).toBe(125);

    const created = handleCreateTask(dir, {
      feature: 'project',
      title: 'Bootstrapped seq task',
      actor_id: 'master',
    });

    // The bootstrapped pre-create value is 125; create_task returns the next value after consuming it.
    expect(created.next_task_seq).toBe(126);
    expect(readBacklog().next_task_seq).toBe(126);
  });

  it('handleCreateTask bootstraps next_task_seq to 1 when no numbered refs exist', () => {
    const backlog = readBacklog();
    delete backlog.next_task_seq;
    backlog.features[0].tasks = backlog.features[0].tasks.filter((task) => task.ref !== 'project/done-one');
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    const statusBefore = handleGetStatus(dir);
    expect(statusBefore.next_task_seq).toBe(1);

    const created = handleCreateTask(dir, {
      feature: 'project',
      title: 'First seq task',
      actor_id: 'master',
    });
    expect(created.next_task_seq).toBe(2);
    expect(readBacklog().next_task_seq).toBe(2);
  });

  it('handleCreateTask validates depends_on references', () => {
    expect(() => handleCreateTask(dir, {
      feature: 'project',
      title: 'Bad dependency task',
      depends_on: ['project/missing-task'],
      actor_id: 'master',
    })).toThrow(/depends_on task_ref not found/);
  });

  it('handleCreateTask fails for duplicate refs and missing feature', () => {
    expect(() => handleCreateTask(dir, {
      feature: 'project',
      title: 'Todo one',
      ref: 'todo-one',
      actor_id: 'master',
    })).toThrow(/Task already exists/);
    expect(() => handleCreateTask(dir, {
      feature: 'missing-feature',
      title: 'Something',
      actor_id: 'master',
    })).toThrow(/Feature not found/);
  });

  it('handleCreateTask validates required fields and actor format', () => {
    expect(() => handleCreateTask(dir, { feature: 'project', actor_id: 'master' })).toThrow(/title is required/);
    expect(() => handleCreateTask(dir, { feature: 'project', title: 'x', actor_id: 'INVALID' })).toThrow(/Invalid actor-id/);
  });

  it('handleCreateTask rejects invalid priority', () => {
    expect(() => handleCreateTask(dir, {
      feature: 'project',
      title: 'Bad priority',
      priority: 'urgent',
      actor_id: 'master',
    })).toThrow(/Invalid priority/);
  });

  it('handleCreateTask requires registered non-human actor ids', () => {
    expect(() => handleCreateTask(dir, {
      feature: 'project',
      title: 'Actor check',
      actor_id: 'ghost-agent',
    })).toThrow(/Actor agent not found/);

    expect(() => handleCreateTask(dir, {
      feature: 'project',
      title: 'Human actor allowed',
      actor_id: 'human',
    })).not.toThrow();
  });

  it('handleCreateTask persists multiline description and omits empty list fields', () => {
    const created = handleCreateTask(dir, {
      feature: 'project',
      title: 'Multiline task',
      description: 'Line one\\nLine two',
      acceptance_criteria: [],
      depends_on: [],
      required_capabilities: [],
      actor_id: 'master',
    });
    const backlog = readBacklog();
    const task = backlog.features.find(feature => feature.ref === 'project')?.tasks
      .find((candidate) => candidate.ref === created.ref);
    expect(task?.description).toBe('Line one\\nLine two');
    expect(task).not.toHaveProperty('acceptance_criteria');
    expect(task).not.toHaveProperty('depends_on');
    expect(task).not.toHaveProperty('required_capabilities');
  });

  it('handleCreateTask defaults to general feature when feature is omitted', () => {
    const created = handleCreateTask(dir, {
      title: 'No feature task',
      actor_id: 'master',
    });
    expect(created.ref).toBe('general/no-feature-task');
    const backlog = readBacklog();
    const general = backlog.features.find(feature => feature.ref === 'general');
    expect(general).toBeDefined();
    expect(general?.tasks.some((task) => task.ref === 'general/no-feature-task')).toBe(true);
  });

  it('handleCreateTask auto-creates general feature when absent', () => {
    const before = readBacklog();
    expect(before.features.find(feature => feature.ref === 'general')).toBeUndefined();

    handleCreateTask(dir, {
      title: 'Auto feature task',
      actor_id: 'master',
    });

    const after = readBacklog();
    expect(after.features.find(feature => feature.ref === 'general')).toBeDefined();
  });

  it('handleCreateTask uses explicit feature when provided', () => {
    const created = handleCreateTask(dir, {
      feature: 'project',
      title: 'Explicit feature task',
      actor_id: 'master',
    });
    expect(created.ref).toMatch(/^project\//);
  });

  it('handleUpdateTask updates provided fields and leaves others unchanged', () => {
    const result = handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      title: 'Updated title',
      acceptance_criteria: ['criterion A'],
      actor_id: 'master',
    });

    expect(result.title).toBe('Updated title');
    expect(result.acceptance_criteria).toEqual(['criterion A']);
    const backlog = readBacklog();
    const task = backlog.features.flatMap(feature => feature.tasks).find((entry) => entry.ref === 'project/todo-one')!;
    expect(task.title).toBe('Updated title');
    expect(task).not.toHaveProperty('description');
  });

  it('handleUpdateTask updates priority without changing status or owner', () => {
    const backlog = readBacklog();
    const taskBefore = backlog.features.flatMap(feature => feature.tasks).find((entry) => entry.ref === 'project/todo-one')!;
    taskBefore.status = 'in_progress';
    taskBefore.owner = 'orc-2';
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    const result = handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      priority: 'critical',
      actor_id: 'master',
    });
    expect(result.priority).toBe('critical');

    const taskAfter = readBacklog().features.flatMap(feature => feature.tasks).find((entry) => entry.ref === 'project/todo-one')!;
    expect(taskAfter.priority).toBe('critical');
    expect(taskAfter.status).toBe('in_progress');
    expect(taskAfter.owner).toBe('orc-2');
  });

  it('handleUpdateTask updates updated_at on successful update', () => {
    const before = readBacklog().features.flatMap(feature => feature.tasks)
      .find((task) => task.ref === 'project/todo-one')!.updated_at;
    const now = '2026-01-01T00:10:00.000Z';
    vi.spyOn(Date, 'now').mockReturnValue(new Date(now).getTime());

    handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      title: 'Updated title',
      actor_id: 'master',
    });

    const after = readBacklog().features.flatMap(feature => feature.tasks)
      .find((task) => task.ref === 'project/todo-one')!.updated_at;
    expect(after).not.toBe(before);
  });

  it('handleUpdateTask appends task_updated event with changed fields list', () => {
    handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      description: 'new desc',
      depends_on: ['project/done-one'],
      actor_id: 'master',
    });
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    const event = JSON.parse(events.trim().split('\n').at(-1)!);
    expect(event.event).toBe('task_updated');
    expect(event.task_ref).toBe('project/todo-one');
    expect(event.payload.fields).toEqual(expect.arrayContaining(['description', 'depends_on']));
    expect(event.payload.fields).not.toContain('title');
  });

  it('handleUpdateTask throws when task_ref is missing', () => {
    expect(() => handleUpdateTask(dir, { actor_id: 'master' })).toThrow(/task_ref is required/);
  });

  it('handleUpdateTask throws when task does not exist', () => {
    expect(() => handleUpdateTask(dir, {
      task_ref: 'project/nonexistent',
      actor_id: 'master',
    })).toThrow(/Task not found/);
  });

  it('handleUpdateTask throws when actor_id format is invalid', () => {
    expect(() => handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      actor_id: 'INVALID',
    })).toThrow(/Invalid actor_id/);
  });

  it('handleUpdateTask throws when acceptance_criteria is not an array', () => {
    expect(() => handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      acceptance_criteria: 'not an array',
      actor_id: 'master',
    })).toThrow(/acceptance_criteria must be an array/);
  });

  it('handleUpdateTask throws when depends_on is not an array', () => {
    expect(() => handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      depends_on: 'not an array',
      actor_id: 'master',
    })).toThrow(/depends_on must be an array/);
  });

  it('handleUpdateTask throws when priority is invalid', () => {
    expect(() => handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      priority: 'urgent',
      actor_id: 'master',
    })).toThrow(/Invalid priority/);
  });

  it('handleDelegateTask assigns explicit target and appends task_delegated event', () => {
    seedClaims([]);
    const result = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });

    const backlog = readBacklog();
    const projectEpic = backlog.features.find(feature => feature.ref === 'project');
    const updated = projectEpic?.tasks.find((task) => task.ref === 'project/todo-one');
    expect(updated?.owner).toBe('orc-1');
    expect(updated?.delegated_by).toBe('master');

    const eventsRaw = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(eventsRaw).toContain('"event":"task_delegated"');
    expect(eventsRaw).toContain('"agent_id":"orc-1"');
  });

  it('handleDelegateTask transitions blocked task to todo and updates planning fields', () => {
    seedClaims([]);
    const before = readBacklog().features.find(feature => feature.ref === 'infra')?.tasks
      .find((task) => task.ref === 'infra/blocked-one');
    expect(before?.status).toBe('blocked');

    const result = handleDelegateTask(dir, {
      task_ref: 'infra/blocked-one',
      target_agent_id: 'orc-1',
      task_type: 'refactor',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'infra/blocked-one', assigned_to: 'orc-1' });

    const after = readBacklog().features.find(feature => feature.ref === 'infra')?.tasks
      .find((task) => task.ref === 'infra/blocked-one');
    expect(after?.status).toBe('todo');
    expect(after?.planning_state).toBe('ready_for_dispatch');
    expect(after?.updated_at).not.toBe(before?.updated_at);
  });

  it('handleDelegateTask returns warning when no eligible worker exists', () => {
    seedAgents([{ agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' }]);
    const result = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result.warning).toBe('no_eligible_worker');
    expect(result.task_ref).toBe('project/todo-one');
    expect(result.message).toContain('No eligible worker');
    expect(Array.isArray(result.candidate_diagnostics)).toBe(true);
  });

  it('handleDelegateTask clears stale owner when no eligible worker exists', () => {
    const backlog = readBacklog();
    const feature = backlog.features.find((e) => e.ref === 'project');
    if (!feature) throw new Error('test setup: feature not found');
    const task = feature.tasks.find((candidate) => candidate.ref === 'project/todo-one');
    if (!task) throw new Error('test setup: task not found');
    task.owner = 'orc-1';
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    seedAgents([{ agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' }]);
    const result = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result.warning).toBe('no_eligible_worker');
    expect(result.task_ref).toBe('project/todo-one');
    const refreshed = readBacklog().features.find(feature => feature.ref === 'project')?.tasks
      .find((candidate) => candidate.ref === 'project/todo-one');
    expect(refreshed).not.toHaveProperty('owner');
  });

  it('handleDelegateTask auto-selects first eligible worker when target is omitted', () => {
    seedClaims([]);
    const result = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });
  });

  it('handleDelegateTask auto-selection uses round-robin across eligible workers (A then B then A)', () => {
    const backlog = readBacklog();
    const projectEpic = backlog.features.find(feature => feature.ref === 'project')!;
    projectEpic.tasks.push(
      {
        ref: 'project/todo-two',
        title: 'Todo two',
        status: 'todo',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        ref: 'project/todo-three',
        title: 'Todo three',
        status: 'todo',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    );
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
    seedClaims([]);
    seedAgents([
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running' },
    ]);

    const first = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    const second = handleDelegateTask(dir, {
      task_ref: 'project/todo-two',
      task_type: 'implementation',
      actor_id: 'master',
    });
    const third = handleDelegateTask(dir, {
      task_ref: 'project/todo-three',
      task_type: 'implementation',
      actor_id: 'master',
    });

    expect(first).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });
    expect(second).toEqual({ task_ref: 'project/todo-two', assigned_to: 'orc-2' });
    expect(third).toEqual({ task_ref: 'project/todo-three', assigned_to: 'orc-1' });

    const dispatchState = JSON.parse(readFileSync(join(dir, 'dispatch-state.json'), 'utf8'));
    expect(dispatchState.last_assigned_agent_id).toBe('orc-1');
  });

  it('handleDelegateTask falls back to first-match when dispatch-state.json is missing', () => {
    const backlog = readBacklog();
    const projectEpic = backlog.features.find(feature => feature.ref === 'project')!;
    projectEpic.tasks.push({
      ref: 'project/todo-two',
      title: 'Todo two',
      status: 'todo',
      task_type: 'implementation',
      planning_state: 'ready_for_dispatch',
      delegated_by: 'master',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));
    seedClaims([]);
    seedAgents([
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running' },
    ]);

    const first = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(first).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });

    rmSync(join(dir, 'dispatch-state.json'), { force: true });

    const second = handleDelegateTask(dir, {
      task_ref: 'project/todo-two',
      task_type: 'implementation',
      actor_id: 'master',
    });
    expect(second).toEqual({ task_ref: 'project/todo-two', assigned_to: 'orc-1' });
  });

  it('handleDelegateTask errors on invalid target and missing task', () => {
    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'missing-worker',
      actor_id: 'master',
    })).toThrow(/Target agent not found/);
    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/missing-task',
      actor_id: 'master',
    })).toThrow(/Task not found/);
  });

  it('handleDelegateTask rejects explicit target when agent already has an active run', () => {
    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/Target agent orc-1 already has active run run-1/);
  });

  it('handleDelegateTask explicit target is unaffected by round-robin state', () => {
    writeFileSync(
      join(dir, 'dispatch-state.json'),
      JSON.stringify({
        version: '1',
        last_assigned_agent_id: 'orc-2',
        updated_at: '2026-01-01T00:00:00.000Z',
      }),
    );
    seedClaims([]);
    seedAgents([
      { agent_id: 'master', provider: 'claude', role: 'master', status: 'idle' },
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running' },
      { agent_id: 'orc-2', provider: 'codex', role: 'worker', status: 'running' },
    ]);

    const result = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    });
    expect(result).toEqual({ task_ref: 'project/todo-one', assigned_to: 'orc-1' });

    const dispatchState = JSON.parse(readFileSync(join(dir, 'dispatch-state.json'), 'utf8'));
    expect(dispatchState.last_assigned_agent_id).toBe('orc-2');
  });

  it('handleDelegateTask rejects targets that cannot execute task type', () => {
    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'master',
      task_type: 'implementation',
      actor_id: 'master',
    })).toThrow(/cannot execute task: role_ineligible:master/);
  });

  it('handleDelegateTask surfaces routing reasons for explicit target rejection', () => {
    seedClaims([]);
    const backlog = readBacklog();
    const task = backlog.features[0].tasks.find((entry) => entry.ref === 'project/todo-one')!;
    task.required_capabilities = ['sql'];
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/missing_capability:sql/);
    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/missing required capability 'sql'/);
  });

  it('handleDelegateTask surfaces provider mismatch for explicit target rejection', () => {
    seedClaims([]);
    const backlog = readBacklog();
    const task = backlog.features[0].tasks.find((entry) => entry.ref === 'project/todo-one')!;
    task.required_provider = 'gemini';
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/provider_mismatch:gemini/);
    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      target_agent_id: 'orc-1',
      actor_id: 'master',
    })).toThrow(/task requires provider 'gemini'/);
  });

  it('handleDelegateTask returns owner and provider diagnostics when auto-selection fails', () => {
    seedClaims([]);
    const backlog = readBacklog();
    const task = backlog.features[0].tasks.find((entry) => entry.ref === 'project/todo-one')!;
    task.owner = 'orc-2';
    task.required_provider = 'gemini';
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify(backlog, null, 2));

    const result = handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
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

  it('handleDelegateTask validates actor_id registration for non-human actors', () => {
    expect(() => handleDelegateTask(dir, {
      task_ref: 'project/todo-one',
      actor_id: 'ghost-agent',
    })).toThrow(/Actor agent not found/);
  });

  it('handleCancelTask sets todo task to blocked and returns cancelled=true', () => {
    seedClaims([]);
    const result = handleCancelTask(dir, {
      task_ref: 'project/todo-one',
      reason: 'cancelled by operator',
      actor_id: 'master',
    });
    expect(result).toEqual({
      cancelled: true,
      task_ref: 'project/todo-one',
      status: 'blocked',
    });

    const task = readBacklog().features.flatMap(feature => feature.tasks).find((entry) => entry.ref === 'project/todo-one')!;
    expect(task.status).toBe('blocked');

    const event = JSON.parse(readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').at(-1)!);
    expect(event.event).toBe('task_cancelled');
    expect(event.task_ref).toBe('project/todo-one');
  });

  it('handleCancelTask removes active in_progress claim, emits run_cancelled, and deposits TASK_COMPLETE notification', () => {
    const result = handleCancelTask(dir, {
      task_ref: 'project/todo-one',
      reason: 'manual cancellation',
      actor_id: 'master',
    }) as Record<string, unknown>;
    expect(result.cancelled).toBe(true);
    expect(result.cancelled_run_id).toBe('run-1');

    const remainingClaims = readFileSync(join(dir, 'claims.json'), 'utf8');
    expect(remainingClaims).not.toContain('"run_id":"run-1"');
    expect(remainingClaims).not.toContain('"run_id":"run-4"');

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    expect(events).toContain('"event":"run_cancelled"');
    expect(events).toContain('"run_id":"run-1"');
    expect(events).toContain('"run_id":"run-4"');
    expect(events).toContain('"event":"task_cancelled"');

    const notifications = readPendingNotifications(dir);
    expect(notifications.filter((n) => n.type === 'TASK_COMPLETE' && n.task_ref === 'project/todo-one' && n.success === false)).toHaveLength(2);
  });

  it('handleCancelTask returns already_terminal on done task without state change', () => {
    const before = readBacklog();
    const result = handleCancelTask(dir, {
      task_ref: 'project/done-one',
      actor_id: 'master',
    });
    expect(result).toEqual({
      error: 'already_terminal',
      task_ref: 'project/done-one',
      status: 'done',
    });
    expect(readBacklog()).toEqual(before);
  });

  it('handleCancelTask is idempotent on blocked task and returns cancelled=true', () => {
    const first = handleCancelTask(dir, {
      task_ref: 'infra/blocked-one',
      actor_id: 'master',
    }) as Record<string, unknown>;
    const second = handleCancelTask(dir, {
      task_ref: 'infra/blocked-one',
      actor_id: 'master',
    }) as Record<string, unknown>;
    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(true);
    expect(second.status).toBe('blocked');
  });

  it('handleRespondInput clears awaiting_input state and appends input_response', () => {
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

    const result = handleRespondInput(dir, {
      run_id: 'run-input-1',
      agent_id: 'orc-1',
      response: 'yes',
    });

    expect(result.ok).toBe(true);
    const claims = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
    expect(claims.claims[0].input_state).toBeNull();
    expect(claims.claims[0].input_requested_at).toBeNull();
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events.some((event) =>
      event.event === 'input_response'
      && event.run_id === 'run-input-1'
      && event.payload?.response === 'yes')).toBe(true);
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

describe('handleListWaitingInput', () => {
  it('returns empty when no claims await input', () => {
    const result = handleListWaitingInput(dir);
    expect(result).toEqual([]);
  });

  it('returns waiting claims with question text', () => {
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
    ]);
    seedEventsLines([
      JSON.stringify({
        seq: 1,
        ts: '2026-01-01T00:05:00.000Z',
        event: 'input_requested',
        run_id: 'run-waiting',
        agent_id: 'orc-1',
        payload: { question: 'Should I proceed?' },
      }),
    ]);

    const result = handleListWaitingInput(dir) as Array<Record<string, unknown>>;
    expect(result).toHaveLength(1);
    expect(result[0].run_id).toBe('run-waiting');
    expect(result[0].question).toBe('Should I proceed?');
    expect(result[0].input_requested_at).toBe('2026-01-01T00:05:00.000Z');
  });
});

describe('handleQueryEvents', () => {
  it('returns all events when no filters applied', () => {
    const result = handleQueryEvents(dir);
    expect(result).toHaveLength(3); // 3 valid lines (1 malformed excluded)
  });

  it('filters by event_type', () => {
    const result = handleQueryEvents(dir, { event_type: 'run_started' });
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).event).toBe('run_started');
  });

  it('filters by after_seq', () => {
    const result = handleQueryEvents(dir, { after_seq: 2 });
    expect(result).toHaveLength(1);
    expect((result[0] as Record<string, unknown>).seq).toBe(3);
  });

  it('respects limit cap', () => {
    const result = handleQueryEvents(dir, { limit: 1 });
    expect(result).toHaveLength(1);
  });

  it('returns empty array when no events file exists', () => {
    rmSync(join(dir, 'events.jsonl'));
    expect(handleQueryEvents(dir)).toEqual([]);
  });
});

describe('handleResetTask', () => {
  it('resets task to todo and cancels active claims', () => {
    const result = handleResetTask(dir, { task_ref: 'project/todo-one', actor_id: 'master' }) as Record<string, unknown>;
    expect(result.reset).toBe(true);
    expect(result.previous_status).toBe('todo');
    expect(result.cancelled_claims).toBe(2); // run-1 and run-4 are in_progress

    const backlog = readBacklog();
    const task = backlog.features[0].tasks.find((t) => t.ref === 'project/todo-one');
    expect(task?.status).toBe('todo');
  });

  it('uses human as default actor_id', () => {
    expect(() => handleResetTask(dir, { task_ref: 'project/todo-one' })).not.toThrow();
  });

  it('throws on missing task_ref', () => {
    expect(() => handleResetTask(dir, {})).toThrow('task_ref is required');
  });

  it('throws on invalid actor_id', () => {
    expect(() => handleResetTask(dir, { task_ref: 'project/todo-one', actor_id: 'INVALID!' })).toThrow('Invalid actor_id');
  });

  it('throws when task not found', () => {
    expect(() => handleResetTask(dir, { task_ref: 'no/such-task', actor_id: 'master' })).toThrow('task not found');
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

describe('handleCreateTask required_provider', () => {
  it('stores required_provider when provided', () => {
    const result = handleCreateTask(dir, {
      feature: 'project',
      title: 'Provider task',
      required_provider: 'claude',
      actor_id: 'master',
    }) as Record<string, unknown>;
    expect(result.required_provider).toBe('claude');
    const saved = readBacklog();
    const task = saved.features.flatMap((e) => e.tasks).find((t) => t.ref === 'project/provider-task');
    expect(task?.required_provider).toBe('claude');
  });

  it('omits required_provider when not provided', () => {
    const result = handleCreateTask(dir, {
      feature: 'project',
      title: 'No provider task',
      actor_id: 'master',
    }) as Record<string, unknown>;
    expect(result.required_provider).toBeUndefined();
  });

  it('throws on invalid required_provider', () => {
    expect(() =>
      handleCreateTask(dir, {
        feature: 'project',
        title: 'Bad provider task',
        required_provider: 'bogus',
        actor_id: 'master',
      }),
    ).toThrow(/invalid required_provider/i);
  });
});

describe('handleUpdateTask required_provider', () => {
  it('sets required_provider on existing task', () => {
    handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      required_provider: 'gemini',
      actor_id: 'master',
    });
    const saved = readBacklog();
    const task = saved.features.flatMap((e) => e.tasks).find((t) => t.ref === 'project/todo-one');
    expect(task?.required_provider).toBe('gemini');
  });

  it('clears required_provider when passed null', () => {
    // First set it
    handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      required_provider: 'claude',
      actor_id: 'master',
    });
    // Now clear it
    handleUpdateTask(dir, {
      task_ref: 'project/todo-one',
      required_provider: null,
      actor_id: 'master',
    });
    const saved = readBacklog();
    const task = saved.features.flatMap((e) => e.tasks).find((t) => t.ref === 'project/todo-one');
    expect(task?.required_provider).toBeUndefined();
  });

  it('throws on invalid required_provider value', () => {
    expect(() =>
      handleUpdateTask(dir, {
        task_ref: 'project/todo-one',
        required_provider: 'bogus',
        actor_id: 'master',
      }),
    ).toThrow(/invalid required_provider/i);
  });
});
