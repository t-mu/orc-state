import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const createSessionHandle = (agentId: string) => `tmux:${agentId}`;
import { TARGET_REPO_ROOT } from './paths.ts';

const sendMock = vi.fn();
const launchWorkerSessionMock = vi.fn();

vi.mock('../adapters/index.ts', () => ({
  createAdapter: vi.fn(() => ({
    start: vi.fn(),
    send: sendMock,
    attach: vi.fn(),
    heartbeatProbe: vi.fn(),
    stop: vi.fn(),
    getOutputTail: vi.fn(),
  })),
}));

vi.mock('./workerRuntime.ts', () => ({
  launchWorkerSession: launchWorkerSessionMock,
}));

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = createTempStateDir('orc-scout-launch-test-');
  process.env.ORC_SCOUT_READY_TIMEOUT_MS = '25';
  seedProjectTasks(dir, []);
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }, null, 2));
  writeFileSync(join(dir, 'events.jsonl'), '');
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: 'master',
      provider: 'codex',
      role: 'master',
      status: 'running',
      session_handle: 'tmux:master',
      registered_at: '2026-01-01T00:00:00.000Z',
    }],
  }, null, 2));
  mkdirSync(runWorktree());
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
    version: '1',
    runs: [{ run_id: 'run-1', worktree_path: runWorktree(), branch: 'run-1' }],
  }, null, 2));
});

afterEach(() => {
  delete process.env.ORC_SCOUT_READY_TIMEOUT_MS;
  cleanupTempStateDir(dir);
});

const runWorktree = () => join(dir, 'run-1-worktree');

/** The coordinator's launch: prepare as a Codex master's request, then launch and brief (lib/operatorMutations.ts). */
async function launch(request: Record<string, unknown>) {
  const { launchScout, prepareScout } = await import('./scouts.ts');
  return launchScout(dir, prepareScout(dir, request, 'codex'));
}

describe('launchScout', () => {
  it('registers a scout, launches a session, and sends the scout brief', async () => {
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = createSessionHandle(agent.agent_id);
      agent.session_token = 'scout-token-1';
      agent.session_started_at = '2026-01-01T00:00:00.000Z';
      agent.session_ready_at = '2026-01-01T00:00:01.000Z';
      return Promise.resolve({ ok: true, session_handle: createSessionHandle(agent.agent_id), provider_ref: { provider: agent.provider } });
    });

    const result = await launch({
      objective: 'Inspect why run-1 is stalled in implement phase',
      run_id: 'run-1',
      task_ref: 'project/investigate-stall',
      scope_paths: ['src/coordinator.ts', 'logs/worker.log'],
      use_web: false,
    });

    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
    expect(agents.some((agent: { agent_id: string; role: string }) => agent.agent_id === 'scout-1' && agent.role === 'scout')).toBe(true);
    expect(launchWorkerSessionMock).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ agent_id: 'scout-1', role: 'scout', provider: 'codex' }),
      expect.objectContaining({ workingDirectory: runWorktree() }),
    );
    expect(sendMock).toHaveBeenCalledWith('tmux:scout-1', expect.stringContaining('SCOUT_BRIEF v1'));
    expect(sendMock).toHaveBeenCalledWith('tmux:scout-1', expect.stringContaining('Inspect why run-1 is stalled'));
    expect(result).toMatchObject({
      agent_id: 'scout-1',
      role: 'scout',
      provider: 'codex',
      run_id: 'run-1',
      task_ref: 'project/investigate-stall',
      working_directory: runWorktree(),
    });
  });

  it('records the worker pool\'s model for its provider and the objective on the scout, launching with that model', async () => {
    const { prepareScout, SCOUT_OBJECTIVE_MAX } = await import('./scouts.ts');
    const { getAgent } = await import('./agentRegistry.ts');
    const { validateAgents } = await import('./stateValidation.ts');
    // No model configured: null, the provider CLI's own default.
    const plain = prepareScout(dir, { objective: '  find docs errors\nin docs/  ' }, 'codex');
    expect(getAgent(dir, plain.scout.agent_id)).toMatchObject({ model: null, objective: 'find docs errors\nin docs/' });
    process.env.ORC_WORKER_MODEL = 'gpt-test';
    try {
      const long = 'x'.repeat(SCOUT_OBJECTIVE_MAX + 50);
      const modelled = prepareScout(dir, { objective: long }, 'codex');
      const recorded = getAgent(dir, modelled.scout.agent_id)!;
      expect(recorded.model).toBe('gpt-test');
      expect(recorded.objective).toBe('x'.repeat(SCOUT_OBJECTIVE_MAX));
      // The brief keeps the whole objective; only the record is capped.
      expect(modelled.objective).toBe(long);
      // launchWorkerSession launches with the agent record's model (taskModel ?? agent.model).
      expect(modelled.scout.model).toBe('gpt-test');
    } finally {
      delete process.env.ORC_WORKER_MODEL;
    }
    expect(validateAgents(JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')))).toEqual([]);
  });

  it('defaults the working directory to the target repository when no run worktree is linked', async () => {
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = createSessionHandle(agent.agent_id);
      agent.session_token = 'scout-token-1';
      agent.session_started_at = '2026-01-01T00:00:00.000Z';
      agent.session_ready_at = '2026-01-01T00:00:01.000Z';
      return Promise.resolve({ ok: true, session_handle: createSessionHandle(agent.agent_id), provider_ref: { provider: agent.provider } });
    });

    const result = await launch({
      objective: 'Inspect recent coordinator failures',
    });

    expect(launchWorkerSessionMock).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ agent_id: 'scout-1' }),
      expect.objectContaining({ workingDirectory: TARGET_REPO_ROOT }),
    );
    expect(result.working_directory).toBe(TARGET_REPO_ROOT);
  });

  it('falls back to the target repository when the linked run worktree no longer exists (task 204)', async () => {
    rmSync(runWorktree(), { recursive: true });
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = createSessionHandle(agent.agent_id);
      agent.session_token = 'scout-token-1';
      agent.session_started_at = '2026-01-01T00:00:00.000Z';
      agent.session_ready_at = '2026-01-01T00:00:01.000Z';
      return Promise.resolve({ ok: true, session_handle: createSessionHandle(agent.agent_id), provider_ref: { provider: agent.provider } });
    });

    const result = await launch({
      objective: 'Inspect why run-1 lost its worktree',
      run_id: 'run-1',
    });

    expect(launchWorkerSessionMock).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ agent_id: 'scout-1' }),
      expect.objectContaining({ workingDirectory: TARGET_REPO_ROOT }),
    );
    expect(result).toMatchObject({ run_id: 'run-1', working_directory: TARGET_REPO_ROOT });
  });

  it('removes the scout agent when launch fails', async () => {
    launchWorkerSessionMock.mockResolvedValue({ ok: false, reason: 'spawn failed' });

    await expect(launch({
      objective: 'Inspect failed launch handling',
    })).rejects.toThrow('Failed to launch scout scout-1');

    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
    expect(agents.some((agent: { agent_id: string }) => agent.agent_id === 'scout-1')).toBe(false);
  });

  it('fails when the scout never reports for duty', async () => {
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = createSessionHandle(agent.agent_id);
      agent.session_token = 'scout-token-2';
      agent.session_started_at = '2026-01-01T00:00:00.000Z';
      agent.session_ready_at = null;
      return Promise.resolve({ ok: true, session_handle: createSessionHandle(agent.agent_id), provider_ref: { provider: agent.provider } });
    });

    await expect(launch({
      objective: 'Inspect readiness failure',
    })).rejects.toThrow('did not report for duty in time');
  });

  it('says a Claude scout\'s session did not become ready, with no control-socket hint', async () => {
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = createSessionHandle(agent.agent_id);
      agent.session_token = 'scout-token-4';
      agent.session_started_at = '2026-01-01T00:00:00.000Z';
      agent.session_ready_at = null;
      return Promise.resolve({ ok: true, session_handle: createSessionHandle(agent.agent_id), provider_ref: { provider: agent.provider } });
    });
    vi.stubEnv('ORC_WORKER_SANDBOX_NETWORK', 'restricted');
    try {
      const failure = launch({ objective: 'Inspect', provider: 'claude' });
      await expect(failure).rejects.toThrow('scout session did not become ready in time (no session-start hook record)');
      await expect(failure).rejects.not.toThrow(/control socket|report for duty/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('in a project, passes the sandbox network opt-in and explains a scout that cannot reach the socket (task 230)', async () => {
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = createSessionHandle(agent.agent_id);
      agent.session_token = 'scout-token-3';
      agent.session_started_at = '2026-01-01T00:00:00.000Z';
      agent.session_ready_at = null;
      return Promise.resolve({ ok: true, session_handle: createSessionHandle(agent.agent_id), provider_ref: { provider: agent.provider } });
    });
    vi.resetModules();
    vi.doMock('./paths.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('./paths.ts')>(), ACTIVE_PROJECT: { id: 'p1', stateDir: dir },
    }));
    vi.stubEnv('ORC_WORKER_SANDBOX_NETWORK', 'restricted');
    try {
      // The master is a Codex session, so the scout is a Codex scout: read-only, no network setting.
      await expect(launch({ objective: 'Inspect' }))
        .rejects.toThrow(/did not report for duty in time; in a project a sandboxed codex scout .* \(request a claude scout\)/);
      expect(launchWorkerSessionMock.mock.calls[0][2]).toMatchObject({ sandboxNetwork: 'restricted' });
    } finally {
      vi.unstubAllEnvs();
      vi.doUnmock('./paths.ts');
      vi.resetModules();
    }
  });
});
