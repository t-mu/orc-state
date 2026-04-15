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
 *   - Coordinator dispatches task-scoped workers for both sequential tasks
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
  waitForWorkerDispatches,
  assertRuntimePathsInside,
} from './harness/assertions.ts';
import {
  BLESSED_TASK_1,
  BLESSED_TASK_2,
  buildBlessedTaskSpec,
} from './fixtures/blessedTasks.ts';

// Codex can be enabled separately: RUN_REAL_PROVIDERS=1 runs both providers,
// RUN_REAL_PROVIDERS_CODEX=1 runs only Codex. Codex takes longer than Claude
// for the full phased workflow and may be less reliable with sub-agent reviews.
const ENABLED = process.env.RUN_REAL_PROVIDERS === '1' || process.env.RUN_REAL_PROVIDERS_CODEX === '1';

// Per-task completion timeout: 15 minutes — Codex is slower than Claude for
// the full phased workflow, especially sub-agent review spawning.
const TASK_TIMEOUT_MS = 900_000;

// Worker dispatch check timeout: short since this is checked after both tasks done.
const WORKER_DISPATCH_TIMEOUT_MS = 10_000;

// Coordinator startup timeout: 30 seconds.
const COORDINATOR_STARTUP_MS = 30_000;

// Coordinator tick interval during tests: 3 seconds.
const COORDINATOR_TICK_MS = 3_000;

// Overall test timeout: enough for 2 sequential tasks + startup/teardown.
const OVERALL_TIMEOUT_MS = 2_100_000;

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
      join(repo.backlogDir, BLESSED_TASK_1.specFile),
      buildBlessedTaskSpec(BLESSED_TASK_1, repo.repoRoot),
    );
    writeFileSync(
      join(repo.backlogDir, BLESSED_TASK_2.specFile),
      buildBlessedTaskSpec(BLESSED_TASK_2, repo.repoRoot),
    );
    repo.commitAll('chore: add smoke backlog specs');

    // Seed the task-scoped worker dispatch baseline (no master session needed).
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

      // ── Worker dispatches ───────────────────────────────────────────────
      // Each blessed task must have produced a run_started event.
      await waitForWorkerDispatches(repo.stateDir, [BLESSED_TASK_1.ref, BLESSED_TASK_2.ref], {
        stage: 'worker_dispatches',
        timeoutMs: WORKER_DISPATCH_TIMEOUT_MS,
      });

      // ── Path containment ────────────────────────────────────────────────
      // All coordinator-managed paths must remain inside the temp repo.
      assertRuntimePathsInside(repo.stateDir, repo.repoRoot);
    },
    OVERALL_TIMEOUT_MS,
  );
});
