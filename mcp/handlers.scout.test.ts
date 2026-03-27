import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../lib/workerRuntime.ts', () => ({
  launchWorkerSession: launchWorkerSessionMock,
}));

let dir: string;

beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), 'orc-mcp-scout-test-'));
  process.env.ORC_REPO_ROOT = dir;
  mkdirSync(join(dir, 'backlog'), { recursive: true });
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'project', title: 'Project', tasks: [] }],
  }, null, 2));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }, null, 2));
  writeFileSync(join(dir, 'events.jsonl'), '');
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: 'master',
      provider: 'codex',
      role: 'master',
      status: 'running',
      session_handle: 'pty:master',
      capabilities: [],
      registered_at: '2026-01-01T00:00:00.000Z',
    }],
  }, null, 2));
  writeFileSync(join(dir, 'run-worktrees.json'), JSON.stringify({
    version: '1',
    runs: [{ run_id: 'run-1', worktree_path: '/tmp/run-1-worktree', branch: 'run-1' }],
  }, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleRequestScout', () => {
  it('registers a scout, launches a session, and sends the scout brief', async () => {
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = `pty:${agent.agent_id}`;
      return Promise.resolve({ ok: true, session_handle: `pty:${agent.agent_id}`, provider_ref: { provider: agent.provider } });
    });

    const { handleRequestScout } = await import('./handlers.ts');
    const result = await handleRequestScout(dir, {
      objective: 'Inspect why run-1 is stalled in implement phase',
      run_id: 'run-1',
      task_ref: 'project/investigate-stall',
      scope_paths: ['src/coordinator.ts', 'logs/worker.log'],
      use_web: false,
      actor_id: 'master',
    });

    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
    expect(agents.some((agent: { agent_id: string; role: string }) => agent.agent_id === 'scout-1' && agent.role === 'scout')).toBe(true);
    expect(launchWorkerSessionMock).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ agent_id: 'scout-1', role: 'scout', provider: 'codex' }),
      expect.objectContaining({ workingDirectory: '/tmp/run-1-worktree' }),
    );
    expect(sendMock).toHaveBeenCalledWith('pty:scout-1', expect.stringContaining('SCOUT_BRIEF v1'));
    expect(sendMock).toHaveBeenCalledWith('pty:scout-1', expect.stringContaining('Inspect why run-1 is stalled'));
    expect(result).toMatchObject({
      agent_id: 'scout-1',
      role: 'scout',
      provider: 'codex',
      run_id: 'run-1',
      task_ref: 'project/investigate-stall',
      working_directory: '/tmp/run-1-worktree',
    });
  });

  it('defaults the working directory to the repo root when no run worktree is linked', async () => {
    launchWorkerSessionMock.mockImplementation((_stateDir, agent) => {
      agent.status = 'running';
      agent.session_handle = `pty:${agent.agent_id}`;
      return Promise.resolve({ ok: true, session_handle: `pty:${agent.agent_id}`, provider_ref: { provider: agent.provider } });
    });

    const { handleRequestScout } = await import('./handlers.ts');
    const result = await handleRequestScout(dir, {
      objective: 'Inspect recent coordinator failures',
      actor_id: 'master',
    });

    expect(launchWorkerSessionMock).toHaveBeenCalledWith(
      dir,
      expect.objectContaining({ agent_id: 'scout-1' }),
      expect.objectContaining({ workingDirectory: dir }),
    );
    expect(result.working_directory).toBe(dir);
  });

  it('removes the scout agent when launch fails', async () => {
    launchWorkerSessionMock.mockResolvedValue({ ok: false, reason: 'spawn failed' });

    const { handleRequestScout } = await import('./handlers.ts');
    await expect(handleRequestScout(dir, {
      objective: 'Inspect failed launch handling',
      actor_id: 'master',
    })).rejects.toThrow('Failed to launch scout scout-1');

    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
    expect(agents.some((agent: { agent_id: string }) => agent.agent_id === 'scout-1')).toBe(false);
  });

  it('rejects non-master non-human actors', async () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [
        {
          agent_id: 'master',
          provider: 'codex',
          role: 'master',
          status: 'running',
          session_handle: 'pty:master',
          capabilities: [],
          registered_at: '2026-01-01T00:00:00.000Z',
        },
        {
          agent_id: 'orc-1',
          provider: 'codex',
          role: 'worker',
          status: 'running',
          session_handle: 'pty:orc-1',
          capabilities: [],
          registered_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    }, null, 2));

    const { handleRequestScout } = await import('./handlers.ts');
    await expect(handleRequestScout(dir, {
      objective: 'Workers should not request scouts directly',
      actor_id: 'orc-1',
    })).rejects.toThrow(/may only be invoked by master or human actors/);
  });
});
