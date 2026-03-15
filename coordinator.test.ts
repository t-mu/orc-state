import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendNotification, readPendingNotifications } from './lib/masterNotifyQueue.ts';

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
    JSON.stringify({ version: '1', epics: tasks.length ? [{ ref: 'proj', title: 'Project', tasks }] : [] }),
  );
  writeFileSync(
    join(stateDir, 'claims.json'),
    JSON.stringify({ version: '1', claims }),
  );
  writeFileSync(join(stateDir, 'events.jsonl'), '');
}

function readEvents(stateDir: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
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
    expect(mockSend).toHaveBeenCalledOnce();
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

    vi.doMock('./adapters/index.ts', () => ({
      createAdapter: () => ({
        heartbeatProbe: vi.fn().mockResolvedValue(true),
        start: vi.fn().mockRejectedValue(new Error('spawn failed')),
        send: vi.fn().mockResolvedValue(''),
        stop: vi.fn().mockResolvedValue(undefined),
        attach: vi.fn().mockResolvedValue(''),
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

    const { readJson } = await import('./lib/stateReader.ts');
    const { agents } = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> });
    const slot = agents.find((agent) => agent.agent_id === 'orc-1');
    expect(slot?.status).toBe('idle');
    expect(slot?.session_handle).toBeNull();

    const { claims } = (readJson(dir, 'claims.json') as { claims: Array<Record<string, unknown>> });
    expect(claims[0]?.state).toBe('failed');

    const backlog = (readJson(dir, 'backlog.json') as { epics: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> });
    expect(backlog.epics[0].tasks[0].status).toBe('todo');

    const events = readEvents(dir);
    const launchFailure = events.find((event) => event.event === 'session_start_failed' && event.agent_id === 'orc-1')!;
    expect(launchFailure).toBeDefined();
    expect(launchFailure.run_id).toMatch(/^run-/);
    expect(launchFailure.task_ref).toBe('proj/fix-bug');
    expect((launchFailure.payload as Record<string, unknown>).reason).toBe('spawn failed');
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

describe('processTerminalRunEvents', () => {
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
    const task = (readJson(dir, 'backlog.json') as { epics: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> }).epics[0].tasks.find((entry) => entry.ref === 'orch/task-151')!;
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
    const task = (readJson(dir, 'backlog.json') as { epics: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> }).epics[0].tasks.find((entry) => entry.ref === 'orch/task-151')!;
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

  it('deposits INPUT_REQUEST notification for worker input requests', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      ts: '2026-03-11T05:10:00.000Z',
      event: 'input_requested',
      run_id: 'run-input-001',
      task_ref: 'orch/task-150',
      agent_id: 'orc-1',
      payload: { question: 'Should I answer yes?' },
    }]);

    const notifications = readPendingNotifications(dir);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: 'INPUT_REQUEST',
      run_id: 'run-input-001',
      task_ref: 'orch/task-150',
      agent_id: 'orc-1',
      question: 'Should I answer yes?',
    });
  });

  it('does not duplicate coordinator-originated INPUT_REQUEST notifications on event processing', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');
    const nowIso = '2026-03-11T05:10:00.000Z';
    appendNotification(dir, {
      type: 'INPUT_REQUEST',
      task_ref: 'orch/task-150',
      run_id: 'run-input-001',
      agent_id: 'orc-1',
      question: 'Should I answer yes?',
      requested_at: nowIso,
    });

    await processTerminalRunEvents([{
      ts: nowIso,
      event: 'input_requested',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-input-001',
      task_ref: 'orch/task-150',
      agent_id: 'orc-1',
      payload: { question: 'Should I answer yes?' },
    }]);

    const notifications = readPendingNotifications(dir);
    expect(notifications).toHaveLength(1);
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
      task_ref: 'orch/test-task',
      agent_id: 'orc-1',
      ts: '2026-03-08T08:00:00.000Z',
    }]);

    const notifications = readPendingNotifications(dir);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('TASK_COMPLETE');
    expect(notifications[0].task_ref).toBe('orch/test-task');
    expect(notifications[0].agent_id).toBe('orc-1');
    expect(notifications[0].success).toBe(true);
    expect(notifications[0]).not.toHaveProperty('failure_reason');
    expect(notifications[0]).not.toHaveProperty('exit_code');

    const { readJson } = await import('./lib/stateReader.ts');
    const agent = (readJson(dir, 'agents.json') as { agents: Array<Record<string, unknown>> }).agents.find((entry) => entry.agent_id === 'orc-1')!;
    expect(stop).toHaveBeenCalledWith('pty:orc-1');
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBeNull();
  });

  it('deposits TASK_COMPLETE notification with success=false and failure_reason for run_failed', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      event: 'run_failed',
      task_ref: 'orch/test-task-fail',
      agent_id: 'orc-2',
      ts: '2026-03-08T08:01:00.000Z',
      payload: {
        reason: 'build error',
      },
    }]);

    const notifications = readPendingNotifications(dir);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].task_ref).toBe('orch/test-task-fail');
    expect(notifications[0].success).toBe(false);
    expect(notifications[0].failure_reason).toBe('build error');
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

  it('deposits TASK_COMPLETE notification with exit_code for run_failed', async () => {
    const { processTerminalRunEvents } = await import('./coordinator.ts');

    await processTerminalRunEvents([{
      event: 'run_failed',
      task_ref: 'orch/test-task-exit',
      agent_id: 'orc-3',
      ts: '2026-03-08T08:02:00.000Z',
      payload: {
        code: 'ERR_COMPILE',
      },
    }]);

    const notifications = readPendingNotifications(dir);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].task_ref).toBe('orch/test-task-exit');
    expect(notifications[0].success).toBe(false);
    expect(notifications[0].exit_code).toBe('ERR_COMPILE');
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
    expect(rendered).toContain('targeted_verification:');
    expect(rendered).toContain('task_spec_path: docs/backlog/148-launch-provider-sessions-inside-assigned-worktrees.md');
    expect(rendered).toContain('assigned_worktree: /tmp/orc-worktrees/run-envelope-1');
  });
});

describe('doShutdown', () => {
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
