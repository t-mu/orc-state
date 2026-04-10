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
 * Creates a mock adapter that simulates agent behaviour: on start(), it emits
 * a reported_for_duty event (simulating the bootstrap handshake); on send(), it
 * extracts the run_id from the task envelope text and calls startRun. finishRun
 * is deferred so markTaskEnvelopeSent can record envelope delivery first.
 * Callers must call finishRun manually after the tick.
 * send() returns '' (fire-and-forget, matching the real pty adapter).
 */
function makeTmuxMockAdapter(agentId = 'worker-01') {
  const dispatchedRunIds: string[] = [];
  return {
    dispatchedRunIds,
    start: vi.fn().mockImplementation((_agentId: string, { system_prompt }: { system_prompt: string }) => {
      const sessionToken = /session_token: ([^\n]+)/.exec(system_prompt)?.[1]?.trim();
      const sessionHandle = createSessionHandle(_agentId);
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
      if (runId) {
        dispatchedRunIds.push(runId);
        startRun(dir, runId, agentId);
        // finishRun deferred — callers must call it after the tick so
        // markTaskEnvelopeSent can record envelope delivery first.
      }
      return '';
    }),
    attach: vi.fn(),
    heartbeatProbe: vi.fn().mockResolvedValue(true),
    stop: vi.fn().mockResolvedValue(undefined),
    getOutputTail: vi.fn().mockReturnValue(null),
  };
}

function seedState(stateDir: string) {
  writeFileSync(join(stateDir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [
      {
        ref: 'docs',
        title: 'Docs',
        tasks: [
          {
            ref: 'docs/task-1',
            title: 'Task 1',
            status: 'todo',
            planning_state: 'ready_for_dispatch',
            task_type: 'implementation',
          },
        ],
      },
    ],
  }));

  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      {
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        capabilities: [],
        model: null,
        dispatch_mode: null,
        status: 'running',
        session_handle: 'pty:worker-01',
        session_token: 'tok-worker-01',
        session_started_at: '2026-01-01T00:00:00.000Z',
        session_ready_at: '2026-01-01T00:00:01.000Z',
        provider_ref: null,
        last_heartbeat_at: null,
        registered_at: '2026-01-01T00:00:00.000Z',
      },
    ],
  }));

  writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
}

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

function readEvents(stateDir: string): Array<Record<string, unknown>> {
  return readEventsFromDb(join(stateDir, 'events.db')) as unknown as Array<Record<string, unknown>>;
}

describe('orchestration lifecycle e2e (coordinator + orc-run-* CLI reporting)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dir = createTempStateDir('orch-e2e-');
    seedState(dir);
    process.env.ORC_STATE_DIR = dir;
    process.env.ORC_REPO_ROOT = dir;
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
    const adapter = makeTmuxMockAdapter('worker-01');
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim + start session (reported_for_duty emitted in adapter.start mock)
    await coordinator.tick();
    // Tick 2: process reported_for_duty, send task envelope (startRun in send mock)
    await coordinator.tick();

    expect(adapter.send).toHaveBeenCalled();
    expect(adapter.dispatchedRunIds).toHaveLength(1);

    // Complete the run (deferred from send mock to avoid markTaskEnvelopeSent race)
    finishRun(dir, adapter.dispatchedRunIds[0], 'worker-01', { success: true });

    // Tick 3: process terminal run events (run_started + run_finished)
    await coordinator.tick();

    const events = readEvents(dir);
    expect(events.some((e) => e.event === 'run_started')).toBe(true);
    expect(events.some((e) => e.event === 'run_finished')).toBe(true);
    const agent = readAgents(dir).agents.find((entry) => entry.agent_id === 'worker-01')!;
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBe(null);
  });

  it('finalizes a work-complete run through the coordinator merge path', async () => {
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
    const adapter = makeTmuxMockAdapter('worker-01');
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim + start session
    await coordinator.tick();
    // Tick 2: process reported_for_duty, dispatch task envelope (startRun in mock)
    await coordinator.tick();

    expect(adapter.dispatchedRunIds).toHaveLength(1);
    finishRun(dir, adapter.dispatchedRunIds[0], 'worker-01', { success: true });

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
    const adapter = makeTmuxMockAdapter('worker-01');
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
    const dispatchedRunIds: string[] = [];
    const adapter = {
      start: vi.fn().mockImplementation((_agentId: string, { system_prompt }: { system_prompt: string }) => {
        const sessionToken = /session_token: ([^\n]+)/.exec(system_prompt)?.[1]?.trim();
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
        return Promise.resolve({
          session_handle: createSessionHandle(_agentId),
          provider_ref: { provider: 'claude' },
        });
      }),
      send: vi.fn().mockImplementation((_handle: string, text: string) => {
        const runId = /\nrun_id: ([^\n]+)/.exec(text)?.[1]?.trim();
        if (runId) {
          dispatchedRunIds.push(runId);
          startRun(dir, runId, 'worker-01');
        }
        return '';
      }),
      attach: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim + start session
    await coordinator.tick();
    // Tick 2: process reported_for_duty, dispatch task envelope (startRun in mock)
    await coordinator.tick();

    expect(dispatchedRunIds).toHaveLength(1);
    finishRun(dir, dispatchedRunIds[0], 'worker-01', {
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
          status: 'running',
          session_handle: null,
          provider_ref: null,
          last_heartbeat_at: null,
          registered_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));

    const prompts: string[] = [];
    const adapter = {
      start: vi.fn().mockImplementation((_agentId: string, config: { system_prompt: string }) => {
        prompts.push(config.system_prompt);
        return Promise.resolve({ session_handle: 'pty:worker-01', provider_ref: {} });
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
    writeFileSync(join(dir, 'events.jsonl'), '');

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
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
      version: '1',
      features: [
        {
          ref: 'docs',
          title: 'Docs',
          tasks: [
            { ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation', owner: 'worker-01' },
            { ref: 'docs/task-2', title: 'Task 2', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation', owner: 'worker-02' },
          ],
        },
      ],
    }));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [
        { agent_id: 'worker-01', provider: 'claude', role: 'worker', status: 'running', session_handle: 'pty:worker-01', session_token: 'tok-w1', session_started_at: '2026-01-01T00:00:00.000Z', session_ready_at: '2026-01-01T00:00:01.000Z', registered_at: '2026-01-01T00:00:00.000Z' },
        { agent_id: 'worker-02', provider: 'claude', role: 'worker', status: 'running', session_handle: 'pty:worker-02', session_token: 'tok-w2', session_started_at: '2026-01-01T00:00:00.000Z', session_ready_at: '2026-01-01T00:00:01.000Z', registered_at: '2026-01-01T00:00:00.000Z' },
      ],
    }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));

    const adapter = {
      start: vi.fn().mockImplementation((_agentId: string, { system_prompt }: { system_prompt: string }) => {
        const sessionToken = /session_token: ([^\n]+)/.exec(system_prompt)?.[1]?.trim();
        const sessionHandle = createSessionHandle(_agentId);
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
        return Promise.resolve({
          session_handle: sessionHandle,
          provider_ref: { provider: 'claude' },
        });
      }),
      send: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return '';
      }),
      attach: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim both tasks, start sessions (reported_for_duty emitted in adapter.start)
    await coordinator.tick();
    // Tick 2: process reported_for_duty, dispatch both envelopes concurrently
    const startedAt = Date.now();
    await coordinator.tick();
    const elapsedMs = Date.now() - startedAt;

    expect(adapter.send).toHaveBeenCalledTimes(2);
    expect(elapsedMs).toBeLessThan(320);
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

  it('marks agent offline and emits deterministic startup failure events when adapter.start throws', async () => {
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
          status: 'running',
          session_handle: null,
          provider_ref: null,
          last_heartbeat_at: null,
          registered_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));

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

    const agents = readAgents(dir).agents;
    expect(agents[0].status).toBe('offline');
    expect(agents[0].session_handle).toBe(null);

    const events = readEvents(dir);
    const launchFailure = events.find((event) => event.event === 'session_start_failed' && event.agent_id === 'worker-01')!;
    expect(launchFailure).toBeTruthy();
    expect(launchFailure.task_ref).toBe('docs/task-1');
    expect((launchFailure.payload as Record<string, unknown>).reason).toBe('binary not found');
    expect(events.some((event) => event.event === 'agent_offline' && event.agent_id === 'worker-01')).toBe(true);
  });

  it('coordinator creates a worker session and dispatches from null handle', async () => {
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
          status: 'running',
          session_handle: null,
          provider_ref: null,
          last_heartbeat_at: null,
          registered_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }));

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

    const agent = readAgents(dir).agents.find((a) => a.agent_id === 'worker-01')!;
    expect(agent).toBeDefined();
    expect(agent.session_handle).toBe('pty:worker-01');
    expect(agent.status).toBe('running');

    const claim = readClaims(dir).claims.find((c) => c.task_ref === 'docs/task-1')!;
    expect(claim).toBeDefined();
    expect(claim.state).not.toBe('released');

    const task = readBacklog(dir).features[0].tasks.find((t) => t.ref === 'docs/task-1')!;
    expect(task).toBeDefined();
    expect(task.status).not.toBe('todo');

    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'agent_online' && event.agent_id === 'worker-01')).toBe(true);
    expect(events.some((event) => event.event === 'claim_created' && event.agent_id === 'worker-01')).toBe(true);
  });

  it('launches managed per-task workers on demand and keeps excess ready work queued under max_workers', async () => {
    seedManagedPoolState(dir, [
      { ref: 'docs/task-1', title: 'Task 1', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation' },
      { ref: 'docs/task-2', title: 'Task 2', status: 'todo', planning_state: 'ready_for_dispatch', task_type: 'implementation' },
    ]);
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'codex';

    const startedRuns: string[] = [];
    const adapter = {
      start: vi.fn().mockImplementation((_agentId: string, { system_prompt }: { system_prompt: string }) => {
        const sessionToken = /session_token: ([^\n]+)/.exec(system_prompt)?.[1]?.trim();
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
        return Promise.resolve({
          session_handle: createSessionHandle(_agentId),
          provider_ref: { provider: 'codex' },
        });
      }),
      send: vi.fn().mockImplementation((_handle: string, text: string) => {
        const runId = /\nrun_id: ([^\n]+)/.exec(text)?.[1]?.trim();
        if (runId) {
          startedRuns.push(runId);
          startRun(dir, runId, 'orc-1');
        }
        return '';
      }),
      attach: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim task-1, start session (reported_for_duty emitted in adapter.start)
    await coordinator.tick();
    // Tick 2: process reported_for_duty, send task envelope
    await coordinator.tick();

    expect(adapter.start).toHaveBeenCalledOnce();
    expect(adapter.send).toHaveBeenCalledOnce();
    expect(startedRuns).toHaveLength(1);

    let backlog = readBacklog(dir);
    expect(backlog.features[0].tasks.find((task) => task.ref === 'docs/task-1')?.status).toBe('in_progress');
    expect(backlog.features[0].tasks.find((task) => task.ref === 'docs/task-2')?.status).toBe('todo');

    const agentsAfterFirstTick = readAgents(dir).agents;
    expect(agentsAfterFirstTick.map((agent) => agent.agent_id)).toEqual(['master', 'orc-1']);

    finishRun(dir, startedRuns[0], 'orc-1', { success: true });
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

    const adapter = {
      start: vi.fn()
        .mockRejectedValueOnce(new Error('spawn failed once'))
        .mockImplementation((_agentId: string, { system_prompt }: { system_prompt: string }) => {
          const sessionToken = /session_token: ([^\n]+)/.exec(system_prompt)?.[1]?.trim();
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
          return Promise.resolve({
            session_handle: createSessionHandle(_agentId),
            provider_ref: { provider: 'codex' },
          });
        }),
      send: vi.fn().mockImplementation((_handle: string, text: string) => {
        const runId = /\nrun_id: ([^\n]+)/.exec(text)?.[1]?.trim();
        if (runId) {
          dispatchedRunIds.push(runId);
          startRun(dir, runId, 'orc-1');
        }
        return '';
      }),
      attach: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    const dispatchedRunIds: string[] = [];
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    // Tick 1: claim task, adapter.start fails → retry state set, task stays claimed
    await coordinator.tick();

    let backlog = readBacklog(dir);
    // Task stays claimed (managed slot retries instead of failing immediately)
    expect(backlog.features[0].tasks[0].status).toBe('claimed');
    let claims = readClaims(dir).claims;
    expect(claims[0]?.state).toBe('claimed');
    expect(claims[0]?.session_start_retry_count).toBe(1);

    // Fast-forward the retry timer so the next tick can retry
    const claimsData = JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
    claimsData.claims[0].session_start_retry_next_at = new Date(Date.now() - 1000).toISOString();
    writeFileSync(join(dir, 'claims.json'), JSON.stringify(claimsData));

    // Tick 2: retry session start (succeeds this time), reported_for_duty emitted
    await coordinator.tick();
    // Tick 3: process reported_for_duty, send task envelope (startRun in mock)
    await coordinator.tick();

    expect(dispatchedRunIds).toHaveLength(1);
    finishRun(dir, dispatchedRunIds[0], 'orc-1', { success: true });

    backlog = readBacklog(dir);
    claims = readClaims(dir).claims;
    expect(backlog.features[0].tasks[0].status).toBe('done');
    expect(claims.some((claim) => claim.state === 'done')).toBe(true);

    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'run_finished' && event.agent_id === 'orc-1')).toBe(true);
    expect(adapter.start).toHaveBeenCalledTimes(2);
  });
});
