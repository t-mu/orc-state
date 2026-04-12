import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTempStateDir,
  cleanupTempStateDir,
  seedState,
  makeAdapterMock,
  makeRunWorktreeMock,
  readAgents,
  readClaims,
  readBacklog,
} from '../test-fixtures/stateHelpers.ts';

let dir: string;

beforeEach(() => {
  vi.resetModules();
  dir = createTempStateDir('orc-pr-e2e-');
  process.env.ORC_STATE_DIR = dir;
  process.env.ORC_REPO_ROOT = dir;
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempStateDir(dir);
  delete process.env.ORC_STATE_DIR;
  delete process.env.ORC_REPO_ROOT;
  delete process.env.ORC_CONFIG_FILE;
});

const PR_TASK_BASE = {
  title: 'PR E2E Task',
  status: 'in_progress',
  task_type: 'implementation',
  planning_state: 'ready_for_dispatch',
  delegated_by: 'master',
  merge_strategy: 'pr',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

function writePrConfig(stateDir: string, extra: Record<string, unknown> = {}) {
  const configPath = join(stateDir, 'orc-state.config.json');
  writeFileSync(configPath, JSON.stringify({
    coordinator: {
      pr_provider: 'github',
      pr_push_remote: 'origin',
      pr_finalize_lease_ms: 3_600_000,
      ...extra,
    },
  }));
  process.env.ORC_CONFIG_FILE = configPath;
}

describe('PR merge strategy e2e', () => {
  it('single worker handles entire PR lifecycle: work_complete → PR created → PR_REVIEW sent to worker → merge → task done', async () => {
    const mainRunId = 'run-pr-e2e-full';
    const taskRef = 'pr-e2e/task-full';

    seedState(dir, {
      agents: [{
        agent_id: 'orc-1', provider: 'claude', role: 'worker',
        status: 'running', session_handle: 'pty:orc-1',
        registered_at: new Date().toISOString(),
      }],
      tasks: [{ ...PR_TASK_BASE, ref: taskRef }],
      claims: [{
        run_id: mainRunId,
        task_ref: taskRef,
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    writePrConfig(dir);

    const mockPushBranch = vi.fn();
    const mockCreatePr = vi.fn().mockReturnValue('https://github.com/test/repo/pull/1');
    const mockMergePr = vi.fn();
    vi.doMock('../lib/gitHosts/index.ts', () => ({
      getGitHostAdapter: vi.fn().mockReturnValue({
        pushBranch: mockPushBranch,
        createPr: mockCreatePr,
        mergePr: mockMergePr,
      }),
    }));

    const mockSend = vi.fn().mockResolvedValue('');
    const mockStop = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../adapters/index.ts', () => makeAdapterMock({ send: mockSend, stop: mockStop }));
    vi.doMock('../lib/runWorktree.ts', () => makeRunWorktreeMock({
      getRunWorktree: vi.fn().mockReturnValue({
        branch: `task/${mainRunId}`,
        worktree_path: `/tmp/orc-worktrees/${mainRunId}`,
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
    }));

    const { processTerminalRunEvents } = await import('../coordinator.ts');

    // Phase 1: worker signals work_complete → PR created, PR_REVIEW sent to same worker
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: mainRunId,
      task_ref: taskRef,
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: { status: 'awaiting_finalize' },
    }]);

    expect(mockPushBranch).toHaveBeenCalledWith('origin', `task/${mainRunId}`);
    expect(mockCreatePr).toHaveBeenCalledWith(PR_TASK_BASE.title, `task/${mainRunId}`, expect.any(String));

    // No new reviewer agent started
    const agentsAfterInit = readAgents(dir);
    const reviewerAgent = agentsAfterInit.find((a) => (a as { agent_id: unknown }).agent_id !== 'orc-1');
    expect(reviewerAgent).toBeUndefined();

    // PR_REVIEW sent to the existing worker (pty:orc-1)
    const prReviewSend = mockSend.mock.calls.find(
      ([handle, msg]) => handle === 'pty:orc-1' && typeof msg === 'string' && String(msg).includes('PR_REVIEW'),
    );
    expect(prReviewSend).toBeTruthy();

    const claimAfterInit = readClaims(dir).find((c) => (c as { run_id: string }).run_id === mainRunId)!;
    expect((claimAfterInit as { finalization_state: unknown }).finalization_state).toBe('pr_review_in_progress');
    expect((claimAfterInit as { pr_ref: unknown }).pr_ref).toBe('https://github.com/test/repo/pull/1');
    expect((claimAfterInit as { pr_reviewer_agent_id?: unknown }).pr_reviewer_agent_id).toBeUndefined();

    // Phase 2: same worker signals work_complete again (after PR review done) → coordinator merges PR
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: mainRunId,
      task_ref: taskRef,
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: { status: 'awaiting_finalize' },
    }]);

    expect(mockMergePr).toHaveBeenCalledWith('https://github.com/test/repo/pull/1');

    const claimAfterMerge = readClaims(dir).find((c) => (c as { run_id: string }).run_id === mainRunId)!;
    expect((claimAfterMerge as { state: unknown }).state).toBe('done');

    const task = readBacklog(dir).features[0].tasks.find((t) => (t as { ref: unknown }).ref === taskRef)!;
    expect((task as { status: unknown }).status).toBe('done');

    // Worker session received FINALIZE_SUCCESS signal
    const successNotice = mockSend.mock.calls.find(
      (args) => typeof args[1] === 'string' && args[1].includes('FINALIZE_SUCCESS'),
    );
    expect(successNotice).toBeTruthy();
  });

  it('handles worker failure during PR review: sets claim failed and requeues main task', async () => {
    const mainRunId = 'run-pr-e2e-fail';
    const taskRef = 'pr-e2e/task-fail';

    seedState(dir, {
      agents: [
        {
          agent_id: 'orc-1', provider: 'claude', role: 'worker',
          status: 'running', session_handle: 'pty:orc-1',
          registered_at: new Date().toISOString(),
        },
      ],
      tasks: [{ ...PR_TASK_BASE, ref: taskRef }],
      claims: [{
        run_id: mainRunId,
        task_ref: taskRef,
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        finalization_state: 'pr_review_in_progress',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        pr_ref: 'https://github.com/test/repo/pull/7',
      }],
    });

    writePrConfig(dir);
    vi.doMock('../adapters/index.ts', () => makeAdapterMock({ stop: vi.fn().mockResolvedValue(undefined), send: vi.fn() }));
    vi.doMock('../lib/runWorktree.ts', () => makeRunWorktreeMock());

    const { processTerminalRunEvents } = await import('../coordinator.ts');

    // Worker signals run_failed during PR review
    await processTerminalRunEvents([{
      event: 'run_failed',
      run_id: mainRunId,
      task_ref: taskRef,
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: { reason: 'ci-fix loop exceeded 3 iterations', policy: 'requeue' },
    }]);

    const claim = readClaims(dir).find((c) => (c as { run_id: string }).run_id === mainRunId)!;
    expect((claim as { state: unknown }).state).toBe('failed');

    const task = readBacklog(dir).features[0].tasks.find((t) => (t as { ref: unknown }).ref === taskRef)!;
    expect((task as { status: unknown }).status).toBe('todo'); // requeued
  });

  it('handles PR closed without merge: requeues when worker signals run_failed', async () => {
    const mainRunId = 'run-pr-e2e-closed';
    const taskRef = 'pr-e2e/task-closed';

    seedState(dir, {
      agents: [
        {
          agent_id: 'orc-1', provider: 'claude', role: 'worker',
          status: 'running', session_handle: 'pty:orc-1',
          registered_at: new Date().toISOString(),
        },
      ],
      tasks: [{ ...PR_TASK_BASE, ref: taskRef }],
      claims: [{
        run_id: mainRunId,
        task_ref: taskRef,
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        finalization_state: 'pr_review_in_progress',
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
        pr_ref: 'https://github.com/test/repo/pull/8',
      }],
    });

    writePrConfig(dir);
    vi.doMock('../adapters/index.ts', () => makeAdapterMock({ stop: vi.fn().mockResolvedValue(undefined), send: vi.fn() }));
    vi.doMock('../lib/runWorktree.ts', () => makeRunWorktreeMock());

    const { processTerminalRunEvents } = await import('../coordinator.ts');

    // Worker signals run_failed because PR was closed without merge
    await processTerminalRunEvents([{
      event: 'run_failed',
      run_id: mainRunId,
      task_ref: taskRef,
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: { reason: 'PR closed without merge', policy: 'requeue' },
    }]);

    const claim = readClaims(dir).find((c) => (c as { run_id: string }).run_id === mainRunId)!;
    expect((claim as { state: unknown }).state).toBe('failed');

    const task = readBacklog(dir).features[0].tasks.find((t) => (t as { ref: unknown }).ref === taskRef)!;
    expect((task as { status: unknown }).status).toBe('todo'); // requeued for retry
  });

  it('direct path unchanged when task has no merge_strategy', async () => {
    const taskRef = 'pr-e2e/task-direct';
    const mainRunId = 'run-pr-e2e-direct';

    seedState(dir, {
      agents: [{
        agent_id: 'orc-1', provider: 'codex', role: 'worker',
        status: 'running', session_handle: 'pty:orc-1',
        registered_at: new Date().toISOString(),
      }],
      tasks: [{
        ref: taskRef,
        title: 'Direct Task',
        status: 'in_progress',
        task_type: 'implementation',
        planning_state: 'ready_for_dispatch',
        delegated_by: 'master',
        // no merge_strategy — defaults to direct
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }],
      claims: [{
        run_id: mainRunId,
        task_ref: taskRef,
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: new Date().toISOString(),
        started_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        finalization_state: null,
        finalization_retry_count: 0,
        finalization_blocked_reason: null,
      }],
    });

    // No ORC_CONFIG_FILE — coordinator defaults to direct merge strategy
    const mockPushBranch = vi.fn();
    const mockCreatePr = vi.fn();
    vi.doMock('../lib/gitHosts/index.ts', () => ({
      getGitHostAdapter: vi.fn().mockReturnValue({ pushBranch: mockPushBranch, createPr: mockCreatePr }),
    }));
    const spawnSyncMock = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: '' }) // git merge-base --is-ancestor
      .mockReturnValueOnce({ status: 0, stdout: '' }) // git merge
      .mockReturnValueOnce({ status: 0, stdout: '' }); // git push
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawnSync: spawnSyncMock };
    });
    vi.doMock('../adapters/index.ts', () => makeAdapterMock({
      send: vi.fn().mockResolvedValue(''),
      stop: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock('../lib/runWorktree.ts', () => makeRunWorktreeMock({
      getRunWorktree: vi.fn().mockReturnValue({
        branch: `task/${mainRunId}`,
        worktree_path: `/tmp/orc-worktrees/${mainRunId}`,
      }),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
    }));

    const { processTerminalRunEvents } = await import('../coordinator.ts');
    await processTerminalRunEvents([{
      event: 'work_complete',
      run_id: mainRunId,
      task_ref: taskRef,
      agent_id: 'orc-1',
      ts: new Date().toISOString(),
      payload: { status: 'awaiting_finalize' },
    }]);

    // PR-specific operations must NOT be triggered
    expect(mockPushBranch).not.toHaveBeenCalled();
    expect(mockCreatePr).not.toHaveBeenCalled();

    // Direct git merge path must have been taken
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['merge-base']),
      expect.any(Object),
    );

    const mainClaim = readClaims(dir).find((c) => (c as { run_id: string }).run_id === mainRunId)!;
    expect((mainClaim as { state: unknown }).state).toBe('done');
    const task = readBacklog(dir).features[0].tasks.find((t) => (t as { ref: unknown }).ref === taskRef)!;
    expect((task as { status: unknown }).status).toBe('done');
  });
});
