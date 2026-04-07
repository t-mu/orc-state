/**
 * e2e-real/worker-coordinator-codex.test.ts
 *
 * Real-provider smoke test: coordinator + Codex worker blessed path.
 *
 * Opt-in: set RUN_REAL_PROVIDERS=1 to enable.
 * Skips automatically when Codex provider is unavailable (binary not found,
 * PTY unsupported, or noninteractive spawn fails).
 *
 * What this test covers:
 *   - Coordinator dispatches a real Codex worker session for task 1
 *   - Worker completes task 1 via the full phased lifecycle
 *   - Coordinator dispatches the same worker slot for task 2 (worker reuse)
 *   - Worker completes task 2 via the full phased lifecycle
 *   - Lifecycle events appear in the event log in correct order
 *   - All orchestrator-managed paths (state, worktrees) remain inside the temp repo
 *
 * What this test does NOT cover:
 *   - orc start-session / real master startup
 *   - input_request flows
 *   - Sandbox-mode execution
 *   - Multiple concurrent workers
 *   - Cross-provider master/worker combinations
 */
import { describe, it, beforeAll, afterAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntimeRepo, type RuntimeRepo } from './harness/runtimeRepo.ts';
import { buildRuntimeEnv } from './harness/runtimeEnv.ts';
import { seedManagedWorkerBaseline } from './harness/managedWorkerSeed.ts';
import { requireProviderReady } from './harness/providerReadiness.ts';
import { startCoordinator, type CoordinatorRunner } from './harness/coordinatorRunner.ts';
import {
  waitForTaskStatus,
  waitForWorkerReuse,
  assertRuntimePathsInside,
} from './harness/assertions.ts';
import {
  BLESSED_TASK_1,
  BLESSED_TASK_2,
  buildBlessedTaskSpec,
} from './fixtures/blessedTasks.ts';

const ENABLED = process.env.RUN_REAL_PROVIDERS === '1';

// Per-task completion timeout: 10 minutes — full phased workflow with real
// provider sessions includes explore, implement, npm test, sub-agent reviews,
// rebase, and all lifecycle commands.
const TASK_TIMEOUT_MS = 600_000;

// Worker reuse check timeout: short since this is checked after both tasks done.
const WORKER_REUSE_TIMEOUT_MS = 10_000;

// Coordinator startup timeout: 30 seconds.
const COORDINATOR_STARTUP_MS = 30_000;

// Coordinator tick interval during tests: 3 seconds.
const COORDINATOR_TICK_MS = 3_000;

// Overall test timeout: enough for 2 sequential tasks + startup/teardown.
const OVERALL_TIMEOUT_MS = 1_500_000;

describe.skipIf(!ENABLED)('coordinator + real Codex worker smoke', () => {
  let repo: RuntimeRepo;
  let coordinator: CoordinatorRunner;
  let providerSkipped = false;

  beforeAll(async () => {
    const readiness = await requireProviderReady('codex');
    if (!readiness.ok) {
      console.warn(`[codex-smoke] skipping: ${readiness.message}`);
      providerSkipped = true;
      return;
    }

    repo = createRuntimeRepo();
    const runtimeEnv = buildRuntimeEnv(repo, 'codex');

    // Write blessed task specs into the temp repo's backlog directory.
    writeFileSync(
      join(repo.backlogDir, 'smoke-task-1.md'),
      buildBlessedTaskSpec(BLESSED_TASK_1, repo.repoRoot),
    );
    writeFileSync(
      join(repo.backlogDir, 'smoke-task-2.md'),
      buildBlessedTaskSpec(BLESSED_TASK_2, repo.repoRoot),
    );

    // Seed the managed-worker dispatch baseline (no master session needed).
    // Task 2 depends_on task 1 to enforce sequential dispatch order.
    seedManagedWorkerBaseline(
      repo.stateDir,
      [
        { ref: BLESSED_TASK_1.ref, title: BLESSED_TASK_1.title },
        { ref: BLESSED_TASK_2.ref, title: BLESSED_TASK_2.title, depends_on: [BLESSED_TASK_1.ref] },
      ],
      { provider: 'codex' },
    );

    // Start the real coordinator. It will dispatch task 1 on its first tick.
    coordinator = await startCoordinator(runtimeEnv, {
      startupTimeoutMs: COORDINATOR_STARTUP_MS,
      tickIntervalMs: COORDINATOR_TICK_MS,
    });
  }, COORDINATOR_STARTUP_MS + 10_000);

  afterAll(async () => {
    if (coordinator) {
      console.log('[codex-smoke] coordinator FULL stdout:\n' + coordinator.stdout());
      console.log('[codex-smoke] coordinator FULL stderr:\n' + coordinator.stderr());
    }
    await coordinator?.stop();
    repo?.cleanup();
  });

  it(
    'dispatches and completes two sequential blessed-path tasks with a real Codex worker',
    async ({ skip }) => {
      if (providerSkipped) {
        skip();
        return;
      }

      // ── Task 1 completion ───────────────────────────────────────────────
      await waitForTaskStatus(repo.stateDir, BLESSED_TASK_1.ref, 'done', {
        stage: 'task_1_completion',
        timeoutMs: TASK_TIMEOUT_MS,
      });

      // ── Task 2 completion ───────────────────────────────────────────────
      // Task 2 depends on task 1 being done — coordinator dispatches it next.
      await waitForTaskStatus(repo.stateDir, BLESSED_TASK_2.ref, 'done', {
        stage: 'task_2_completion',
        timeoutMs: TASK_TIMEOUT_MS,
      });

      // ── Worker reuse ────────────────────────────────────────────────────
      // The same agent slot (orc-1) must have emitted run_started for both runs.
      await waitForWorkerReuse(repo.stateDir, 'orc-1', {
        stage: 'worker_reuse',
        timeoutMs: WORKER_REUSE_TIMEOUT_MS,
      });

      // ── Path containment ────────────────────────────────────────────────
      // All coordinator-managed paths must remain inside the temp repo.
      assertRuntimePathsInside(repo.stateDir, repo.repoRoot);
    },
    OVERALL_TIMEOUT_MS,
  );
});
