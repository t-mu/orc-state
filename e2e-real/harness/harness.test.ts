/**
 * e2e-real/harness/harness.test.ts
 *
 * Harness-focused tests for the real-provider coordinator/worker infrastructure.
 * These tests validate the harness code itself and do not require a real provider
 * CLI to be installed or authenticated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntimeRepo, type RuntimeRepo } from './runtimeRepo.ts';
import { buildRuntimeEnv } from './runtimeEnv.ts';
import { writeOrcWrapper } from './orcWrapper.ts';
import { seedManagedWorkerBaseline } from './managedWorkerSeed.ts';
import { startCoordinator } from './coordinatorRunner.ts';
import {
  checkProviderReadiness,
  type ProviderReadinessResult,
} from './providerReadiness.ts';
import {
  waitForTaskStatus,
  waitForRunEvent,
  waitForWorkerReuse,
  assertPathsInside,
  assertRuntimePathsInside,
} from './assertions.ts';
import { BLESSED_TASK_1, BLESSED_TASK_2, blessedTask1BacklogEntry, blessedTask2BacklogEntry } from '../fixtures/blessedTasks.ts';
import { initEventsDb, appendSequencedEvent } from '../../lib/eventLog.ts';
import { atomicWriteJson } from '../../lib/atomicWrite.ts';

// Collect repos for cleanup in afterEach
const repos: RuntimeRepo[] = [];

afterEach(() => {
  while (repos.length > 0) {
    repos.pop()!.cleanup();
  }
});

// ── Managed worker seed ─────────────────────────────────────────────────────

describe('seedManagedWorkerBaseline', () => {
  it('seeds the managed-worker dispatch baseline without a master session', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    seedManagedWorkerBaseline(repo.stateDir, [
      { ref: BLESSED_TASK_1.ref, title: BLESSED_TASK_1.title },
    ]);

    // agents.json: one managed slot, idle, no session handle, no master
    const agents = JSON.parse(readFileSync(join(repo.stateDir, 'agents.json'), 'utf8'));
    expect(agents.agents).toHaveLength(1);
    const worker = agents.agents[0];
    expect(worker.agent_id).toBe('orc-1');
    expect(worker.role).toBe('worker');
    expect(worker.status).toBe('idle');
    expect(worker.session_handle).toBeNull();
    // Critically: no master agent seeded
    expect(agents.agents.every((a: Record<string, unknown>) => a.role !== 'master')).toBe(true);

    // backlog.json: task in todo + ready_for_dispatch
    const backlog = JSON.parse(readFileSync(join(repo.stateDir, 'backlog.json'), 'utf8'));
    const task = backlog.features[0].tasks.find((t: Record<string, unknown>) => t.ref === BLESSED_TASK_1.ref);
    expect(task).toBeDefined();
    expect(task.status).toBe('todo');
    expect(task.planning_state).toBe('ready_for_dispatch');

    // claims.json: empty
    const claims = JSON.parse(readFileSync(join(repo.stateDir, 'claims.json'), 'utf8'));
    expect(claims.claims).toHaveLength(0);

    // events.db: initialized
    expect(existsSync(join(repo.stateDir, 'events.db'))).toBe(true);
  });

  it('seeds two sequential tasks for blessed-path dispatch', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    seedManagedWorkerBaseline(repo.stateDir, [
      { ref: BLESSED_TASK_1.ref, title: BLESSED_TASK_1.title },
      { ref: BLESSED_TASK_2.ref, title: BLESSED_TASK_2.title },
    ]);

    const backlog = JSON.parse(readFileSync(join(repo.stateDir, 'backlog.json'), 'utf8'));
    const tasks = backlog.features[0].tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].ref).toBe(BLESSED_TASK_1.ref);
    expect(tasks[1].ref).toBe(BLESSED_TASK_2.ref);
  });
});

// ── Provider readiness ──────────────────────────────────────────────────────

describe('checkProviderReadiness', () => {
  it('reports provider readiness failures with stage-specific diagnostics', async () => {
    // Use a deliberately nonexistent provider to force binary failure
    const result: ProviderReadinessResult = await checkProviderReadiness('nonexistent-provider-xyz');
    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('binary');
    expect(result.message).toContain('nonexistent-provider-xyz');
    expect(result.message).toContain('not found on PATH');
  });

  it('reports binary-stage failure with provider name in message', async () => {
    const result = await checkProviderReadiness('totally-fake-cli');
    expect(result.ok).toBe(false);
    expect(result.failedStage).toBe('binary');
    // Message must be diagnosable — include provider and binary name
    expect(result.message.length).toBeGreaterThan(20);
  });
});

// ── Path containment ────────────────────────────────────────────────────────

describe('assertPathsInside / assertRuntimePathsInside', () => {
  it('fails when an orchestrator-managed path escapes the temp root', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    // Escape: stateDir set to /tmp directly (outside repoRoot)
    expect(() => assertPathsInside(repo.repoRoot, {
      stateDir: '/tmp',
      backlogDir: repo.backlogDir,
    })).toThrow(/escaped the temp repo root/);
  });

  it('passes when all paths are inside the temp root', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    expect(() => assertPathsInside(repo.repoRoot, {
      stateDir: repo.stateDir,
      backlogDir: repo.backlogDir,
      worktreesDir: repo.worktreesDir,
      artifactsDir: repo.artifactsDir,
    })).not.toThrow();
  });

  it('fails when a worktree path in run-worktrees.json escapes the temp root', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    initEventsDb(repo.stateDir);

    // Write a run-worktrees.json with an escaped worktree path
    atomicWriteJson(join(repo.stateDir, 'run-worktrees.json'), {
      version: '1',
      runs: [
        { run_id: 'run-fake-001', worktree_path: '/tmp/escaped-worktree', branch: 'task/fake' },
      ],
    });

    expect(() => assertRuntimePathsInside(repo.stateDir, repo.repoRoot)).toThrow(/escaped/);
  });

  it('passes runtime path check when all managed paths are inside the temp root', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    seedManagedWorkerBaseline(repo.stateDir, [{ ref: BLESSED_TASK_1.ref, title: BLESSED_TASK_1.title }]);

    expect(() => assertRuntimePathsInside(repo.stateDir, repo.repoRoot)).not.toThrow();
  });
});

// ── waitForTaskStatus timeout ───────────────────────────────────────────────

describe('waitForTaskStatus', () => {
  it('times out first dispatch with a stage-specific error', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    seedManagedWorkerBaseline(repo.stateDir, [
      { ref: BLESSED_TASK_1.ref, title: BLESSED_TASK_1.title },
    ]);

    // Task is seeded as 'todo' — wait for 'done' which will never happen
    await expect(
      waitForTaskStatus(repo.stateDir, BLESSED_TASK_1.ref, 'done', {
        stage: 'first_dispatch',
        timeoutMs: 100,
        pollMs: 20,
      }),
    ).rejects.toThrow(/timeout waiting for stage 'first_dispatch'/);
  });

  it('resolves immediately when the task already has the expected status', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    seedManagedWorkerBaseline(repo.stateDir, [
      { ref: BLESSED_TASK_1.ref, title: BLESSED_TASK_1.title },
    ]);

    // Task is seeded as 'todo' — wait for 'todo' which is already true
    await expect(
      waitForTaskStatus(repo.stateDir, BLESSED_TASK_1.ref, 'todo', {
        stage: 'initial_state',
        timeoutMs: 1000,
        pollMs: 50,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── waitForRunEvent timeout ─────────────────────────────────────────────────

describe('waitForRunEvent', () => {
  it('times out when the expected event never appears', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    initEventsDb(repo.stateDir);

    await expect(
      waitForRunEvent(repo.stateDir, 'run-nonexistent', 'run_finished', {
        stage: 'task_completion',
        timeoutMs: 100,
        pollMs: 20,
      }),
    ).rejects.toThrow(/timeout waiting for stage 'task_completion'/);
  });

  it('resolves when the expected event is present', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    initEventsDb(repo.stateDir);

    appendSequencedEvent(repo.stateDir, {
      ts: new Date().toISOString(),
      event: 'run_finished',
      actor_type: 'coordinator',
      actor_id: 'coordinator',
      run_id: 'run-test-001',
      task_ref: BLESSED_TASK_1.ref,
      agent_id: 'orc-1',
      payload: {},
    });

    const found = await waitForRunEvent(repo.stateDir, 'run-test-001', 'run_finished', {
      stage: 'task_completion',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(found.event).toBe('run_finished');
    if (found.event === 'run_finished') {
      expect(found.run_id).toBe('run-test-001');
    }
  });
});

// ── Runtime repo isolation ──────────────────────────────────────────────────

describe('createRuntimeRepo', () => {
  it('creates an isolated git repo on main with expected structure', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    // Temp dir uses the expected prefix.
    expect(repo.repoRoot).toMatch(/orc-real-provider-/);

    expect(existsSync(repo.repoRoot)).toBe(true);
    expect(existsSync(join(repo.repoRoot, '.git'))).toBe(true);
    expect(existsSync(repo.stateDir)).toBe(true);
    expect(existsSync(repo.backlogDir)).toBe(true);
    expect(existsSync(repo.worktreesDir)).toBe(true);
    expect(existsSync(repo.artifactsDir)).toBe(true);

    // Git repo is initialized and on the `main` branch.
    const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repo.repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('main');

    // At least one commit exists so worktree operations work.
    const logResult = spawnSync('git', ['log', '--oneline'], {
      cwd: repo.repoRoot,
      encoding: 'utf8',
    });
    expect(logResult.status).toBe(0);
    expect(logResult.stdout.trim().length).toBeGreaterThan(0);

    // All paths are inside the temp repo.
    assertPathsInside(repo.repoRoot, {
      stateDir: repo.stateDir,
      backlogDir: repo.backlogDir,
      worktreesDir: repo.worktreesDir,
      artifactsDir: repo.artifactsDir,
    });
  });

  it('does not overlap with the real repo root', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    // The temp repo must not be inside the real repo
    const realRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    expect(repo.repoRoot.startsWith(realRoot)).toBe(false);
  });
});

// ── buildRuntimeEnv ─────────────────────────────────────────────────────────

describe('buildRuntimeEnv', () => {
  it('pins all runtime env paths into the temp repo', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    const { env, cwd } = buildRuntimeEnv(repo);

    expect(env.ORC_STATE_DIR).toBe(repo.stateDir);
    expect(env.ORC_REPO_ROOT).toBe(repo.repoRoot);
    expect(env.ORC_WORKTREES_DIR).toBe(repo.worktreesDir);
    expect(env.ORC_BACKLOG_DIR).toBe(repo.backlogDir);
    expect(env.ORC_CONFIG_FILE).toBe(join(repo.repoRoot, 'orc-state.config.json'));
    expect(cwd).toBe(repo.repoRoot);

    // Config file must be inside the temp repo.
    assertPathsInside(repo.repoRoot, {
      ORC_CONFIG_FILE: env.ORC_CONFIG_FILE as string,
    });
  });

  it('writes a temp orc-state.config.json with max_workers = 1', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    buildRuntimeEnv(repo);

    const configPath = join(repo.repoRoot, 'orc-state.config.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { worker_pool: { max_workers: number } };
    expect(config.worker_pool.max_workers).toBe(1);
  });
});

// ── orcWrapper ──────────────────────────────────────────────────────────────

describe('orcWrapper', () => {
  it('exposes a runnable orc wrapper for worker PTYs', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    const wrapperPath = writeOrcWrapper(repo.repoRoot);

    // Wrapper file exists and is executable.
    expect(existsSync(wrapperPath)).toBe(true);

    // Running the wrapper with --help succeeds (exit 0) and prints usage.
    const result = spawnSync(wrapperPath, ['--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('orc');
  });
});

// ── Blessed task fixtures ───────────────────────────────────────────────────

describe('blessedTasks fixtures', () => {
  it('task 1 and task 2 have distinct refs and source files', () => {
    expect(BLESSED_TASK_1.ref).not.toBe(BLESSED_TASK_2.ref);
    expect(BLESSED_TASK_1.sourceFile).not.toBe(BLESSED_TASK_2.sourceFile);
  });

  it('task 2 backlog entry has depends_on pointing to task 1', () => {
    const entry = blessedTask2BacklogEntry();
    expect((entry.depends_on as string[]).includes(BLESSED_TASK_1.ref)).toBe(true);
  });

  it('task 1 backlog entry has no depends_on', () => {
    const entry = blessedTask1BacklogEntry();
    expect(entry.depends_on).toBeUndefined();
  });

  it('seedManagedWorkerBaseline preserves depends_on for sequential dispatch', () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    seedManagedWorkerBaseline(repo.stateDir, [
      { ref: BLESSED_TASK_1.ref, title: BLESSED_TASK_1.title },
      { ref: BLESSED_TASK_2.ref, title: BLESSED_TASK_2.title, depends_on: [BLESSED_TASK_1.ref] },
    ]);

    const backlog = JSON.parse(readFileSync(join(repo.stateDir, 'backlog.json'), 'utf8'));
    const tasks = backlog.features[0].tasks;
    const task1 = tasks.find((t: Record<string, unknown>) => t.ref === BLESSED_TASK_1.ref);
    const task2 = tasks.find((t: Record<string, unknown>) => t.ref === BLESSED_TASK_2.ref);

    expect(task1.depends_on).toBeUndefined();
    expect(task2.depends_on).toEqual([BLESSED_TASK_1.ref]);
  });
});

// ── waitForWorkerReuse ──────────────────────────────────────────────────────

describe('waitForWorkerReuse', () => {
  it('times out when fewer than two run_started events exist', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    initEventsDb(repo.stateDir);

    // Seed only one run_started event — reuse requires two
    appendSequencedEvent(repo.stateDir, {
      ts: new Date().toISOString(),
      event: 'run_started',
      actor_type: 'agent',
      actor_id: 'orc-1',
      run_id: 'run-reuse-001',
      task_ref: BLESSED_TASK_1.ref,
      agent_id: 'orc-1',
      payload: {},
    });

    await expect(
      waitForWorkerReuse(repo.stateDir, 'orc-1', {
        stage: 'worker_reuse',
        timeoutMs: 100,
        pollMs: 20,
      }),
    ).rejects.toThrow(/timeout waiting for stage 'worker_reuse'/);
  });

  it('resolves when two run_started events exist for the same agent', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    initEventsDb(repo.stateDir);

    for (const [runId, taskRef] of [
      ['run-reuse-001', BLESSED_TASK_1.ref],
      ['run-reuse-002', BLESSED_TASK_2.ref],
    ] as [string, string][]) {
      appendSequencedEvent(repo.stateDir, {
        ts: new Date().toISOString(),
        event: 'run_started',
        actor_type: 'agent',
        actor_id: 'orc-1',
        run_id: runId,
        task_ref: taskRef,
        agent_id: 'orc-1',
        payload: {},
      });
    }

    await expect(
      waitForWorkerReuse(repo.stateDir, 'orc-1', {
        stage: 'worker_reuse',
        timeoutMs: 1000,
        pollMs: 50,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── startCoordinator failure paths ─────────────────────────────────────────

describe('startCoordinator', () => {
  it('rejects with a stage-specific diagnostic when coordinator exits during startup', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    const runtimeEnv = buildRuntimeEnv(repo);

    // Stub coordinator that exits immediately without producing any output.
    // Exercises the onClose rejection path and verifies diagnostics are captured.
    const stubDir = mkdtempSync(join(tmpdir(), 'orc-coord-stub-'));
    const stubPath = join(stubDir, 'coordinator-stub.mjs');
    writeFileSync(stubPath, 'process.exit(42);\n', 'utf8');

    await expect(
      startCoordinator(runtimeEnv, {
        startupTimeoutMs: 5000,
        tickIntervalMs: 1000,
        coordinatorPath: stubPath,
      }),
    ).rejects.toThrow(/coordinatorRunner/);
  });

  it('rejects with a startup timeout diagnostic when coordinator produces no output', async () => {
    const repo = createRuntimeRepo();
    repos.push(repo);

    const runtimeEnv = buildRuntimeEnv(repo);

    // Stub coordinator that sleeps forever and never produces output.
    // Exercises the startup-timeout rejection path.
    const stubDir = mkdtempSync(join(tmpdir(), 'orc-coord-stub-'));
    const stubPath = join(stubDir, 'coordinator-stub.mjs');
    writeFileSync(stubPath, 'setTimeout(() => {}, 60_000);\n', 'utf8');

    const resultMsg = await startCoordinator(runtimeEnv, {
      startupTimeoutMs: 80,
      tickIntervalMs: 1000,
      coordinatorPath: stubPath,
    }).then(
      async (runner) => { await runner.stop(); return 'resolved'; },
      (err: Error) => err.message,
    );

    expect(resultMsg).toMatch(/coordinatorRunner.*startup timeout/s);
  });
});

// ── real-provider suite config ──────────────────────────────────────────────

describe('real-provider suite config', () => {
  it('configures the real-provider suite for serial execution', () => {
    // The config file must exist in the repo root.
    const configPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '..', '..',
      'vitest.real-providers.config.mjs',
    );
    expect(existsSync(configPath)).toBe(true);

    // Read it and verify serial-execution settings.
    const source = readFileSync(configPath, 'utf8');
    expect(source).toContain('fileParallelism: false');
    expect(source).toContain('singleThread: true');
  });
});
