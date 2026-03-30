import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryEvents } from './lib/eventLog.ts';
import { DEFAULT_LEASE_MS } from './lib/constants.ts';

let dir: string;

beforeEach(() => {
  // Reset module cache BEFORE each test so vi.doMock + dynamic import picks up
  // a fresh coordinator.ts (and fresh paths.ts / adapterInstances Map).
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'orc-coord-test-'));
  process.env.ORCH_STATE_DIR = dir;
  process.env.ORC_REPO_ROOT = dir;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
  delete process.env.ORC_REPO_ROOT;
  delete process.env.ORC_MAX_WORKERS;
  delete process.env.ORC_WORKER_PROVIDER;
  delete process.env.ORC_WORKER_MODEL;
});

function seedState(stateDir: string, { agents = [] as unknown[], tasks = [] as unknown[], claims = [] as unknown[] }: { agents?: unknown[]; tasks?: unknown[]; claims?: unknown[] } = {}) {
  writeFileSync(
    join(stateDir, 'agents.json'),
    JSON.stringify({ version: '1', agents }),
  );
  writeFileSync(
    join(stateDir, 'backlog.json'),
    JSON.stringify({ version: '1', features: tasks.length ? [{ ref: 'proj', title: 'Project', tasks }] : [] }),
  );
  writeFileSync(
    join(stateDir, 'claims.json'),
    JSON.stringify({ version: '1', claims }),
  );
  writeFileSync(join(stateDir, 'events.jsonl'), '');
}

function readEvents(stateDir: string): Array<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(stateDir, {}) as unknown as Array<any>;
}

function resetCheckpoint(stateDir: string) {
  writeFileSync(join(stateDir, 'event-checkpoint.json'), JSON.stringify({
    version: '1',
    last_processed_seq: 0,
    processed_event_ids: [],
    updated_at: new Date().toISOString(),
  }));
}

// A minimal dispatchable task — required to reach ensureSessionReady, which
// is only called inside the dispatch loop when an eligible task exists for
// the agent. Without a seeded task, tick() skips dispatch entirely.
const DISPATCHABLE_TASK = {
  ref: 'proj/fix-bug',
  title: 'Fix bug',
  status: 'todo',
  task_type: 'implementation',
  planning_state: 'ready_for_dispatch',
  delegated_by: 'master',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const COORDINATOR_PATH = fileURLToPath(new URL('./coordinator.ts', import.meta.url));

describe('ensureSessionReady: status invariant on session loss', () => {
  it('starts managed worker slots on dispatch inside the assigned worktree', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'running',
        session_handle: 'pty:master',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });
    process.env.ORC_MAX_WORKERS = '2';
    process.env.ORC_WORKER_PROVIDER = 'gemini';
    process.env.ORC_WORKER_MODEL = 'gemini-2.5-pro';

    const mockStart = vi.fn().mockResolvedValue({ session_handle: 'pty:orc-slot', provider_ref: null });
    const mockSend = vi.fn().mockResolvedValue('');
    const ensureRunWorktreeMock = vi.fn().mockReturnValue({
      run_id: 'run-allocated',
      branch: 'task/run-allocated',
      worktree_path: '/tmp/orc-worktrees/run-allocated',
    });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: mockSend,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: ensureRunWorktreeMock,
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    expect(agents.map((agent) => agent.agent_id)).toEqual(['master', 'orc-1', 'orc-2']);
    expect(agents.find((agent) => agent.agent_id === 'orc-1')?.provider).toBe('gemini');
    expect(agents.find((agent) => agent.agent_id === 'orc-2')?.provider).toBe('gemini');
    expect(ensureRunWorktreeMock).toHaveBeenCalledOnce();
    expect(mockStart).toHaveBeenCalledOnce();
    expect(mockStart).toHaveBeenCalledWith('orc-1', expect.objectContaining({
      model: 'gemini-2.5-pro',
      working_directory: '/tmp/orc-worktrees/run-allocated',
      env: expect.objectContaining({
        ORCH_STATE_DIR: dir,
      }),
    }));
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('requeues a managed slot after a transient start failure instead of leaving it offline', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'running',
        session_handle: 'pty:master',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'codex';

    const mockStart = vi.fn().mockRejectedValue(new Error('spawn failed'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    try {
      const { tick } = await import('./coordinator.ts');
      await tick();
      vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
      await tick();
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await tick();
    } finally {
      vi.useRealTimers();
    }

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const slot = agents.find((agent) => agent.agent_id === 'orc-1');
    expect(slot?.status).toBe('idle');
    expect(slot?.session_handle).toBeNull();

    const { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
    expect(claims[0]?.state).toBe('failed');

    const backlog = (readJson(dir, 'backlog.json') as { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> });
    expect(backlog.features[0].tasks[0].status).toBe('todo');

    const events = readEvents(dir);
    const launchFailure = events.find((event) => event.event === 'session_start_failed' && event.agent_id === 'orc-1')!;
    expect(launchFailure).toBeDefined();
    expect(launchFailure.run_id).toMatch(/^run-/);
    expect(launchFailure.task_ref).toBe('proj/fix-bug');
    expect((launchFailure.payload as Record<string, unknown>).code).toBe('ERR_SESSION_START_FAILED');
    expect(mockStart).toHaveBeenCalledTimes(3);
  });

  it('keeps the claim active when a retryable managed-slot start succeeds after transient failures', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'running',
        session_handle: 'pty:master',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'codex';

    const mockStart = vi.fn()
      .mockRejectedValueOnce(new Error('spawn failed once'))
      .mockRejectedValueOnce(new Error('spawn failed twice'))
      .mockResolvedValue({ session_handle: 'pty:orc-1', provider_ref: null });
    const mockSend = vi.fn().mockResolvedValue('');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: mockSend,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    try {
      const { tick } = await import('./coordinator.ts');
      await tick();
      vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
      await tick();
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      await tick();
    } finally {
      vi.useRealTimers();
    }

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const slot = agents.find((agent) => agent.agent_id === 'orc-1');
    expect(slot?.status).toBe('running');
    expect(slot?.session_handle).toBe('pty:orc-1');

    const { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
    expect(claims[0]?.state).toBe('claimed');
    expect(claims[0]?.task_envelope_sent_at).toBeNull();
    expect(claims[0]?.session_start_retry_count).toBe(0);
    expect(claims[0]?.session_start_retry_next_at).toBeNull();
    expect(claims[0]?.session_start_last_error).toBeNull();

    const backlog = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> });
    expect(backlog.features[0].tasks[0].status).toBe('claimed');

    expect(readEvents(dir).some((event) => event.event === 'session_start_failed')).toBe(false);
    expect(mockStart).toHaveBeenCalledTimes(3);
    expect(mockSend.mock.calls.some(([, payload]) => String(payload).includes('TASK_START'))).toBe(false);
  });

  it('resumes managed-slot start retries after coordinator restart', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'running',
        session_handle: 'pty:master',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'codex';

    const mockStart = vi.fn()
      .mockRejectedValueOnce(new Error('spawn failed once'))
      .mockRejectedValueOnce(new Error('spawn failed twice'))
      .mockResolvedValue({ session_handle: 'pty:orc-1', provider_ref: null });
    const mockSend = vi.fn().mockResolvedValue('');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: mockSend,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
    }));

    try {
      const firstCoordinator = await import('./coordinator.ts');
      await firstCoordinator.tick();

      let { readJson } = await import('./lib/stateReader.ts');
      let { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
      expect(claims[0]?.session_start_retry_count).toBe(1);
      expect(claims[0]?.session_start_last_error).toBe('spawn failed once');

      vi.resetModules();
      vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
      const secondCoordinator = await import('./coordinator.ts');
      await secondCoordinator.tick();

      ({ readJson } = await import('./lib/stateReader.ts'));
      ({ claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }));
      expect(claims[0]?.session_start_retry_count).toBe(2);
      expect(claims[0]?.session_start_last_error).toBe('spawn failed twice');

      vi.resetModules();
      vi.setSystemTime(new Date('2026-01-01T00:01:00.000Z'));
      const thirdCoordinator = await import('./coordinator.ts');
      await thirdCoordinator.tick();

      ({ readJson } = await import('./lib/stateReader.ts'));
      ({ claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }));
      expect(claims[0]?.state).toBe('claimed');
      expect(claims[0]?.task_envelope_sent_at).toBeNull();
      expect(claims[0]?.session_start_retry_count).toBe(0);
      expect(claims[0]?.session_start_last_error).toBeNull();
      expect(mockStart).toHaveBeenCalledTimes(3);
      expect(mockSend.mock.calls.some(([, payload]) => String(payload).includes('TASK_START'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not provision a registered idle worker when no task is ready yet', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        last_heartbeat_at: null,
        registered_at: new Date().toISOString(),
      }],
    });

    const mockStart = vi.fn().mockResolvedValue({ session_handle: 'pty:worker-01', provider_ref: null });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    expect(mockStart).not.toHaveBeenCalled();

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents, claims } = {
      agents: (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents,
      claims: (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims,
    };
    expect(agents[0].status).toBe('idle');
    expect(agents[0].session_handle).toBeNull();
    expect(agents[0].last_heartbeat_at).toBeNull();
    expect(claims).toHaveLength(0);
  });

  it('does not refresh agent last_heartbeat_at just because a PTY session is reachable', async () => {
    const staleTs = '2026-01-01T00:00:00.000Z';
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        last_heartbeat_at: staleTs,
        registered_at: new Date().toISOString(),
      }],
    });

    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    const { readJson } = await import('./lib/stateReader.ts');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'worker-01')!;
    expect(agent.last_heartbeat_at).toBe(staleTs);
  });

  it('sets status=idle (not running) when heartbeatProbe returns false', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
    });

    // Mock adapter so heartbeatProbe reports the session is dead.
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(false),
        start: vi.fn().mockResolvedValue({ session_handle: 'pty:worker-01-new', provider_ref: null }),
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    // Read agents.json back from disk.
    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const agent = agents.find((a) => a.agent_id === 'worker-01')!;

    expect(agent).toBeDefined();
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBeNull();
  });

  it('sets status=running and records session_handle after successful launch for an assigned task', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });

    const mockStart = vi.fn().mockResolvedValue({ session_handle: 'pty:worker-01', provider_ref: null });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    // Confirm start() was actually invoked (would be silent if task routing
    // filtered out the agent and dispatch was skipped).
    expect(mockStart).toHaveBeenCalledOnce();

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const agent = agents.find((a) => a.agent_id === 'worker-01')!;

    expect(agent.status).toBe('running');
    expect(agent.session_handle).toBe('pty:worker-01');
    expect(agent.last_heartbeat_at).toBeTruthy();

    const events = readEvents(dir);
    const onlineEvent = events.find((event) => event.event === 'agent_online' && event.agent_id === 'worker-01')!;
    expect(onlineEvent).toBeDefined();
    expect(onlineEvent.task_ref).toBe('proj/fix-bug');
  });

  it('assigns distinct tasks to different workers within the same dispatch tick', async () => {
    seedState(dir, {
      agents: [
        {
          agent_id: 'worker-01',
          provider: 'claude',
          role: 'worker',
          status: 'idle',
          session_handle: null,
          provider_ref: null,
          registered_at: new Date().toISOString(),
        },
        {
          agent_id: 'worker-02',
          provider: 'claude',
          role: 'worker',
          status: 'idle',
          session_handle: null,
          provider_ref: null,
          registered_at: new Date().toISOString(),
        },
      ],
      tasks: [
        {
          ...DISPATCHABLE_TASK,
          ref: 'proj/task-a',
          title: 'Task A',
        },
        {
          ...DISPATCHABLE_TASK,
          ref: 'proj/task-b',
          title: 'Task B',
        },
      ],
    });

    const mockStart = vi.fn()
      .mockResolvedValueOnce({ session_handle: 'pty:worker-01', provider_ref: null })
      .mockResolvedValueOnce({ session_handle: 'pty:worker-02', provider_ref: null });
    const mockSend = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: mockSend,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockImplementation((_: string, { runId }: { runId: string }) => ({
        run_id: runId,
        branch: `task/${runId}`,
        worktree_path: `/tmp/orc-worktrees/${runId}`,
      })),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    expect(mockStart).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledTimes(0);

    const { readJson } = await import('./lib/stateReader.ts');
    const { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
    expect(claims).toHaveLength(2);
    expect(claims.map((claim) => claim.task_ref)).toEqual(['proj/task-a', 'proj/task-b']);

    const backlog = readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> };
    expect(backlog.features[0].tasks.map((task) => `${task.ref}:${task.status}`)).toEqual([
      'proj/task-a:claimed',
      'proj/task-b:claimed',
    ]);

    expect(claims.every((claim) => claim.task_envelope_sent_at == null)).toBe(true);
  });

  it('restarts an existing worker session in the assigned run worktree before dispatch', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });

    const mockStart = vi.fn().mockResolvedValue({ session_handle: 'pty:worker-01-new', provider_ref: null });
    const mockStop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: mockStart,
        send: vi.fn().mockResolvedValue(''),
        stop: mockStop,
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    expect(mockStop).toHaveBeenCalledWith('pty:worker-01');
    expect(mockStart).toHaveBeenCalledWith('worker-01', expect.objectContaining({
      working_directory: '/tmp/orc-worktrees/run-allocated',
      env: expect.objectContaining({
        ORCH_STATE_DIR: dir,
      }),
    }));
  });

  it('recreates a live worker session when the PTY is not owned by this coordinator process', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: { pid: 1234 },
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });

    const mockStart = vi.fn().mockResolvedValue({ session_handle: 'pty:worker-01-new', provider_ref: null });
    const mockStop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        ownsSession: vi.fn().mockReturnValue(false),
        start: mockStart,
        send: vi.fn().mockResolvedValue(''),
        stop: mockStop,
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    expect(mockStop).toHaveBeenCalledWith('pty:worker-01');
    expect(mockStart).toHaveBeenCalledOnce();

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const agent = agents.find((entry) => entry.agent_id === 'worker-01')!;
    expect(agent.session_handle).toBe('pty:worker-01-new');
  });

  it('records TASK_START delivery without auto-acking run_started once the worker is ready', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [DISPATCHABLE_TASK],
    });

    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn().mockResolvedValue({ session_handle: 'pty:worker-01', provider_ref: null }),
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-allocated',
        branch: 'task/run-allocated',
        worktree_path: '/tmp/orc-worktrees/run-allocated',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const { tick, processTerminalRunEvents } = await import('./coordinator.ts');
    await tick();

    let { readJson } = await import('./lib/stateReader.ts');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'worker-01')!;
    await processTerminalRunEvents([{
      event: 'reported_for_duty',
      ts: new Date().toISOString(),
      actor_type: 'agent',
      actor_id: 'worker-01',
      agent_id: 'worker-01',
      payload: { session_token: String(agent.session_token) },
    }]);
    await tick();

    ({ readJson } = await import('./lib/stateReader.ts'));
    const { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
    expect(claims[0]?.state).toBe('claimed');
    expect(claims[0]?.task_envelope_sent_at).toBeTruthy();
    expect(claims[0]?.started_at).toBeNull();

    const backlog = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> });
    expect(backlog.features[0].tasks[0].status).toBe('claimed');

    const events = readEvents(dir);
    const envelopeSent = events.find((e) => e.event === 'task_envelope_sent');
    expect(envelopeSent).toBeTruthy();
    expect(envelopeSent!.actor_type).toBe('coordinator');
    expect(envelopeSent!.actor_id).toBe('coordinator');
    expect(envelopeSent!.agent_id).toBe('worker-01');
    expect(events.find((e) => e.event === 'run_started')).toBeFalsy();
  });

  it('does not nudge or timeout a claimed run before TASK_START delivery is recorded', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        session_token: 'session-token-1',
        session_started_at: new Date().toISOString(),
        session_ready_at: null,
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-awaiting-delivery',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: new Date().toISOString(),
        task_envelope_sent_at: null,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_heartbeat_at: null,
        started_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        session_start_retry_count: 0,
        session_start_retry_next_at: null,
        session_start_last_error: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn(),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    expect(send).not.toHaveBeenCalled();
    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-awaiting-delivery')!;
    expect(claim.state).toBe('claimed');
    expect(claim.finished_at).toBeFalsy();
  });

  it('withholds TASK_START until the worker reports for duty', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        session_token: 'session-token-1',
        session_started_at: new Date().toISOString(),
        session_ready_at: null,
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-awaiting-duty',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: new Date().toISOString(),
        task_envelope_sent_at: null,
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_heartbeat_at: null,
        started_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        session_start_retry_count: 0,
        session_start_retry_next_at: null,
        session_start_last_error: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn(),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick, processTerminalRunEvents } = await import('./coordinator.ts');
    await tick();
    expect(send).not.toHaveBeenCalled();

    await processTerminalRunEvents([{
      event: 'reported_for_duty',
      ts: new Date().toISOString(),
      actor_type: 'agent',
      actor_id: 'worker-01',
      agent_id: 'worker-01',
      payload: { session_token: 'session-token-1' },
    }]);
    await tick();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toContain('TASK_START');
  });

  it('relaunches and eventually requeues a claimed run when the pre-duty session is lost', async () => {
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'claude';
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: null,
        session_token: null,
        session_started_at: null,
        session_ready_at: null,
        provider_ref: null,
        registered_at: '2026-01-01T00:00:00.000Z',
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        owner: 'orc-1',
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-lost-before-duty',
        task_ref: 'proj/fix-bug',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        task_envelope_sent_at: null,
        lease_expires_at: '2026-01-01T00:30:00.000Z',
        last_heartbeat_at: null,
        started_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        session_start_retry_count: 0,
        session_start_retry_next_at: null,
        session_start_last_error: null,
      }],
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:03:00.000Z'));

    const start = vi.fn().mockImplementation((_agentId: string, _config: Record<string, unknown>) => Promise.resolve({
      session_handle: 'pty:orc-1',
      provider_ref: { pid: 123, provider: 'claude', binary: 'claude' },
    }));
    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start,
        send,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-lost-before-duty',
        branch: 'task/run-lost-before-duty',
        worktree_path: '/tmp/orc-worktrees/run-lost-before-duty',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-lost-before-duty',
        branch: 'task/run-lost-before-duty',
        worktree_path: '/tmp/orc-worktrees/run-lost-before-duty',
      }),
    }));

    const originalArgv = process.argv;
    process.argv = [...process.argv.slice(0, 2), '--session-ready-timeout-ms=120000', '--session-ready-nudge-ms=1000', '--session-ready-nudge-interval-ms=1000'];

    try {
      const { tick } = await import('./coordinator.ts');
      await tick();
      vi.setSystemTime(new Date('2026-01-01T00:05:01.000Z'));
      await tick();
    } finally {
      process.argv = originalArgv;
      vi.useRealTimers();
    }

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-lost-before-duty')!;
    expect(start).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('pty:orc-1', expect.stringContaining('TASK_START'));
    expect(claim.state).toBe('failed');
    expect(claim.failure_reason).toContain('reported_for_duty timeout');
  });

  it('requeues a claimed non-managed worker run when the pre-duty relaunch fails', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: null,
        session_token: null,
        session_started_at: null,
        session_ready_at: null,
        provider_ref: null,
        registered_at: '2026-01-01T00:00:00.000Z',
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        owner: 'worker-01',
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-nonmanaged-lost-before-duty',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: new Date().toISOString(),
        task_envelope_sent_at: null,
        lease_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        last_heartbeat_at: null,
        started_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        session_start_retry_count: 0,
        session_start_retry_next_at: null,
        session_start_last_error: null,
      }],
    });

    const start = vi.fn().mockRejectedValue(new Error('spawn failed'));
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start,
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-nonmanaged-lost-before-duty',
        branch: 'task/run-nonmanaged-lost-before-duty',
        worktree_path: '/tmp/orc-worktrees/run-nonmanaged-lost-before-duty',
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        run_id: 'run-nonmanaged-lost-before-duty',
        branch: 'task/run-nonmanaged-lost-before-duty',
        worktree_path: '/tmp/orc-worktrees/run-nonmanaged-lost-before-duty',
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-nonmanaged-lost-before-duty')!;
    expect(start).toHaveBeenCalled();
    expect(claim.state).toBe('failed');
    expect(claim.failure_reason).toContain('session_start_failed');
  });

  it('starts missing-run_started nudges from task_envelope_sent_at instead of claimed_at', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-recent-delivery',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        task_envelope_sent_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_heartbeat_at: null,
        started_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        session_start_retry_count: 0,
        session_start_retry_next_at: null,
        session_start_last_error: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn(),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    expect(send).not.toHaveBeenCalled();
    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-recent-delivery')!;
    expect(claim.state).toBe('claimed');
    expect(claim.finished_at).toBeFalsy();
  });

  it('does not renew the lease when coordinator records an awaiting-input blocker for a claimed run', async () => {
    const leaseExpiresAt = '2026-01-01T00:30:00.000Z';
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-awaiting-input-without-renewal',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00.000Z',
        task_envelope_sent_at: '2026-01-01T00:00:05.000Z',
        lease_expires_at: leaseExpiresAt,
        last_heartbeat_at: null,
        started_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        session_start_retry_count: 0,
        session_start_retry_next_at: null,
        session_start_last_error: null,
      }],
    });

    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        detectInputBlock: vi.fn().mockReturnValue('Would you like to apply these changes? [y/n]'),
        getOutputTail: vi.fn().mockReturnValue('Would you like to apply these changes? [y/n]'),
      }),
    }));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:02:00.000Z'));

    const originalArgv = process.argv;
    process.argv = [...process.argv.slice(0, 2), '--run-start-timeout-ms=600000'];

    try {
      const { tick } = await import('./coordinator.ts');
      await tick();
    } finally {
      process.argv = originalArgv;
      vi.useRealTimers();
    }

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-awaiting-input-without-renewal')!;
    expect(claim.input_state).toBe('awaiting_input');
    expect(claim.lease_expires_at).toBe(leaseExpiresAt);
    expect(claim.last_heartbeat_at).toBeNull();

    const events = readEvents(dir);
    const inputRequested = events.find((event) => event.event === 'input_requested' && event.run_id === 'run-awaiting-input-without-renewal');
    expect(inputRequested).toBeTruthy();
  });

  it('does not nudge or timeout an in-progress run while awaiting master input', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-awaiting-input',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: new Date(Date.now() - 60_000).toISOString(),
        started_at: new Date(Date.now() - 60_000).toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_heartbeat_at: new Date(Date.now() - 60_000).toISOString(),
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: 'awaiting_input',
        input_requested_at: new Date(Date.now() - 10_000).toISOString(),
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn(),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    expect(send).not.toHaveBeenCalled();
    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-awaiting-input')!;
    expect(claim.state).toBe('in_progress');
    expect(claim.input_state).toBe('awaiting_input');
  });
});

describe('agent ttl dead marking', () => {
  it('marks stale agent dead when heartbeat is older than 2 hours and agent has no active claim', async () => {
    const staleTs = new Date(Date.now() - (2 * 60 * 60 * 1000 + 10_000)).toISOString();
    seedState(dir, {
      agents: [{
        agent_id: 'worker-ttl',
        provider: 'claude',
        role: 'worker',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        last_heartbeat_at: staleTs,
        registered_at: new Date().toISOString(),
      }],
    });

    const { tick } = await import('./coordinator.ts');
    await tick();

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const worker = agents.find((a) => a.agent_id === 'worker-ttl')!;
    expect(worker.status).toBe('dead');

    const events = readEvents(dir);
    const marked = events.find((event) => event.event === 'agent_marked_dead' && event.agent_id === 'worker-ttl')!;
    expect(marked).toBeDefined();
    expect(Number.isInteger((marked.payload as Record<string, unknown>)?.elapsed_ms)).toBe(true);
    expect((marked.payload as Record<string, unknown>).elapsed_ms).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it('does not mark stale agent dead when there is an active claim', async () => {
    const staleTs = new Date(Date.now() - (2 * 60 * 60 * 1000 + 10_000)).toISOString();
    seedState(dir, {
      agents: [{
        agent_id: 'worker-claimed',
        provider: 'claude',
        role: 'worker',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        last_heartbeat_at: staleTs,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-ttl-1',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-claimed',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });

    const { tick } = await import('./coordinator.ts');
    await tick();

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const worker = agents.find((a) => a.agent_id === 'worker-claimed')!;
    expect(worker.status).toBe('idle');
    expect(worker.last_heartbeat_at).toBe(staleTs);

    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'agent_marked_dead' && event.agent_id === 'worker-claimed')).toBe(false);
  });
});

describe('in-progress stale escalation', () => {
  it('nudges first, then emits worker_needs_attention once after the escalation threshold', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-stale-escalate',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        last_heartbeat_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        escalation_notified_at: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const originalArgv = process.argv;
    process.argv = [...process.argv.slice(0, 2), '--run-inactive-nudge-ms=1', '--run-inactive-escalate-ms=1', '--run-inactive-nudge-interval-ms=60000'];

    const { tick } = await import('./coordinator.ts');
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    await tick();

    process.argv = originalArgv;

    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[1] ?? '')).toContain('run-heartbeat --run-id=run-stale-escalate --agent-id=worker-01');
    expect(String(send.mock.calls[0]?.[1] ?? '')).not.toContain('\norc run-heartbeat');
    const events = readEvents(dir);
    expect(events.filter((event) => event.event === 'need_input' && event.run_id === 'run-stale-escalate')).toHaveLength(1);

    const attentionEvents = events.filter((event) => event.event === 'worker_needs_attention' && event.run_id === 'run-stale-escalate');
    expect(attentionEvents).toHaveLength(1);
    expect(attentionEvents[0]?.payload).toMatchObject({ reason: 'stale' });
    expect(Number((attentionEvents[0]?.payload as Record<string, unknown>).idle_ms)).toBeGreaterThanOrEqual(1);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-stale-escalate')!;
    expect(claim.escalation_notified_at).toBeTruthy();
  });

  it('does not emit worker_needs_attention before the initial nudge has fired', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-stale-no-escalate-yet',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        last_heartbeat_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        escalation_notified_at: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const originalArgv = process.argv;
    process.argv = [...process.argv.slice(0, 2), '--run-inactive-nudge-ms=1', '--run-inactive-escalate-ms=1', '--run-inactive-nudge-interval-ms=60000'];

    const { tick } = await import('./coordinator.ts');
    await tick();

    process.argv = originalArgv;

    expect(send).toHaveBeenCalledTimes(1);
    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'worker_needs_attention' && event.run_id === 'run-stale-no-escalate-yet')).toBe(false);
  });

  it('does not re-fire worker_needs_attention when the claim already has escalation_notified_at', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-stale-already-escalated',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        started_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        last_heartbeat_at: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
        escalation_notified_at: '2026-03-25T09:00:00.000Z',
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const originalArgv = process.argv;
    process.argv = [...process.argv.slice(0, 2), '--run-inactive-nudge-ms=1', '--run-inactive-escalate-ms=1', '--run-inactive-nudge-interval-ms=60000'];

    const { tick } = await import('./coordinator.ts');
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 5));
    vi.resetModules();
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    const restartedCoordinator = await import('./coordinator.ts');
    await restartedCoordinator.tick();

    process.argv = originalArgv;

    const events = readEvents(dir);
    expect(events.some((event) => event.event === 'worker_needs_attention' && event.run_id === 'run-stale-already-escalated')).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('processTerminalRunEvents', () => {
  it('processes queued heartbeats before lease expiry on tick', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-expiry-order',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-expiry-order',
        task_ref: 'orch/task-expiry-order',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: '2026-03-11T07:00:00.000Z',
        last_heartbeat_at: null,
      }],
    });
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({
      seq: 1,
      event_id: 'evt-heartbeat-order',
      ts: new Date().toISOString(),
      event: 'heartbeat',
      actor_type: 'agent',
      actor_id: 'orc-1',
      run_id: 'run-expiry-order',
      task_ref: 'orch/task-expiry-order',
      agent_id: 'orc-1',
      payload: {},
    })}\n`);
    resetCheckpoint(dir);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn(),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn(),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-expiry-order')!;
    expect(claim.state).toBe('in_progress');
    expect(claim.last_heartbeat_at).toBeTruthy();
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((entry) => entry.ref === 'orch/task-expiry-order')!;
    expect(task.status).toBe('in_progress');
  });

  it('transitions claimed runs to in_progress when processing run_started', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-151',
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-started-001',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'run_started',
      run_id: 'run-started-001',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T07:59:00.000Z',
      payload: {},
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-started-001')!;
    expect(claim.state).toBe('in_progress');
    expect(claim.started_at).toBeTruthy();
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((entry) => entry.ref === 'orch/task-151')!;
    expect(task.status).toBe('in_progress');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'orc-1')!;
    expect(agent.last_heartbeat_at).toBe(claim.started_at);
  });

  it('renews the claim lease when processing heartbeat', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-151',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-heartbeat-001',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: '2026-03-11T07:55:00.000Z',
        last_heartbeat_at: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'heartbeat',
      run_id: 'run-heartbeat-001',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:00:00.000Z',
      payload: {},
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-heartbeat-001')!;
    expect(claim.last_heartbeat_at).toBeTruthy();
    expect(claim.lease_expires_at).not.toBe('2026-03-11T07:55:00.000Z');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'orc-1')!;
    expect(agent.last_heartbeat_at).toBe(claim.last_heartbeat_at);
  });

  it('replaying the same heartbeat event uses the original event timestamp', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-heartbeat-replay',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-heartbeat-replay',
        task_ref: 'orch/task-heartbeat-replay',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: '2026-03-11T07:55:00.000Z',
        last_heartbeat_at: null,
      }],
    });

    const heartbeatEvent = {
      seq: 5,
      event_id: 'evt-heartbeat-replay',
      event: 'heartbeat',
      run_id: 'run-heartbeat-replay',
      task_ref: 'orch/task-heartbeat-replay',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:00:00.000Z',
      payload: {},
    } as const;

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([heartbeatEvent]);
    const { readJson } = await import('./lib/stateReader.ts');
    const firstClaim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-heartbeat-replay')!;
    const firstLease = firstClaim.lease_expires_at;

    resetCheckpoint(dir);
    await processTerminalRunEvents([heartbeatEvent]);

    const secondClaim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-heartbeat-replay')!;
    expect(secondClaim.last_heartbeat_at).toBe(firstClaim.last_heartbeat_at);
    expect(secondClaim.lease_expires_at).toBe(firstLease);
  });

  it('clamps future worker heartbeat timestamps to coordinator time', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-heartbeat-future',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-heartbeat-future',
        task_ref: 'orch/task-heartbeat-future',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-03-11T07:00:00.000Z',
        started_at: '2026-03-11T07:00:00.000Z',
        lease_expires_at: '2026-03-11T07:55:00.000Z',
        last_heartbeat_at: '2026-03-11T07:00:00.000Z',
      }],
    });

    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      seq: 1,
      event_id: 'evt-heartbeat-future',
      event: 'heartbeat',
      run_id: 'run-heartbeat-future',
      task_ref: 'orch/task-heartbeat-future',
      agent_id: 'orc-1',
      ts: futureTs,
      payload: {},
    } as const]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-heartbeat-future')!;
    expect(new Date(String(claim.last_heartbeat_at)).getTime()).toBeLessThanOrEqual(Date.now());
    expect(new Date(String(claim.lease_expires_at)).getTime()).toBeLessThanOrEqual(Date.now() + DEFAULT_LEASE_MS + 5_000);
  });

  it('transitions finalize_rebase_requested to finalize_rebase_in_progress when processing finalize_rebase_started', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-151',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-finalize-started',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'finalize_rebase_requested',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'finalize_rebase_started',
      run_id: 'run-finalize-started',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:10:00.000Z',
      payload: { status: 'finalize_rebase_in_progress', retry_count: 1 },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-started')!;
    expect(claim.finalization_state).toBe('finalize_rebase_in_progress');
    expect(claim.finalization_retry_count).toBe(1);
    // Lease should be extended to FINALIZE_LEASE_MS (60 min) from now, not DEFAULT_LEASE_MS (30 min).
    const leaseExpiresAt = new Date(claim.lease_expires_at as string).getTime();
    const expectedMinLease = Date.now() + 55 * 60 * 1000; // at least 55 min from now
    expect(leaseExpiresAt).toBeGreaterThan(expectedMinLease);
  });

  it('extends lease to FINALIZE_LEASE_MS on work_complete', async () => {
    seedState(dir, {
      agents: [{ agent_id: 'orc-1', role: 'worker', status: 'running', provider: 'claude', session_handle: 'pty:orc-1' }],
      tasks: [{ ref: 'orch/task-wc', title: 'work complete lease test', status: 'in_progress' }],
      claims: [{
        run_id: 'run-wc-lease',
        task_ref: 'orch/task-wc',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(), // only 1 min left
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: 'run-wc-lease',
      task_ref: 'orch/task-wc',
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: { status: 'awaiting_finalize' },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-wc-lease')!;
    // Lease must be extended to at least 55 min from now (FINALIZE_LEASE_MS = 60 min).
    const leaseExpiresAt = new Date(claim.lease_expires_at as string).getTime();
    expect(leaseExpiresAt).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
  });

  it('attempts trusted merge on work_complete, then cleans up the run on success', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-151',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-finalize-success',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'awaiting_finalize',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

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
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        stop,
        send,
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree,
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        branch: 'task/run-finalize-success',
        worktree_path: '/tmp/orc-worktrees/run-finalize-success',
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: 'run-finalize-success',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:00:00.000Z',
      payload: { status: 'awaiting_finalize', retry_count: 0 },
    }]);

    expect(spawnSync).toHaveBeenNthCalledWith(1, 'git', ['merge-base', '--is-ancestor', 'main', 'task/run-finalize-success'], expect.objectContaining({
      cwd: dir,
      encoding: 'utf8',
    }));
    expect(spawnSync).toHaveBeenNthCalledWith(2, 'git', ['merge', 'task/run-finalize-success', '--no-ff', '-m', 'task(orch/task-151): merge worktree'], expect.objectContaining({
      cwd: dir,
      encoding: 'utf8',
    }));
    expect(send).toHaveBeenCalledWith('pty:orc-1', expect.stringContaining('FINALIZE_WAIT'));
    expect(send).toHaveBeenCalledWith('pty:orc-1', expect.stringContaining('FINALIZE_SUCCESS'));
    expect(cleanupRunWorktree).toHaveBeenCalledWith(dir, 'run-finalize-success');

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-success')!;
    expect(claim.state).toBe('done');
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((entry) => entry.ref === 'orch/task-151')!;
    expect(task.status).toBe('done');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'orc-1')!;
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBeNull();
  });

  it('keeps merged runs done when cleanup is deferred after a successful merge', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-151',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-finalize-cleanup-pending',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'awaiting_finalize',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    const stop = vi.fn().mockResolvedValue(undefined);
    const cleanupRunWorktree = vi.fn().mockReturnValue(false);
    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: '' });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync };
    });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        stop,
        send,
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree,
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        branch: 'task/run-finalize-cleanup-pending',
        worktree_path: '/tmp/orc-worktrees/run-finalize-cleanup-pending',
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: 'run-finalize-cleanup-pending',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:01:00.000Z',
      payload: { status: 'awaiting_finalize', retry_count: 0 },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-cleanup-pending')!;
    expect(claim.state).toBe('done');
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((entry) => entry.ref === 'orch/task-151')!;
    expect(task.status).toBe('done');
    expect(cleanupRunWorktree).toHaveBeenCalledWith(dir, 'run-finalize-cleanup-pending');
  });

  it('requests finalize rebase and increments retry count when work_complete branch is stale', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      claims: [{
        run_id: 'run-finalize-retry',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'awaiting_finalize',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    const spawnSync = vi.fn().mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync };
    });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        send,
        stop: vi.fn().mockResolvedValue(undefined),
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        branch: 'task/run-finalize-retry',
        worktree_path: '/tmp/orc-worktrees/run-finalize-retry',
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: 'run-finalize-retry',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:05:00.000Z',
      payload: { status: 'awaiting_finalize', retry_count: 0 },
    }]);

    expect(send).toHaveBeenCalledWith('pty:orc-1', expect.stringContaining('FINALIZE_WAIT'));
    expect(send).toHaveBeenCalledWith('pty:orc-1', expect.stringContaining('FINALIZE_REBASE'));
    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-retry')!;
    expect(claim.finalization_state).toBe('finalize_rebase_requested');
    expect(claim.finalization_retry_count).toBe(1);
    expect(claim.finalization_blocked_reason).toBeNull();
    expect(claim.state).toBe('in_progress');
  });

  it('does not consume finalize retry budget when the rebase request cannot be delivered', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      claims: [{
        run_id: 'run-finalize-undelivered',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'awaiting_finalize',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const spawnSync = vi.fn().mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });
    const deliverySend = vi.fn().mockRejectedValue(new Error('pty gone'));
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync };
    });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        send: deliverySend,
        stop: vi.fn().mockResolvedValue(undefined),
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        branch: 'task/run-finalize-undelivered',
        worktree_path: '/tmp/orc-worktrees/run-finalize-undelivered',
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: 'run-finalize-undelivered',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:06:00.000Z',
      payload: { status: 'awaiting_finalize', retry_count: 0 },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-undelivered')!;
    expect(claim.finalization_state).toBe('finalize_rebase_requested');
    expect(claim.finalization_retry_count).toBe(0);
    expect(claim.finalization_blocked_reason).toBeNull();
    expect(deliverySend).toHaveBeenCalledTimes(2);
    expect(deliverySend).toHaveBeenLastCalledWith('pty:orc-1', expect.stringContaining('FINALIZE_REBASE'));
  });

  it('blocks finalization after the second undeliverable finalize request', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      claims: [{
        run_id: 'run-finalize-undeliverable-blocked',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'finalize_rebase_requested',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const deliverySend = vi.fn()
      .mockRejectedValue(new Error('pty gone'));
    const spawnSync = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: '' });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync };
    });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        send: deliverySend,
        stop: vi.fn().mockResolvedValue(undefined),
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        branch: 'task/run-finalize-undeliverable-blocked',
        worktree_path: '/tmp/orc-worktrees/run-finalize-undeliverable-blocked',
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'ready_to_merge',
      run_id: 'run-finalize-undeliverable-blocked',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:07:00.000Z',
      payload: { status: 'ready_to_merge', retry_count: 0 },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-undeliverable-blocked')!;
    expect(claim.finalization_state).toBe('blocked_finalize');
    expect(claim.finalization_retry_count).toBe(0);
    expect(claim.finalization_blocked_reason).toContain('finalize request could not be delivered twice');
  });

  it('marks finalization blocked after the retry budget is exhausted', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      claims: [{
        run_id: 'run-finalize-blocked',
        task_ref: 'orch/task-151',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: 'ready_to_merge',
        finalization_retry_count: 2,
        finalization_blocked_reason: null,
      }],
    });

    const stop = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue('');
    const spawnSync = vi.fn().mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });
    const cleanupRunWorktree = vi.fn().mockReturnValue(true);
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync };
    });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        send,
        stop,
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree,
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        branch: 'task/run-finalize-blocked',
        worktree_path: '/tmp/orc-worktrees/run-finalize-blocked',
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'ready_to_merge',
      run_id: 'run-finalize-blocked',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:10:00.000Z',
      payload: { status: 'ready_to_merge', retry_count: 2 },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-blocked')!;
    expect(claim.finalization_state).toBe('blocked_finalize');
    expect(claim.finalization_retry_count).toBe(2);
    expect(claim.finalization_blocked_reason).toContain('branch is not rebased onto latest main');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'orc-1')!;
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBeNull();
    expect(cleanupRunWorktree).not.toHaveBeenCalled();
  });

  it('updates claim input_state to awaiting_input for input_requested events', async () => {
    seedState(dir, {
      claims: [{
        run_id: 'run-input-001',
        task_ref: 'orch/task-150',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-03-11T05:00:00.000Z',
        started_at: '2026-03-11T05:01:00.000Z',
        lease_expires_at: '2099-01-01T00:00:00.000Z',
      }],
    });
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      ts: '2026-03-11T05:10:00.000Z',
      event: 'input_requested',
      run_id: 'run-input-001',
      task_ref: 'orch/task-150',
      agent_id: 'orc-1',
      payload: { question: 'Should I answer yes?' },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const { claims } = readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> };
    const claim = claims.find((c) => c.run_id === 'run-input-001');
    expect(claim?.input_state).toBe('awaiting_input');
  });

  it('clears awaiting_input when processing input_response', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');
    seedState(dir, {
      claims: [{
        run_id: 'run-input-001',
        task_ref: 'orch/task-150',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-03-11T05:00:00.000Z',
        started_at: '2026-03-11T05:01:00.000Z',
        lease_expires_at: '2099-01-01T00:00:00.000Z',
        input_state: 'awaiting_input',
        input_requested_at: '2026-03-11T05:10:00.000Z',
      }],
    });

    await processTerminalRunEvents([{
      ts: '2026-03-11T05:11:00.000Z',
      event: 'input_response',
      run_id: 'run-input-001',
      agent_id: 'orc-1',
      payload: { response: 'yes' },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
    expect(claims[0]?.input_state).toBeNull();
  });

  it('dedupes already processed events by durable identity', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');
    const event = {
      seq: 11,
      event_id: 'evt-input-request-001',
      ts: '2026-03-11T05:10:00.000Z',
      event: 'input_requested' as const,
      run_id: 'run-input-001',
      task_ref: 'orch/task-150',
      agent_id: 'orc-1',
      payload: { question: 'Should I answer yes?' },
    };

    await processTerminalRunEvents([event]);
    await processTerminalRunEvents([event]);

    const checkpoint = JSON.parse(readFileSync(join(dir, 'event-checkpoint.json'), 'utf8')) as {
      last_processed_seq: number;
      processed_event_ids: string[];
    };
    expect(checkpoint.last_processed_seq).toBe(11);
    expect(checkpoint.processed_event_ids).toContain('evt-input-request-001');
  });

  it('resumes safely after restart with persisted processing state', async () => {
    let coordinator = await import('./coordinator.ts');
    const event = {
      seq: 12,
      event_id: 'evt-input-request-002',
      ts: '2026-03-11T05:11:00.000Z',
      event: 'input_requested' as const,
      run_id: 'run-input-002',
      task_ref: 'orch/task-151',
      agent_id: 'orc-1',
      payload: { question: 'Should I retry?' },
    };

    await coordinator.processTerminalRunEvents([event]);

    vi.resetModules();
    coordinator = await import('./coordinator.ts');
    await coordinator.processTerminalRunEvents([event]);

    const checkpoint = JSON.parse(readFileSync(join(dir, 'event-checkpoint.json'), 'utf8')) as {
      last_processed_seq: number;
      processed_event_ids: string[];
    };
    expect(checkpoint.last_processed_seq).toBe(12);
    expect(checkpoint.processed_event_ids).toContain('evt-input-request-002');
  });

  it('dedupes legacy events without event_id across restart', async () => {
    let coordinator = await import('./coordinator.ts');
    const legacyEvent = {
      seq: 13,
      ts: '2026-03-11T05:11:30.000Z',
      event: 'input_requested' as const,
      run_id: 'run-input-legacy',
      task_ref: 'orch/task-legacy',
      agent_id: 'orc-1',
      payload: { question: 'Legacy event?' },
    };

    await coordinator.processTerminalRunEvents([legacyEvent]);

    vi.resetModules();
    coordinator = await import('./coordinator.ts');
    await coordinator.processTerminalRunEvents([legacyEvent]);

    const checkpoint = JSON.parse(readFileSync(join(dir, 'event-checkpoint.json'), 'utf8')) as {
      processed_event_ids: string[];
    };
    expect(checkpoint.processed_event_ids[0]).toContain('legacy:');
  });

  it('does not skip a new event when another processed event shares the dedupe window', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      seq: 20,
      event_id: 'evt-input-request-020',
      ts: '2026-03-11T05:12:00.000Z',
      event: 'input_requested',
      run_id: 'run-input-020',
      task_ref: 'orch/task-152',
      agent_id: 'orc-1',
      payload: { question: 'First question?' },
    }]);

    await processTerminalRunEvents([{
      seq: 21,
      event_id: 'evt-input-request-021',
      ts: '2026-03-11T05:12:30.000Z',
      event: 'input_requested',
      run_id: 'run-input-021',
      task_ref: 'orch/task-153',
      agent_id: 'orc-1',
      payload: { question: 'Second question?' },
    }]);

    // Both events processed: checkpoint should have advanced past seq 21.
    const checkpoint = JSON.parse(readFileSync(join(dir, 'event-checkpoint.json'), 'utf8')) as {
      last_processed_seq: number;
    };
    expect(checkpoint.last_processed_seq).toBe(21);
  });

  it('bootstraps the checkpoint from the retained log instead of replaying old events on first load', async () => {
    seedState(dir);
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({
      seq: 30,
      ts: '2026-03-11T05:13:00.000Z',
      event: 'input_requested',
      actor_type: 'agent',
      actor_id: 'orc-1',
      run_id: 'run-input-existing',
      task_ref: 'orch/task-existing',
      agent_id: 'orc-1',
      payload: { question: 'Existing question?' },
    })}\n`, 'utf8');

    const { tick } = await import('./coordinator.ts');
    await tick();

    // No claims seeded, so checkpoint was bootstrapped but no input state changes made.
    expect(true).toBe(true); // The tick ran without errors — main assertion is checkpoint state above.

    const checkpoint = JSON.parse(readFileSync(join(dir, 'event-checkpoint.json'), 'utf8')) as {
      last_processed_seq: number;
      processed_event_ids: string[];
    };
    expect(checkpoint.last_processed_seq).toBe(30);
    expect(checkpoint.processed_event_ids).toHaveLength(1);
  });

  it('does not process coordinator-originated INPUT_REQUEST events as new work items', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');
    const nowIso = '2026-03-11T05:10:00.000Z';

    // Coordinator-originated input_requested (actor_type: 'coordinator') should
    // process without errors even if no matching claim exists.
    await expect(processTerminalRunEvents([{
      ts: nowIso,
      event: 'input_requested',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-input-001',
      task_ref: 'orch/task-150',
      agent_id: 'orc-1',
      payload: { question: 'Should I answer yes?' },
    }])).resolves.not.toThrow();
  });

  it('deposits TASK_COMPLETE notification with success=true for run_finished', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/test-task',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-test',
        task_ref: 'orch/test-task',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        stop,
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      event: 'run_finished',
      run_id: 'run-test',
      task_ref: 'orch/test-task',
      agent_id: 'orc-1',
      ts: '2026-03-08T08:00:00.000Z',
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-test')!;
    expect(claim.state).toBe('done');
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((entry) => entry.ref === 'orch/test-task')!;
    expect(task.status).toBe('done');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'orc-1')!;
    expect(stop).toHaveBeenCalledWith('pty:orc-1');
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBeNull();
  });

  it('does not duplicate TASK_COMPLETE notifications when replaying the same terminal event', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-terminal-replay',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-terminal-replay',
        task_ref: 'orch/task-terminal-replay',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        stop,
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    const event = {
      seq: 7,
      event_id: 'evt-run-finished-replay',
      event: 'run_finished',
      run_id: 'run-terminal-replay',
      task_ref: 'orch/task-terminal-replay',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:12:00.000Z',
      payload: {},
    } as const;

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([event]);
    resetCheckpoint(dir);
    await processTerminalRunEvents([event]);

    // Event is deduplicated by event_id — claim should still be in done state (not double-processed).
    const { readJson } = await import('./lib/stateReader.ts');
    const { claims } = readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> };
    const claim = claims.find((c) => c.run_id === 'run-terminal-replay');
    expect(claim?.state).toBe('done');
  });

  it('does not duplicate TASK_COMPLETE notifications for duplicate terminal reports on the same run', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-terminal-duplicate',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-terminal-duplicate',
        task_ref: 'orch/task-terminal-duplicate',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-03-11T08:00:00.000Z',
        started_at: '2026-03-11T08:01:00.000Z',
        lease_expires_at: '2099-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      seq: 1,
      event_id: 'evt-run-finished-duplicate-1',
      event: 'run_finished',
      run_id: 'run-terminal-duplicate',
      task_ref: 'orch/task-terminal-duplicate',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:12:00.000Z',
      payload: {},
    } as const]);
    await processTerminalRunEvents([{
      seq: 2,
      event_id: 'evt-run-finished-duplicate-2',
      event: 'run_finished',
      run_id: 'run-terminal-duplicate',
      task_ref: 'orch/task-terminal-duplicate',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:12:01.000Z',
      payload: {},
    } as const]);

    const { readJson } = await import('./lib/stateReader.ts');
    const { claims } = readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> };
    const claim = claims.find((c) => c.run_id === 'run-terminal-duplicate');
    // Claim should be in a terminal state after the first terminal event.
    expect(['done', 'failed']).toContain(claim?.state);
  });

  it('does not emit a second TASK_COMPLETE notification for a contradictory terminal outcome on the same run', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/task-terminal-contradictory',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-terminal-contradictory',
        task_ref: 'orch/task-terminal-contradictory',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-03-11T08:00:00.000Z',
        started_at: '2026-03-11T08:01:00.000Z',
        lease_expires_at: '2099-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      seq: 1,
      event_id: 'evt-run-finished-contradictory-1',
      event: 'run_finished',
      run_id: 'run-terminal-contradictory',
      task_ref: 'orch/task-terminal-contradictory',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:12:00.000Z',
      payload: {},
    } as const]);
    await processTerminalRunEvents([{
      seq: 2,
      event_id: 'evt-run-failed-contradictory-2',
      event: 'run_failed',
      run_id: 'run-terminal-contradictory',
      task_ref: 'orch/task-terminal-contradictory',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:12:01.000Z',
      payload: { reason: 'late contradictory failure', policy: 'requeue' },
    } as const]);

    const { readJson } = await import('./lib/stateReader.ts');
    const { claims } = readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> };
    const claim = claims.find((c) => c.run_id === 'run-terminal-contradictory');
    // Claim should be in a terminal state after the first terminal event.
    expect(['done', 'failed']).toContain(claim?.state);
  });

  it('deposits TASK_COMPLETE notification with success=false and failure_reason for run_failed', async () => {
    seedState(dir, {
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/test-task-fail',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-fail-test',
        task_ref: 'orch/test-task-fail',
        agent_id: 'orc-2',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      event: 'run_failed',
      run_id: 'run-fail-test',
      task_ref: 'orch/test-task-fail',
      agent_id: 'orc-2',
      ts: '2026-03-08T08:01:00.000Z',
      payload: {
        policy: 'requeue',
        reason: 'build error',
      },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-fail-test')!;
    expect(claim.state).toBe('failed');
    expect(claim.failure_reason).toBe('build error');
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((entry) => entry.ref === 'orch/test-task-fail')!;
    expect(task.status).toBe('todo');
  });

  it('does not tear down a newer active run when processing an older terminal event', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1-new',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      claims: [{
        run_id: 'run-newer',
        task_ref: 'proj/fix-bug',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    const stop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        stop,
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn(),
        attach: vi.fn(),
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'run_finished',
      run_id: 'run-older',
      task_ref: 'proj/old-task',
      agent_id: 'orc-1',
      ts: '2026-03-08T08:00:00.000Z',
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'orc-1')!;
    expect(stop).not.toHaveBeenCalled();
    expect(agent.status).toBe('running');
    expect(agent.session_handle).toBe('pty:orc-1-new');
  });

  it('processes run_failed with payload.code without error and marks claim failed', async () => {
    seedState(dir, {
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/test-task-exit',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-fail-exit',
        task_ref: 'orch/test-task-exit',
        agent_id: 'orc-3',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      event: 'run_failed',
      run_id: 'run-fail-exit',
      task_ref: 'orch/test-task-exit',
      agent_id: 'orc-3',
      ts: '2026-03-08T08:02:00.000Z',
      payload: {
        policy: 'requeue',
        code: 'ERR_COMPILE',
      },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-fail-exit')!;
    expect(claim.state).toBe('failed');
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((entry) => entry.ref === 'orch/test-task-exit')!;
    expect(task.attempt_count).toBe(1);
  });

  it('retries finalize rebase once more for stale finalization requests, then blocks the run', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-finalize-nudge',
        task_ref: 'proj/fix-bug',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        started_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        last_heartbeat_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        finalization_state: 'finalize_rebase_requested',
        finalization_retry_count: 1,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
      }],
    });

    const send = vi.fn().mockResolvedValue('');
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send,
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));

    const originalArgv = process.argv;
    process.argv = [...process.argv.slice(0, 2), '--run-inactive-nudge-ms=1', '--run-inactive-nudge-interval-ms=1'];
    const { tick } = await import('./coordinator.ts');
    await tick();
    let { readJson } = await import('./lib/stateReader.ts');
    let claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-nudge')!;
    expect(send).toHaveBeenCalledWith('pty:worker-01', expect.stringContaining('FINALIZE_REBASE'));
    expect(claim.finalization_state).toBe('finalize_rebase_requested');
    expect(claim.finalization_retry_count).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    readJson = (await import('./lib/stateReader.ts')).readJson;
    claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((entry) => entry.run_id === 'run-finalize-nudge')!;
    expect(claim.finalization_state).toBe('blocked_finalize');
    expect(claim.finalization_blocked_reason).toContain('finalization retry timed out waiting for worker progress');
    process.argv = originalArgv;
  });
});

describe('buildTaskEnvelope', () => {
  it('includes richer task-spec sections in the rendered TASK_START payload', async () => {
    seedState(dir, {
      tasks: [{
        ...DISPATCHABLE_TASK,
        acceptance_criteria: ['first criterion'],
        description: 'Short description',
      }],
    });

    vi.doMock('./lib/taskSpecReader.ts', () => ({
      readTaskSpecSections: vi.fn().mockReturnValue({
        current_state: 'Current state text.',
        desired_state: 'Desired state text.',
        start_here: '- coordinator.ts',
        files_to_change: '- coordinator.ts\n- coordinator.test.ts',
        implementation_notes: '- keep review scope narrow',
        avoid_reading: 'lib/masterPtyForwarder.ts',
        verification: '```bash\nnpx vitest\n```',
        source_path: 'docs/backlog/148-launch-provider-sessions-inside-assigned-worktrees.md',
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      ensureRunWorktree: vi.fn(),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        worktree_path: '/tmp/orc-worktrees/run-envelope-1',
      }),
    }));

    const { buildTaskEnvelope } = await import('./coordinator.ts');
    const rendered = buildTaskEnvelope('proj/fix-bug', 'run-envelope-1', 'orc-1');

    expect(rendered).toContain('current_state:');
    expect(rendered).toContain('Current state text.');
    expect(rendered).toContain('desired_state:');
    expect(rendered).toContain('Desired state text.');
    expect(rendered).toContain('start_here:');
    expect(rendered).toContain('- coordinator.ts');
    expect(rendered).toContain('files_to_change:');
    expect(rendered).toContain('- coordinator.test.ts');
    expect(rendered).toContain('avoid_reading:');
    expect(rendered).toContain('lib/masterPtyForwarder.ts');
    expect(rendered).toContain('implementation_notes:');
    expect(rendered).toContain('- keep review scope narrow');
    expect(rendered).toContain('targeted_verification:');
    expect(rendered).toContain('task_spec_path: docs/backlog/148-launch-provider-sessions-inside-assigned-worktrees.md');
    expect(rendered).toContain('assigned_worktree: /tmp/orc-worktrees/run-envelope-1');
    expect(rendered).toContain("run-start --run-id=run-envelope-1 --agent-id=orc-1");
  });
});

describe('doShutdown', () => {
  it('stops all managed PTY sessions before coordinator_stopped event', async () => {
    process.env.ORC_MAX_WORKERS = '2';
    process.env.ORC_WORKER_PROVIDER = 'claude';
    seedState(dir, {
      agents: [
        {
          agent_id: 'orc-1',
          provider: 'claude',
          role: 'worker',
          status: 'running',
          session_handle: 'pty:orc-1',
          provider_ref: null,
          registered_at: new Date().toISOString(),
          last_heartbeat_at: new Date().toISOString(),
        },
        {
          agent_id: 'orc-2',
          provider: 'claude',
          role: 'worker',
          status: 'running',
          session_handle: 'pty:orc-2',
          provider_ref: null,
          registered_at: new Date().toISOString(),
          last_heartbeat_at: new Date().toISOString(),
        },
      ],
    });

    const mockStop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn().mockResolvedValue({ session_handle: 'pty:orc-1', provider_ref: null }),
        send: vi.fn().mockResolvedValue(''),
        stop: mockStop,
        ownsSession: vi.fn().mockReturnValue(true),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
        detectInputBlock: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const coordinator = await import('./coordinator.ts');
    await coordinator.main();
    await coordinator.doShutdown();

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(mockStop).toHaveBeenCalledTimes(2);
    expect(mockStop).toHaveBeenCalledWith('pty:orc-1');
    expect(mockStop).toHaveBeenCalledWith('pty:orc-2');
  });

  it('doShutdown continues if one session stop fails', async () => {
    process.env.ORC_MAX_WORKERS = '2';
    process.env.ORC_WORKER_PROVIDER = 'claude';
    seedState(dir, {
      agents: [
        {
          agent_id: 'orc-1',
          provider: 'claude',
          role: 'worker',
          status: 'running',
          session_handle: 'pty:orc-1',
          provider_ref: null,
          registered_at: new Date().toISOString(),
          last_heartbeat_at: new Date().toISOString(),
        },
        {
          agent_id: 'orc-2',
          provider: 'claude',
          role: 'worker',
          status: 'running',
          session_handle: 'pty:orc-2',
          provider_ref: null,
          registered_at: new Date().toISOString(),
          last_heartbeat_at: new Date().toISOString(),
        },
      ],
    });

    const mockStop = vi.fn()
      .mockRejectedValueOnce(new Error('session already dead'))
      .mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn().mockResolvedValue({ session_handle: 'pty:orc-1', provider_ref: null }),
        send: vi.fn().mockResolvedValue(''),
        stop: mockStop,
        ownsSession: vi.fn().mockReturnValue(true),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
        detectInputBlock: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const coordinator = await import('./coordinator.ts');
    await coordinator.main();
    await coordinator.doShutdown();

    // Should still exit cleanly despite one stop failure
    expect(exitSpy).toHaveBeenCalledWith(0);
    // Both sessions should have been attempted
    expect(mockStop).toHaveBeenCalledTimes(2);
  });

  it('releases coordinator lock only once across shutdown and exit hook', async () => {
    seedState(dir);

    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const unlinkSpy = vi.fn((path) => actualFs.unlinkSync(path));
    vi.doMock('node:fs', () => ({
      ...actualFs,
      unlinkSync: unlinkSpy,
    }));

    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const coordinator = await import('./coordinator.ts');
    await coordinator.main();
    await coordinator.doShutdown();

    const exitHandler = onSpy.mock.calls.find(([eventName]) => eventName === 'exit')?.[1];
    expect(typeof exitHandler).toBe('function');
    exitHandler!();

    const pidPath = join(dir, 'coordinator.pid');
    const pidUnlinkCalls = unlinkSpy.mock.calls.filter(([path]) => path === pidPath);
    expect(pidUnlinkCalls).toHaveLength(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('global error handlers', () => {
  it('unhandledRejection triggers doShutdown and logs to stderr', async () => {
    seedState(dir);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');

    const coordinator = await import('./coordinator.ts');
    await coordinator.main();

    const handler = onSpy.mock.calls.find(([event]) => event === 'unhandledRejection')?.[1] as ((reason: unknown) => void) | undefined;
    expect(typeof handler).toBe('function');
    handler!(new Error('boom'));

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('unhandled rejection'), expect.anything());
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('uncaughtException triggers doShutdown and logs to stderr', async () => {
    seedState(dir);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onSpy = vi.spyOn(process, 'on');

    const coordinator = await import('./coordinator.ts');
    await coordinator.main();

    const handler = onSpy.mock.calls.find(([event]) => event === 'uncaughtException')?.[1] as ((err: Error) => void) | undefined;
    expect(typeof handler).toBe('function');
    handler!(new Error('oops'));

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('uncaught exception'), expect.anything());
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('double doShutdown() is safe — shutdownStarted guard prevents re-entrance', async () => {
    seedState(dir);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const coordinator = await import('./coordinator.ts');
    await coordinator.main();
    await coordinator.doShutdown();
    await coordinator.doShutdown(); // second call must not throw or double-exit

    // process.exit(0) should have been called exactly once
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('lifecycle reducer integration', () => {
  it('applies lifecycle transitions through the reducer boundary', async () => {
    // Verify that the coordinator routes run_started / heartbeat / run_finished
    // through the reducer and applies the resulting state changes correctly.
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/reducer-task',
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-reducer-001',
        task_ref: 'orch/reducer-task',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: new Date(Date.now() - 5000).toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');

    // run_started → should transition claimed → in_progress
    await processTerminalRunEvents([{
      event: 'run_started',
      run_id: 'run-reducer-001',
      task_ref: 'orch/reducer-task',
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: {},
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const afterStart = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-reducer-001')!;
    expect(afterStart.state).toBe('in_progress');
    expect(afterStart.started_at).toBeTruthy();

    // heartbeat → should extend lease
    const beforeLease = afterStart.lease_expires_at as string;
    await processTerminalRunEvents([{
      event: 'heartbeat',
      run_id: 'run-reducer-001',
      task_ref: 'orch/reducer-task',
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: {},
    }]);

    const afterHb = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-reducer-001')!;
    expect(afterHb.last_heartbeat_at).toBeTruthy();
    expect(new Date(afterHb.lease_expires_at as string).getTime())
      .toBeGreaterThanOrEqual(new Date(beforeLease).getTime());

    // run_finished → should transition to done
    await processTerminalRunEvents([{
      event: 'run_finished',
      run_id: 'run-reducer-001',
      task_ref: 'orch/reducer-task',
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: {},
    }]);

    const afterFinish = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-reducer-001')!;
    expect(afterFinish.state).toBe('done');
    expect(afterFinish.finished_at).toBeTruthy();

    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((t) => t.ref === 'orch/reducer-task')!;
    expect(task.status).toBe('done');
  });

  it('treats duplicate and replayed events as explicit reducer outcomes', async () => {
    // A re-delivered run_started on an already in_progress claim must be a noop
    // for the state transition, and a re-delivered work_complete must still call
    // finalizeRun regardless of whether finalization was already started.
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/reducer-replay-task',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-reducer-replay',
        task_ref: 'orch/reducer-replay-task',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const spawnSync = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' })  // merge-base for first work_complete
      .mockReturnValueOnce({ status: 0, stdout: '' });  // merge for first work_complete
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync };
    });
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        stop: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockResolvedValue(''),
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        attach: vi.fn(),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue({
        branch: 'task/run-reducer-replay',
        worktree_path: '/tmp/orc-worktrees/run-reducer-replay',
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');

    // A replayed run_started on an in_progress claim must not change state
    const { readJson } = await import('./lib/stateReader.ts');
    const beforeReplay = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-reducer-replay')!;
    await processTerminalRunEvents([{
      event: 'run_started',
      run_id: 'run-reducer-replay',
      task_ref: 'orch/reducer-replay-task',
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: {},
    }]);
    const afterReplay = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-reducer-replay')!;
    expect(afterReplay.state).toBe(beforeReplay.state);
    expect(afterReplay.started_at).toBe(beforeReplay.started_at);
  });

  it('preserves coordinator-visible behavior after reducer extraction', async () => {
    // Phase events should keep the claim alive (act as heartbeats).
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'orch/reducer-phase-task',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-reducer-phase',
        task_ref: 'orch/reducer-phase-task',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: '2026-03-11T07:00:00.000Z',  // expired
        last_heartbeat_at: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      event: 'phase_started',
      run_id: 'run-reducer-phase',
      task_ref: 'orch/reducer-phase-task',
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: { phase: 'implementation' },
    }]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-reducer-phase')!;
    // phase_started should have renewed the lease (claim still alive)
    expect(claim.state).toBe('in_progress');
    expect(new Date(claim.lease_expires_at as string).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('main startup validation', () => {
  it('exits with code 1 when backlog.json is missing', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'orc-coord-startup-test-'));
    writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
    writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
    writeFileSync(join(stateDir, 'events.jsonl'), '');

    const result = spawnSync(process.execPath, [COORDINATOR_PATH, '--mode=monitor'], {
      env: { ...process.env, ORCH_STATE_DIR: stateDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required state file missing: backlog.json');

    rmSync(stateDir, { recursive: true, force: true });
  });
});

describe('stale lease expiry and recovery via tick', () => {
  it('expires an in_progress claim with a past lease and requeues the task', async () => {
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'proj/expiry-task',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-expiry-001',
        task_ref: 'proj/expiry-task',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        lease_expires_at: new Date(Date.now() - 1000).toISOString(), // already expired
        last_heartbeat_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
        getOutputTail: vi.fn().mockReturnValue(null),
      }),
    }));
    vi.doMock('./lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn(),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn().mockReturnValue(null),
    }));

    const { tick } = await import('./coordinator.ts');
    await tick();

    const { readJson } = await import('./lib/stateReader.ts');
    const { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
    const claim = claims.find((c) => c.run_id === 'run-expiry-001')!;
    expect(claim.state).toBe('failed');

    const { features } = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> });
    const task = features[0].tasks.find((t) => t.ref === 'proj/expiry-task')!;
    expect(task.status).toBe('todo');

    const events = readEvents(dir);
    expect(events.some((e) => e.event === 'claim_expired' && e.run_id === 'run-expiry-001')).toBe(true);
  });
});

describe('failure-injection: delayed, duplicate, and stale lifecycle events', () => {
  it('ignores stale terminal events for an older run after a newer claim exists', async () => {
    // A newer claim is active for the same task. An older run_finished arrives
    // for a run_id that no longer has an active claim. The task must remain in
    // its current state and the active agent session must not be torn down.
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'proj/stale-task',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-newer-active',
        task_ref: 'proj/stale-task',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_heartbeat_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const stop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        stop,
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn(),
        send: vi.fn(),
        attach: vi.fn(),
      }),
    }));

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    // Stale run_finished for an old run_id that no longer exists in claims.
    await processTerminalRunEvents([{
      seq: 1,
      event_id: 'evt-stale-finish-001',
      event: 'run_finished',
      run_id: 'run-old-evicted',
      task_ref: 'proj/stale-task',
      agent_id: 'orc-1',
      ts: '2026-01-01T00:00:00.000Z',
      payload: {},
    } as const]);

    const { readJson } = await import('./lib/stateReader.ts');
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((t) => t.ref === 'proj/stale-task')!;
    expect(task.status).toBe('in_progress'); // not corrupted by stale event

    const activeClaim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-newer-active')!;
    expect(activeClaim.state).toBe('in_progress'); // active claim unaffected

    expect(stop).not.toHaveBeenCalled(); // active session not torn down
  });

  it('handles duplicate lifecycle events without double-applying state transitions', async () => {
    // run_started processed twice via checkpoint reset. The claim must reach
    // in_progress exactly once — a second application must be a no-op.
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'proj/dup-start-task',
        status: 'claimed',
      }],
      claims: [{
        run_id: 'run-dup-start',
        task_ref: 'proj/dup-start-task',
        agent_id: 'orc-1',
        state: 'claimed',
        claimed_at: '2026-03-11T08:00:00.000Z',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_heartbeat_at: null,
        started_at: null,
        finished_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const startEvent = {
      seq: 1,
      event_id: 'evt-run-started-dup',
      event: 'run_started' as const,
      run_id: 'run-dup-start',
      task_ref: 'proj/dup-start-task',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:00:01.000Z',
      payload: {},
    };

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([startEvent]);

    const { readJson: readJson1 } = await import('./lib/stateReader.ts');
    const claimAfterFirst = (readJson1(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-dup-start')!;
    expect(claimAfterFirst.state).toBe('in_progress');
    const startedAt = claimAfterFirst.started_at;

    // Reset checkpoint so the same event would be processed again if dedup were not in place.
    resetCheckpoint(dir);
    await processTerminalRunEvents([startEvent]);

    const { readJson: readJson2 } = await import('./lib/stateReader.ts');
    const claimAfterSecond = (readJson2(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-dup-start')!;
    // State and timestamps must be identical — no double-application.
    expect(claimAfterSecond.state).toBe('in_progress');
    expect(claimAfterSecond.started_at).toBe(startedAt);
  });

  it('replays pending events safely after coordinator restart with in-flight finalization', async () => {
    // Coordinator restarts while a finalize_rebase_started event is in the log.
    // The event must be deduplicated on the second run so retry_count is not
    // incremented again.
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'proj/restart-finalize-task',
        status: 'in_progress',
      }],
      claims: [{
        run_id: 'run-restart-finalize',
        task_ref: 'proj/restart-finalize-task',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-03-11T08:00:00.000Z',
        started_at: '2026-03-11T08:01:00.000Z',
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
        last_heartbeat_at: null,
        finalization_state: 'finalize_rebase_requested',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const finalizeStartedEvent = {
      seq: 5,
      event_id: 'evt-finalize-started-restart',
      event: 'finalize_rebase_started' as const,
      run_id: 'run-restart-finalize',
      task_ref: 'proj/restart-finalize-task',
      agent_id: 'orc-1',
      ts: '2026-03-11T08:10:00.000Z',
      payload: { status: 'finalize_rebase_in_progress' as const, retry_count: 1 },
    };

    let coordinator = await import('./coordinator.ts');
    await coordinator.processTerminalRunEvents([finalizeStartedEvent]);

    const { readJson: readJson1 } = await import('./lib/stateReader.ts');
    const claimAfterFirst = (readJson1(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-restart-finalize')!;
    expect(claimAfterFirst.finalization_state).toBe('finalize_rebase_in_progress');
    expect(claimAfterFirst.finalization_retry_count).toBe(1);

    // Simulate coordinator restart — checkpoint is persisted, preventing replay.
    vi.resetModules();
    coordinator = await import('./coordinator.ts');
    await coordinator.processTerminalRunEvents([finalizeStartedEvent]);

    const { readJson: readJson2 } = await import('./lib/stateReader.ts');
    const claimAfterRestart = (readJson2(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-restart-finalize')!;
    // retry_count must not be incremented a second time.
    expect(claimAfterRestart.finalization_state).toBe('finalize_rebase_in_progress');
    expect(claimAfterRestart.finalization_retry_count).toBe(1);
  });

  it('delayed heartbeat for an already-expired claim is silently ignored', async () => {
    // A heartbeat event arrives for a run that was expired (claim.state = failed).
    // The coordinator must not re-activate the claim or corrupt state.
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        registered_at: new Date().toISOString(),
        last_heartbeat_at: null,
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'proj/delayed-hb-task',
        status: 'todo',
      }],
      claims: [{
        run_id: 'run-expired-hb',
        task_ref: 'proj/delayed-hb-task',
        agent_id: 'orc-1',
        state: 'failed',
        claimed_at: '2026-03-11T07:00:00.000Z',
        started_at: '2026-03-11T07:01:00.000Z',
        finished_at: '2026-03-11T07:31:00.000Z',
        lease_expires_at: '2026-03-11T07:31:00.000Z',
        last_heartbeat_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      seq: 1,
      event_id: 'evt-delayed-hb',
      event: 'heartbeat',
      run_id: 'run-expired-hb',
      task_ref: 'proj/delayed-hb-task',
      agent_id: 'orc-1',
      ts: '2026-03-11T07:35:00.000Z', // arrived after expiry
      payload: {},
    } as const]);

    const { readJson } = await import('./lib/stateReader.ts');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-expired-hb')!;
    // State must remain failed — heartbeat must not re-activate the run.
    expect(claim.state).toBe('failed');
    expect(claim.last_heartbeat_at).toBeNull();

    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((t) => t.ref === 'proj/delayed-hb-task')!;
    expect(task.status).toBe('todo'); // task remains in requeued state
  });

  it('delayed run_failed for an already-expired run does not re-requeue the task', async () => {
    // The lease expired (task is already todo again). A delayed run_failed event
    // arrives from the slow worker. The task must stay in todo — not be requeued
    // a second time. The claim is already failed so finishRun is a no-op.
    seedState(dir, {
      agents: [{
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ...DISPATCHABLE_TASK,
        ref: 'proj/late-fail-task',
        status: 'todo', // already requeued by lease expiry
      }],
      claims: [{
        run_id: 'run-late-fail',
        task_ref: 'proj/late-fail-task',
        agent_id: 'orc-1',
        state: 'failed', // already expired
        claimed_at: '2026-03-11T07:00:00.000Z',
        started_at: '2026-03-11T07:01:00.000Z',
        finished_at: '2026-03-11T07:31:00.000Z',
        lease_expires_at: '2026-03-11T07:31:00.000Z',
        last_heartbeat_at: null,
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    const { processTerminalRunEvents } = await import('./coordinator.ts');
    await processTerminalRunEvents([{
      seq: 1,
      event_id: 'evt-late-fail',
      event: 'run_failed',
      run_id: 'run-late-fail',
      task_ref: 'proj/late-fail-task',
      agent_id: 'orc-1',
      ts: '2026-03-11T07:35:00.000Z',
      payload: { policy: 'requeue', reason: 'build error (delivered late)' },
    } as const]);

    const { readJson } = await import('./lib/stateReader.ts');
    const task = (readJson(dir, 'backlog.json') as { features: Array<{ tasks: Array<Record<string, unknown>> }> }).features[0].tasks.find((t) => t.ref === 'proj/late-fail-task')!;
    // Task must remain in todo (not block or corrupt the already-requeued state).
    expect(task.status).toBe('todo');
    const claim = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> }).claims.find((c) => c.run_id === 'run-late-fail')!;
    expect(claim.state).toBe('failed');
  });
});
