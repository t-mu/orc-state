import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { startRun, finishRun } from '../lib/claimManager.ts';
import { createSessionHandle } from '../adapters/pty.ts';
import { readEvents as readEventsFromDb, appendSequencedEvent } from '../lib/eventLog.ts';

function readClaims(stateDir: string): { claims: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8'));
}

function readBacklog(stateDir: string): { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8'));
}
function readAgents(stateDir: string): { agents: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8'));
}

let dir: string;

/**
 * Creates a mock adapter for the dynamic ephemeral worker model.
 * On start(), it captures the dynamically assigned agent ID and emits
 * reported_for_duty. On send(), it resolves the agent from the session handle
 * and calls startRun with the correct agent ID.
 * Callers must call finishRun manually after the tick.
 */
function makeDynamicMockAdapter() {
  const dispatchedRunIds: string[] = [];
  const agentsByHandle = new Map<string, string>();
  const spawnedAgentIds: string[] = [];
  return {
    dispatchedRunIds,
    agentsByHandle,
    spawnedAgentIds,
    start: vi.fn().mockImplementation((_agentId: string, { system_prompt }: { system_prompt: string }) => {
      spawnedAgentIds.push(_agentId);
      const sessionToken = /session_token: ([^\n]+)/.exec(system_prompt)?.[1]?.trim();
      const sessionHandle = createSessionHandle(_agentId);
      agentsByHandle.set(sessionHandle, _agentId);
      if (sessionToken) {
        appendSequencedEvent(dir, {
          ts: new Date().toISOString(),
          event: 'reported_for_duty',
          actor_type: 'agent',
          actor_id: _agentId,
          agent_id: _agentId,
          payload: { session_token: sessionToken },
        });
      }
      return Promise.resolve({ session_handle: sessionHandle, provider_ref: { provider: 'claude' } });
    }),
    send: vi.fn().mockImplementation((_handle: string, text: string) => {
      const runId = /\nrun_id: ([^\n]+)/.exec(text)?.[1]?.trim();
      const agentId = agentsByHandle.get(_handle);
      if (runId && agentId) {
        dispatchedRunIds.push(runId);
        startRun(dir, runId, agentId);
      }
      return '';
    }),
    attach: vi.fn(),
    heartbeatProbe: vi.fn().mockResolvedValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
    getOutputTail: vi.fn().mockReturnValue(null),
  };
}

/**
 * Seeds state with only a master agent — ephemeral workers are spawned on demand
 * by the coordinator's executeDispatchPlan when ORC_MAX_WORKERS is set.
 */
function seedManagedPoolState(stateDir: string, tasks: unknown[]) {
  writeFileSync(join(stateDir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [
      {
        ref: 'docs',
        title: 'Docs',
        tasks,
      },
    ],
  }));

  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      {
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        capabilities: [],
        model: null,
        dispatch_mode: null,
        status: 'running',
        session_handle: 'pty:master',
        provider_ref: null,
        last_heartbeat_at: null,
        registered_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  }));

  writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
}

const DEFAULT_TASK = {
  ref: 'docs/task-1',
  title: 'Task 1',
  status: 'todo',
  planning_state: 'ready_for_dispatch',
  task_type: 'implementation',
};

function readEvents(stateDir: string): Array<Record<string, unknown>> {
  return readEventsFromDb(join(stateDir, 'events.db')) as unknown as Array<Record<string, unknown>>;
}

describe('orchestration lifecycle e2e (coordinator + orc-run-* CLI reporting)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dir = createTempStateDir('orch-e2e-');
    // Seed with master-only state — ephemeral workers are spawned on demand
    seedManagedPoolState(dir, [DEFAULT_TASK]);
    process.env.ORC_STATE_DIR = dir;
    process.env.ORC_REPO_ROOT = dir;
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'claude';
    vi.doMock('../lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn((_stateDir, { runId }) => ({
        run_id: runId,
        branch: `task/${runId}`,
        worktree_path: `/tmp/orc-worktrees/${runId}`,
      })),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn((_stateDir, runId) => ({
        worktree_path: `/tmp/orc-worktrees/${runId}`,
      })),
    }));
  });

  afterEach(() => {
    cleanupTempStateDir(dir);
    delete process.env.ORC_STATE_DIR;
    delete process.env.ORC_REPO_ROOT;
    delete process.env.ORC_MAX_WORKERS;
    delete process.env.ORC_WORKER_PROVIDER;
    delete process.env.ORC_WORKER_MODEL;
    vi.unmock('../adapters/index.ts');
    vi.unmock('../lib/runWorktree.ts');
  });

  it('dispatches task and records run_started/run_finished from agent CLI calls', async () => {
    const adapter = makeDynamicMockAdapter();
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim + spawn ephemeral worker (reported_for_duty emitted in adapter.start mock)
    await coordinator.tick();
    // Tick 2: process reported_for_duty, send task envelope (startRun in send mock)
    await coordinator.tick();

    expect(adapter.send).toHaveBeenCalled();
    expect(adapter.dispatchedRunIds).toHaveLength(1);

    const agentId = adapter.spawnedAgentIds[0];
    // Complete the run (deferred from send mock to avoid markTaskEnvelopeSent race)
    finishRun(dir, adapter.dispatchedRunIds[0], agentId, { success: true });

    // Tick 3: process terminal run events (run_started + run_finished)
    await coordinator.tick();

    const events = readEvents(dir);
    expect(events.some((e) => e.event === 'run_started')).toBe(true);
    expect(events.some((e) => e.event === 'run_finished')).toBe(true);
    // Ephemeral worker is cleaned up after terminal run completion
    const workers = readAgents(dir).agents.filter((a) => a.role === 'worker');
    expect(workers).toHaveLength(0);
  });

  it('finalizes a work-complete run through the coordinator merge path', async () => {
    // This test directly calls processTerminalRunEvents — no dispatch involved.
    // Seed a pre-existing in_progress claim with a worker that has a session handle.
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [
        {
          ref: 'docs',
          title: 'Docs',
          tasks: [
            {
              ref: 'docs/task-1',
              title: 'Task 1',
              status: 'in_progress',
              planning_state: 'ready_for_dispatch',
              task_type: 'implementation',
            },
          ],
        },
      ],
    }));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [
        {
          agent_id: 'master',
          provider: 'claude',
          role: 'master',
          status: 'running',
          session_handle: 'pty:master',
          provider_ref: null,
          registered_at: '2026-01-01T00:00:00.000Z',
        },
        {
          agent_id: 'worker-01',
          provider: 'claude',
          role: 'worker',
          status: 'running',
          session_handle: 'pty:worker-01',
          session_token: 'tok-worker-01',
          session_started_at: '2026-01-01T00:00:00.000Z',
          session_ready_at: '2026-01-01T00:00:01.000Z',
          provider_ref: null,
          registered_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [
        {
          run_id: 'run-finalize-e2e',
          task_ref: 'docs/task-1',
          agent_id: 'worker-01',
          state: 'in_progress',
          claimed_at: '2026-03-11T08:00:00.000Z',
          started_at: '2026-03-11T08:00:00.000Z',
          lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          finalization_state: 'awaiting_finalize',
          finalization_retry_count: 0,
          finalization_blocked_reason: null,
          input_state: null,
          input_requested_at: null,
        },
      ],
    }));
    const send = vi.fn().mockResolvedValue('');
    const stop = vi.fn().mockResolvedValue(undefined);
    const cleanupRunWorktree = vi.fn().mockReturnValue(true);
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: '' });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync };
    });
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({
        start: vi.fn(),
        send,
        attach: vi.fn(),
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        stop,
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('../lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn((_stateDir, { runId }) => ({
        run_id: runId,
        branch: `task/${runId}`,
        worktree_path: `/tmp/orc-worktrees/${runId}`,
      })),
      cleanupRunWorktree,
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn(() => ({
        branch: 'task/run-finalize-e2e',
        worktree_path: '/tmp/orc-worktrees/run-finalize-e2e',
      })),
    }));

    const coordinator = await import('../coordinator.ts');
    await coordinator.processTerminalRunEvents([{
      ts: '2026-03-11T08:01:00.000Z',
      event: 'work_complete',
      actor_type: 'agent',
      actor_id: 'worker-01',
      run_id: 'run-finalize-e2e',
      task_ref: 'docs/task-1',
      agent_id: 'worker-01',
      payload: { status: 'awaiting_finalize', retry_count: 0 },
    }]);

    expect(send).toHaveBeenCalledWith('pty:worker-01', expect.stringContaining('FINALIZE_WAIT'));
    expect(send).toHaveBeenCalledWith('pty:worker-01', expect.stringContaining('FINALIZE_SUCCESS'));
    expect(cleanupRunWorktree).toHaveBeenCalledWith(dir, 'run-finalize-e2e');
    expect(readClaims(dir).claims.find((entry) => entry.run_id === 'run-finalize-e2e')?.state).toBe('done');
    expect(readBacklog(dir).features[0].tasks.find((entry) => entry.ref === 'docs/task-1')?.status).toBe('done');
  });

  it('transitions claim state to done and task status to done after agent calls run_finish', async () => {
    const adapter = makeDynamicMockAdapter();
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim + spawn ephemeral worker
    await coordinator.tick();
    // Tick 2: process reported_for_duty, dispatch task envelope (startRun in mock)
    await coordinator.tick();

    expect(adapter.dispatchedRunIds).toHaveLength(1);
    const agentId = adapter.spawnedAgentIds[0];
    finishRun(dir, adapter.dispatchedRunIds[0], agentId, { success: true });

    const claims = readClaims(dir);
    const claim = claims.claims.find((c) => c.task_ref === 'docs/task-1')!;
    expect(claim).toBeDefined();
    expect(claim.state).toBe('done');

    const backlog = readBacklog(dir);
    const task = backlog.features[0].tasks.find((t) => t.ref === 'docs/task-1')!;
    expect(task.status).toBe('done');
  });

  it('reuses adapter instance across ticks — createAdapter called once per provider', async () => {
    let createAdapterCalls = 0;
    const adapter = makeDynamicMockAdapter();
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: (_provider: string) => {
        createAdapterCalls++;
        return adapter;
      },
    }));

    // Seed a second task so the second tick also has work to consider.
    const backlogPath = join(dir, 'backlog.json');
    const backlog = readBacklog(dir);
    backlog.features[0].tasks.push({
      ref: 'docs/task-2',
      title: 'Task 2',
      status: 'todo',
      planning_state: 'ready_for_dispatch',
      task_type: 'implementation',
    });
    writeFileSync(backlogPath, JSON.stringify(backlog));

    const coordinator = await import('../coordinator.ts');
    await coordinator.tick();
    await coordinator.tick();

    // createAdapter should be called exactly once (for 'claude'), not once per tick.
    expect(createAdapterCalls).toBe(1);
  });

  it('handles agent calling run_fail — claim moves to failed and task is requeued', async () => {
    const adapter = makeDynamicMockAdapter();
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim + spawn ephemeral worker
    await coordinator.tick();
    // Tick 2: process reported_for_duty, dispatch task envelope (startRun in mock)
    await coordinator.tick();

    expect(adapter.dispatchedRunIds).toHaveLength(1);
    const agentId = adapter.spawnedAgentIds[0];
    finishRun(dir, adapter.dispatchedRunIds[0], agentId, {
      success: false,
      failureReason: 'build error',
      policy: 'requeue',
    });

    const claims = readClaims(dir);
    const claim = claims.claims.find((c) => c.task_ref === 'docs/task-1')!;
    expect(claim).toBeDefined();
    expect(claim.state).toBe('failed');

    // Task should be back to 'todo' (requeued).
    const backlog = readBacklog(dir);
    const task = backlog.features[0].tasks.find((t) => t.ref === 'docs/task-1')!;
    expect(task.status).toBe('todo');
  });

  it('uses worker bootstrap template when starting a session for missing handle', async () => {
    // Ephemeral workers are spawned by the coordinator with WORKER_BOOTSTRAP prompt
    const prompts: string[] = [];
    const adapter = {
      start: vi.fn().mockImplementation((_agentId: string, config: { system_prompt: string }) => {
        prompts.push(config.system_prompt);
        return Promise.resolve({ session_handle: createSessionHandle(_agentId), provider_ref: {} });
      }),
      send: vi.fn().mockResolvedValue(''),
      attach: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    await coordinator.tick();

    expect(adapter.start).toHaveBeenCalledOnce();
    expect(prompts[0]).toContain('WORKER_BOOTSTRAP');
  });

  it('does not bring a late-registered worker online before any task is assigned', async () => {
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [{ ref: 'docs', title: 'Docs', tasks: [] }],
    }));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [
        {
          agent_id: 'worker-01',
          provider: 'claude',
          role: 'worker',
          capabilities: [],
          model: null,
          dispatch_mode: null,
          status: 'idle',
          session_handle: null,
          provider_ref: null,
          last_heartbeat_at: null,
          registered_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));

    const adapter = {
      start: vi.fn().mockResolvedValue({
        session_handle: 'pty:worker-01',
        provider_ref: { provider: 'claude' },
      }),
      send: vi.fn().mockResolvedValue(''),
      attach: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    await coordinator.tick();

    expect(adapter.start).not.toHaveBeenCalled();

    const agent = readAgents(dir).agents.find((entry) => entry.agent_id === 'worker-01')!;
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBe(null);
    expect(agent.last_heartbeat_at).toBe(null);
    expect(readClaims(dir).claims).toHaveLength(0);
  });

  it('dispatches multiple tasks concurrently with bounded batch runner', async () => {
    seedManagedPoolState(dir, [
      { ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation' },
      { ref: 'docs/task-2', title: 'Task 2', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation' },
    ]);
    process.env.ORC_MAX_WORKERS = '2';

    const adapter = makeDynamicMockAdapter();
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim both tasks, spawn 2 ephemeral workers concurrently via runBounded
    await coordinator.tick();
    expect(adapter.start).toHaveBeenCalledTimes(2);

    // Tick 2: process reported_for_duty events, dispatch both envelopes
    await coordinator.tick();
    expect(adapter.send).toHaveBeenCalledTimes(2);
  });

  it('exports doShutdown and emits coordinator_stopped once', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const coordinator = await import('../coordinator.ts');
    await coordinator.doShutdown();
    await coordinator.doShutdown();

    const events = readEvents(dir);
    const stopped = events.filter((e) => e.event === 'coordinator_stopped');
    expect(stopped).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
  });

  it('cleans up ephemeral worker and emits startup failure events when adapter.start throws', async () => {
    const adapter = {
      start: vi.fn().mockRejectedValue(new Error('binary not found')),
      send: vi.fn().mockResolvedValue(''),
      attach: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    await expect(coordinator.tick()).resolves.toBeUndefined();

    // Ephemeral worker is removed after start failure (no lingering agent record)
    const workers = readAgents(dir).agents.filter((a) => a.role === 'worker');
    expect(workers).toHaveLength(0);

    // Task should be requeued (back to todo)
    const task = readBacklog(dir).features[0].tasks[0];
    expect(task.status).toBe('todo');

    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'session_start_failed')).toBe(true);
    const failEvent = events.find((event) => event.event === 'session_start_failed')!;
    expect(failEvent.task_ref).toBe('docs/task-1');
    expect((failEvent.payload as Record<string, unknown>).reason).toBe('binary not found');
  });

  it('coordinator spawns ephemeral worker and dispatches task', async () => {
    const adapter = makeDynamicMockAdapter();
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: spawn ephemeral worker
    await coordinator.tick();
    // Tick 2: process reported_for_duty, send envelope
    await coordinator.tick();

    const agentId = adapter.spawnedAgentIds[0];
    expect(agentId).toBeDefined();

    const agent = readAgents(dir).agents.find((a) => a.agent_id === agentId)!;
    expect(agent).toBeDefined();
    expect(agent.session_handle).toMatch(/^pty:/);
    expect(agent.status).toBe('running');

    const claim = readClaims(dir).claims.find((c) => c.task_ref === 'docs/task-1')!;
    expect(claim).toBeDefined();
    expect(claim.state).not.toBe('released');

    const task = readBacklog(dir).features[0].tasks.find((t) => t.ref === 'docs/task-1')!;
    expect(task).toBeDefined();
    expect(task.status).not.toBe('todo');

    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'agent_online' && event.agent_id === agentId)).toBe(true);
    expect(events.some((event) => event.event === 'claim_created' && event.agent_id === agentId)).toBe(true);
  });

  it('launches managed per-task workers on demand and keeps excess ready work queued under max_workers', async () => {
    seedManagedPoolState(dir, [
      { ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation' },
      { ref: 'docs/task-2', title: 'Task 2', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation' },
    ]);
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'codex';

    const adapter = makeDynamicMockAdapter();
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim task-1, start session (reported_for_duty emitted in adapter.start)
    await coordinator.tick();
    // Tick 2: process reported_for_duty, send task envelope
    await coordinator.tick();

    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(adapter.dispatchedRunIds).toHaveLength(1);

    let backlog = readBacklog(dir);
    expect(backlog.features[0].tasks.find((task) => task.ref === 'docs/task-1')?.status).toBe('in_progress');
    expect(backlog.features[0].tasks.find((task) => task.ref === 'docs/task-2')?.status).toBe('todo');

    const firstAgentId = adapter.spawnedAgentIds[0];
    const agentsAfterFirstDispatch = readAgents(dir).agents;
    expect(agentsAfterFirstDispatch.some((a) => a.agent_id === firstAgentId)).toBe(true);

    finishRun(dir, adapter.dispatchedRunIds[0], firstAgentId, { success: true });
    // Tick 3: process run_finished for task-1, claim task-2, start new session
    await coordinator.tick();
    // Tick 4: process reported_for_duty for task-2, send task envelope
    await coordinator.tick();

    expect(adapter.start).toHaveBeenCalledTimes(2);
    expect(adapter.send).toHaveBeenCalledTimes(2);

    backlog = readBacklog(dir);
    expect(backlog.features[0].tasks.find((task) => task.ref === 'docs/task-1')?.status).toBe('done');
    expect(backlog.features[0].tasks.find((task) => task.ref === 'docs/task-2')?.status).toBe('in_progress');
    expect(readClaims(dir).claims.filter((claim) => claim.state === 'in_progress')).toHaveLength(1);
    expect(readClaims(dir).claims.some((claim) => claim.task_ref === 'docs/task-2')).toBe(true);
  });

  it('recovers deterministically after a managed worker start failure and re-dispatches the requeued task', async () => {
    seedManagedPoolState(dir, [
      { ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation' },
    ]);
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'codex';

    const adapter = makeDynamicMockAdapter();
    // Override start to fail once then succeed
    const originalStart = adapter.start;
    adapter.start = vi.fn()
      .mockRejectedValueOnce(new Error('spawn failed once'))
      .mockImplementation((...args: unknown[]) => originalStart(...args));

    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim task, adapter.start fails → ephemeral worker removed, task requeued to todo
    await coordinator.tick();

    let backlog = readBacklog(dir);
    // Ephemeral workers fail-and-requeue immediately (no retry on same claim)
    expect(backlog.features[0].tasks[0].status).toBe('todo');

    // Tick 2: task is eligible again → new claim, new ephemeral worker, adapter.start succeeds
    await coordinator.tick();
    // Tick 3: process reported_for_duty, send task envelope (startRun in mock)
    await coordinator.tick();

    expect(adapter.dispatchedRunIds).toHaveLength(1);
    const agentId = adapter.spawnedAgentIds[0]; // first successful spawn
    finishRun(dir, adapter.dispatchedRunIds[0], agentId, { success: true });

    backlog = readBacklog(dir);
    const claims = readClaims(dir).claims;
    expect(backlog.features[0].tasks[0].status).toBe('done');
    expect(claims.some((claim) => claim.state === 'done')).toBe(true);

    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'run_finished')).toBe(true);
    expect(adapter.start).toHaveBeenCalledTimes(2);
  });
});
