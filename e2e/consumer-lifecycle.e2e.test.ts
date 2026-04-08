import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { ensureStateInitialized } from '../lib/stateInit.ts';
import { syncBacklogFromSpecs } from '../lib/backlogSync.ts';
import { startRun, finishRun } from '../lib/claimManager.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { createSessionHandle } from '../adapters/pty.ts';

// Minimal task spec simulating a consumer-authored backlog markdown.
// Uses fake-provider-cli.ts fixture pattern — no real provider binary needed.
const TASK_SPEC = `---
ref: project/first-task
feature: project
status: todo
---

# Task 1 — First Task

## Goals
1. Complete the first task.

## Acceptance criteria
- [ ] Task completes successfully.
`;

function readBacklog(stateDir: string): { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> } {
  return JSON.parse(readFileSync(join(stateDir, 'backlog.json'), 'utf8'));
}

function readClaims(stateDir: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(stateDir, 'claims.json'), 'utf8')).claims;
}

describe('consumer lifecycle e2e', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dir = createTempStateDir('consumer-lifecycle-e2e-');
    process.env.ORCH_STATE_DIR = dir;
    process.env.ORC_REPO_ROOT = dir;
    vi.doMock('../lib/runWorktree.ts', () => ({
      ensureRunWorktree: vi.fn((_stateDir: string, { runId }: { runId: string }) => ({
        run_id: runId,
        branch: `task/${runId}`,
        worktree_path: `/tmp/orc-worktrees/${runId}`,
      })),
      cleanupRunWorktree: vi.fn().mockReturnValue(true),
      deleteRunWorktree: vi.fn().mockReturnValue(true),
      pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
      getRunWorktree: vi.fn((_stateDir: string, runId: string) => ({
        worktree_path: `/tmp/orc-worktrees/${runId}`,
      })),
    }));
  });

  afterEach(() => {
    cleanupTempStateDir(dir);
    delete process.env.ORCH_STATE_DIR;
    delete process.env.ORC_REPO_ROOT;
    delete process.env.ORC_MAX_WORKERS;
    delete process.env.ORC_WORKER_PROVIDER;
    vi.unmock('../adapters/index.ts');
    vi.unmock('../lib/runWorktree.ts');
  });

  it('completes a full task lifecycle from init to done', async () => {
    // Phase 1: init — initialise orchestrator state (simulates `orc init`)
    ensureStateInitialized(dir);

    // Phase 2: task creation — write task spec markdown to backlog/ (simulates consumer authoring a task)
    const backlogDir = join(dir, 'backlog');
    mkdirSync(backlogDir, { recursive: true });
    writeFileSync(join(backlogDir, '001-first-task.md'), TASK_SPEC, 'utf8');

    // Phase 3: backlog sync — sync markdown specs to backlog.json (simulates `orc backlog-sync`)
    const syncResult = syncBacklogFromSpecs(dir, backlogDir);
    expect(syncResult.added_tasks).toBe(1);

    const backlogAfterSync = readBacklog(dir);
    const taskAfterSync = backlogAfterSync.features
      .flatMap((f) => f.tasks)
      .find((t) => t.ref === 'project/first-task');
    expect(taskAfterSync).toBeDefined();
    expect(taskAfterSync!.status).toBe('todo');

    // Seed the master agent required by the managed worker pool
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
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
          registered_at: new Date().toISOString(),
        },
      ],
    }));

    // Phase 4: configure managed worker pool (simulates orchestrator.config.json from `orc init`)
    process.env.ORC_MAX_WORKERS = '1';
    process.env.ORC_WORKER_PROVIDER = 'claude';

    // Mock adapter simulates what fake-provider-cli.ts would do in a PTY:
    //
    //   Tick 1 — adapter.start() receives WORKER_BOOTSTRAP.
    //             Simulates the fake provider calling `orc report-for-duty` by
    //             emitting a reported_for_duty event into the events DB so the
    //             coordinator marks the session ready on the next tick.
    //
    //   Tick 2 — coordinator sees session ready, calls adapter.send() with TASK_START.
    //             Simulates the fake provider calling `orc run-start` (transitions
    //             claim to in_progress). finishRun is deferred so markTaskEnvelopeSent
    //             can complete first, then the test finalises the run manually.
    //
    // No real provider binary (claude/codex/gemini) is required.
    const dispatchedRunIds: string[] = [];
    const adapter = {
      start: vi.fn().mockImplementation((agentId: string, { system_prompt }: { system_prompt: string }) => {
        const sessionToken = /session_token: ([^\n]+)/.exec(system_prompt)?.[1]?.trim();
        const sessionHandle = createSessionHandle(agentId);
        // Simulate the fake provider calling report-for-duty after receiving the bootstrap
        if (sessionToken) {
          appendSequencedEvent(dir, {
            ts: new Date().toISOString(),
            event: 'reported_for_duty',
            actor_type: 'agent',
            actor_id: agentId,
            agent_id: agentId,
            payload: { session_token: sessionToken },
          });
        }
        return Promise.resolve({ session_handle: sessionHandle, provider_ref: { provider: 'claude' } });
      }),
      send: vi.fn().mockImplementation((_handle: string, text: string) => {
        // Called with TASK_START — simulate the fake provider calling `orc run-start`
        const runId = /\nrun_id: ([^\n]+)/.exec(text)?.[1]?.trim();
        if (runId) {
          dispatchedRunIds.push(runId);
          startRun(dir, runId, 'orc-1');
          // finishRun is called manually after the tick so that markTaskEnvelopeSent
          // (which runs after adapter.send returns) can record the delivery first
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

    // Phase 5: dispatch — two ticks to drive session startup and task dispatch
    // Tick 1 — coordinator creates managed worker, starts session (adapter.start called),
    //           reported_for_duty is emitted to events DB
    await coordinator.tick();

    // Tick 2 — coordinator processes reported_for_duty, marks session ready,
    //           sends TASK_START (adapter.send called), run transitions to in_progress
    await coordinator.tick();

    // Phase 6: worker completion — simulate the fake provider completing the task
    // (mirrors what `orc task-mark-done` + `orc run-finish` would do in the real flow)
    expect(dispatchedRunIds).toHaveLength(1);
    const runId = dispatchedRunIds[0];
    finishRun(dir, runId, 'orc-1', { success: true });

    // Assert task status reached done
    const backlogAfterRun = readBacklog(dir);
    const completedTask = backlogAfterRun.features
      .flatMap((f) => f.tasks)
      .find((t) => t.ref === 'project/first-task');

    expect(completedTask).toBeDefined();
    expect(completedTask!.status).toBe('done');

    // Assert no stale claims remain after completion
    const staleClaims = readClaims(dir).filter(
      (c) => c.state === 'claimed' || c.state === 'in_progress',
    );
    expect(staleClaims).toHaveLength(0);
  });
});
