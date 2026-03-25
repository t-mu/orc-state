import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.unmock('../adapters/index.ts');
  dir = mkdtempSync(join(tmpdir(), 'orch-coordinator-policy-e2e-'));
  process.env.ORCH_STATE_DIR = dir;
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
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
  vi.unmock('../adapters/index.ts');
  vi.unmock('../lib/runWorktree.ts');
});

describe('coordinator policy e2e', () => {
  it('fails and requeues claimed runs that exceed run_started timeout', async () => {
    seedState({
      taskStatus: 'claimed',
      claim: {
        run_id: 'run-timeout',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: isoAgoMs(10 * 60 * 1000),
        lease_expires_at: isoFromNowMs(10 * 60 * 1000),
      },
    });

    const coordinator = await importCoordinatorWithArgs([
      '--run-inactive-nudge-ms=100',
      '--run-inactive-nudge-interval-ms=200',
    ]);
    await coordinator.tick();

    const claim = readClaims().claims[0];
    expect(claim.state).toBe('failed');
    expect(readBacklog().features[0].tasks[0].status).toBe('todo');
    const agent = readAgents().agents[0];
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBe(null);
    const runFailed = readEvents().find((e) => e.event === 'run_failed' && e.run_id === 'run-timeout');
    expect(runFailed).toBeTruthy();
    expect((runFailed!.payload as Record<string, unknown>).code).toBe('ERR_RUN_START_TIMEOUT');
  });

  it('sends run_start nudge and emits need_input when claimed run is stale but not timed out', async () => {
    seedState({
      taskStatus: 'claimed',
      claim: {
        run_id: 'run-nudge-start',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: isoAgoMs(60 * 1000),
        lease_expires_at: isoFromNowMs(10 * 60 * 1000),
      },
    });
    const adapter = {
      start: vi.fn(),
      send: vi.fn().mockResolvedValue(''),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      detectInputBlock: vi.fn().mockReturnValue(null),
      attach: vi.fn(),
      stop: vi.fn(),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await importCoordinatorWithArgs([
      '--run-inactive-nudge-ms=100',
      '--run-inactive-nudge-interval-ms=200',
    ]);
    await coordinator.tick();

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.send.mock.calls[0][1]).toContain('RUN_NUDGE');
    const needInput = readEvents().find((e) => e.event === 'need_input' && e.run_id === 'run-nudge-start');
    expect(needInput).toBeTruthy();
    expect((needInput!.payload as Record<string, unknown>).reason).toBe('run_start_ack_missing');
  });

  it('fails and requeues in_progress runs that exceed inactivity timeout', async () => {
    seedState({
      taskStatus: 'in_progress',
      agentStatus: 'offline',
      claim: {
        run_id: 'run-inactive-timeout',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: isoAgoMs(40 * 60 * 1000),
        started_at: isoAgoMs(40 * 60 * 1000),
        lease_expires_at: isoFromNowMs(10 * 60 * 1000),
      },
    });

    const coordinator = await importCoordinatorWithArgs([
      '--run-inactive-nudge-ms=100',
      '--run-inactive-nudge-interval-ms=200',
    ]);
    await coordinator.tick();

    const claim = readClaims().claims[0];
    expect(claim.state).toBe('failed');
    expect(readBacklog().features[0].tasks[0].status).toBe('todo');
    const agent = readAgents().agents[0];
    expect(agent.status).toBe('offline');
    expect(agent.session_handle).toBe(null);
    const runFailed = readEvents().find((e) => e.event === 'run_failed' && e.run_id === 'run-inactive-timeout');
    expect(runFailed).toBeTruthy();
    expect((runFailed!.payload as Record<string, unknown>).code).toBe('ERR_RUN_INACTIVITY_TIMEOUT');
  });

  it('sends in_progress nudge and emits need_input for stale active run', async () => {
    seedState({
      taskStatus: 'in_progress',
      claim: {
        run_id: 'run-nudge-progress',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: isoAgoMs(10 * 60 * 1000),
        started_at: isoAgoMs(5 * 60 * 1000),
        lease_expires_at: isoFromNowMs(10 * 60 * 1000),
      },
    });
    const adapter = {
      start: vi.fn(),
      send: vi.fn().mockResolvedValue(''),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      detectInputBlock: vi.fn().mockReturnValue(null),
      attach: vi.fn(),
      stop: vi.fn(),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await importCoordinatorWithArgs([
      '--run-inactive-nudge-ms=100',
      '--run-inactive-nudge-interval-ms=200',
    ]);
    await coordinator.tick();

    expect(adapter.send).toHaveBeenCalledTimes(1);
    expect(adapter.send.mock.calls[0][1]).toContain('RUN_NUDGE');
    const needInput = readEvents().find((e) => e.event === 'need_input' && e.run_id === 'run-nudge-progress');
    expect(needInput).toBeTruthy();
    expect((needInput!.payload as Record<string, unknown>).reason).toBe('run_progress_stale');
  });

  it('marks agent offline when dispatch send fails and session becomes unreachable', async () => {
    seedState({
      taskStatus: 'todo',
      claim: null,
    });
    const heartbeatProbe = vi.fn()
      .mockResolvedValueOnce(true)   // ensureSessionReady
      .mockResolvedValueOnce(false); // after dispatch send failure
    const adapter = {
      start: vi.fn().mockResolvedValue({ session_handle: 'claude:session:worker-01', provider_ref: { id: 'abc' } }),
      send: vi.fn().mockRejectedValue(new Error('dispatch boom')),
      heartbeatProbe,
      detectInputBlock: vi.fn().mockReturnValue(null),
      attach: vi.fn(),
      stop: vi.fn(),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    await coordinator.tick();

    const claim = readClaims().claims[0];
    expect(claim.state).toBe('failed');
    const task = readBacklog().features[0].tasks[0];
    expect(task.status).toBe('todo');

    const agents = readAgents().agents;
    expect(agents.find((a) => a.agent_id === 'worker-01')!.status).toBe('offline');

    const runFailed = readEvents().find((e) => e.event === 'run_failed' && e.run_id === claim.run_id);
    expect(runFailed).toBeTruthy();
    expect((runFailed!.payload as Record<string, unknown>).code).toBe('ERR_DISPATCH_FAILURE');
    const offlineEvent = readEvents().find((e) => e.event === 'agent_offline' && e.agent_id === 'worker-01');
    expect(offlineEvent).toBeTruthy();
    expect((offlineEvent!.payload as Record<string, unknown>).reason).toBe('dispatch_failed_session_unreachable');
  });

  it('throttles run_start nudges to configured interval', async () => {
    seedState({
      taskStatus: 'claimed',
      claim: {
        run_id: 'run-throttle-start',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: isoAgoMs(150),
        lease_expires_at: isoFromNowMs(10 * 60 * 1000),
      },
    });
    const adapter = {
      start: vi.fn(),
      send: vi.fn().mockResolvedValue(''),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      detectInputBlock: vi.fn().mockReturnValue(null),
      attach: vi.fn(),
      stop: vi.fn(),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await importCoordinatorWithArgs([
      '--run-start-timeout-ms=1000',
      '--run-inactive-timeout-ms=5000',
    ]);
    await coordinator.tick(); // should nudge
    await coordinator.tick(); // interval gate: no nudge
    await sleep(250);         // > floor(1000 * 0.2) = 200ms
    await coordinator.tick(); // should nudge again

    expect(adapter.send).toHaveBeenCalledTimes(2);
    const needInputs = readEvents().filter((e) => e.event === 'need_input' && e.run_id === 'run-throttle-start');
    expect(needInputs).toHaveLength(2);
  });

  it('throttles in_progress nudges to configured interval', async () => {
    seedState({
      taskStatus: 'in_progress',
      claim: {
        run_id: 'run-throttle-progress',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: isoAgoMs(300),
        started_at: isoAgoMs(150),
        lease_expires_at: isoFromNowMs(10 * 60 * 1000),
      },
    });
    const adapter = {
      start: vi.fn(),
      send: vi.fn().mockResolvedValue(''),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      detectInputBlock: vi.fn().mockReturnValue(null),
      attach: vi.fn(),
      stop: vi.fn(),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await importCoordinatorWithArgs([
      '--run-start-timeout-ms=5000',
      '--run-inactive-timeout-ms=1000',
      '--run-inactive-nudge-ms=100',
      '--run-inactive-nudge-interval-ms=200',
    ]);
    await coordinator.tick(); // should nudge
    await coordinator.tick(); // interval gate: no nudge
    await sleep(250);         // > floor(1000 * 0.2) = 200ms
    await coordinator.tick(); // should nudge again

    expect(adapter.send).toHaveBeenCalledTimes(2);
    const needInputs = readEvents().filter((e) => e.event === 'need_input' && e.run_id === 'run-throttle-progress');
    expect(needInputs).toHaveLength(2);
  });

  it('blocks stale finalization after the second ignored finalize retry while preserving task progress', async () => {
    seedState({
      taskStatus: 'in_progress',
      claim: {
        run_id: 'run-finalize-blocked',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'in_progress',
        claimed_at: isoAgoMs(10 * 60 * 1000),
        started_at: isoAgoMs(10 * 60 * 1000),
        lease_expires_at: isoFromNowMs(10 * 60 * 1000),
        last_heartbeat_at: isoAgoMs(10 * 60 * 1000),
        finalization_state: 'finalize_rebase_requested',
        finalization_retry_count: 1,
        finalization_blocked_reason: null,
        input_state: null,
        input_requested_at: null,
      },
    });
    const adapter = {
      start: vi.fn(),
      send: vi.fn().mockResolvedValue(''),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      detectInputBlock: vi.fn().mockReturnValue(null),
      attach: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await importCoordinatorWithArgs([
      '--run-inactive-nudge-ms=1',
      '--run-inactive-nudge-interval-ms=1',
    ]);
    await coordinator.tick();
    expect(adapter.send).toHaveBeenCalledWith('claude:session:worker-01', expect.stringContaining('FINALIZE_REBASE'));
    let claim = readClaims().claims[0];
    expect(claim.finalization_state).toBe('finalize_rebase_requested');
    expect(claim.finalization_retry_count).toBe(2);

    await sleep(5);
    await coordinator.tick();
    claim = readClaims().claims[0];
    expect(claim.finalization_state).toBe('blocked_finalize');
    expect(claim.finalization_blocked_reason).toContain('finalization retry timed out waiting for worker progress');
    expect(readBacklog().features[0].tasks[0].status).toBe('in_progress');
  });

  it('expires a stale lease only once across multiple ticks in manual mode', async () => {
    seedState({
      taskStatus: 'claimed',
      claim: {
        run_id: 'run-expired-once',
        task_ref: 'docs/task-1',
        agent_id: 'worker-01',
        state: 'claimed',
        claimed_at: isoAgoMs(60 * 1000),
        lease_expires_at: isoAgoMs(5 * 1000),
      },
    });

    const coordinator = await importCoordinatorWithArgs(['--mode=manual']);
    await coordinator.tick();
    await coordinator.tick();

    const claim = readClaims().claims[0];
    expect(claim.state).toBe('failed');
    expect(readBacklog().features[0].tasks[0].status).toBe('todo');

    const expiredEvents = readEvents().filter((e) => e.event === 'claim_expired' && e.run_id === 'run-expired-once');
    expect(expiredEvents).toHaveLength(1);
  });

  it('recovers from stale PTY session metadata and resumes dispatch safely', async () => {
    seedState({ taskStatus: 'todo', claim: null });
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        capabilities: [],
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: { pid: 999999, provider: 'claude', binary: 'claude' },
        registered_at: '2026-01-01T00:00:00Z',
        last_heartbeat_at: null,
      }],
    }));

    const adapter = {
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      ownsSession: vi.fn().mockReturnValue(false),
      start: vi.fn().mockResolvedValue({ session_handle: 'pty:worker-01-new', provider_ref: { pid: 12345 } }),
      send: vi.fn().mockResolvedValue(''),
      attach: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      getOutputTail: vi.fn().mockReturnValue(null),
      detectInputBlock: vi.fn().mockReturnValue(null),
    };
    vi.doMock('../adapters/index.ts', () => ({ createAdapter: () => adapter }));

    const coordinator = await import('../coordinator.ts');
    await coordinator.tick();

    const agent = readAgents().agents[0];
    expect(agent.status).toBe('running');
    expect(agent.session_handle).toBe('pty:worker-01-new');
    expect(adapter.stop).toHaveBeenCalledWith('pty:worker-01');

    const claims = readClaims().claims.filter((c) => ['claimed', 'in_progress', 'done'].includes(c.state as string));
    expect(claims).toHaveLength(1);
    const task = readBacklog().features[0].tasks.find((t) => t.ref === 'docs/task-1');
    expect(task!.status).not.toBe('todo');
    const events = readEvents();
    expect(events.some((event) => event.event === 'claim_created' && event.agent_id === 'worker-01')).toBe(true);
  });
});

async function importCoordinatorWithArgs(args: string[] = []) {
  const oldArgv = process.argv;
  process.argv = ['node', 'coordinator.ts', ...args];
  try {
    return await import('../coordinator.ts');
  } finally {
    process.argv = oldArgv;
  }
}

function seedState({ taskStatus, claim, agentStatus = 'running' }: { taskStatus: string; claim?: unknown; agentStatus?: string }) {
  const task = {
    ref: 'docs/task-1',
    title: 'Task 1',
    status: taskStatus,
    planning_state: 'ready_for_dispatch',
    task_type: 'implementation',
  };
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [task] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: 'worker-01',
      provider: 'claude',
      role: 'worker',
      capabilities: [],
      status: agentStatus,
      session_handle: agentStatus === 'offline' ? null : 'claude:session:worker-01',
      provider_ref: { id: 'abc' },
      registered_at: '2026-01-01T00:00:00Z',
      last_heartbeat_at: null,
    }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: claim ? [claim] : [],
  }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function readBacklog(): { features: Array<{ tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}

function readClaims(): { claims: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
}

function readAgents(): { agents: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8'));
}

function readEvents(): Array<Record<string, unknown>> {
  const raw = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function isoAgoMs(ms: number) {
  return new Date(Date.now() - ms).toISOString();
}

function isoFromNowMs(ms: number) {
  return new Date(Date.now() + ms).toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
