import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { closeProjectTaskStores, initProjectTaskStore, prepareProjectTask, refreshBacklogProjection } from '../lib/projectTasks.ts';
import type { TaskDispatchState } from '../lib/projectTaskStore.ts';
import { readBacklog as readProjectStateBacklog } from '../lib/stateReader.ts';
import type { TaskStatus } from '../types/backlog.ts';

export function createTempStateDir(prefix = 'orch-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export const TEST_PROJECT_ID = 'test-project';

/**
 * Marks a temp state directory as a registered project's (its project.json descriptor) and returns
 * the environment that selects it without a registry. Entry points refuse to run anything else.
 */
export function bridgeProjectEnv(dir: string, targetRepoRoot: string = dir): { ORC_PROJECT_ID: string; ORC_STATE_DIR: string } {
  writeFileSync(join(dir, 'project.json'), `${JSON.stringify({ id: TEST_PROJECT_ID, name: 'test', target_repo_root: targetRepoRoot }, null, 2)}\n`);
  return { ORC_PROJECT_ID: TEST_PROJECT_ID, ORC_STATE_DIR: dir };
}

export function cleanupTempStateDir(dir: string): void {
  closeProjectTaskStores();
  rmSync(dir, { recursive: true, force: true });
}

/** A task as tests describe it: the legacy backlog task shape. */
export type SeedTask = Record<string, unknown> & { ref: string; title?: string; status?: string };

/**
 * Makes `dir` a project state directory (descriptor and task store) and creates
 * each task in the project task store (runtime.db), with its status
 * reached through store transitions: claimed/in_progress tasks are claimed by
 * the seeded claim for their ref (or a synthetic run), any other status is
 * the task's first transition as a migration import would record it.
 */
export function seedProjectTasks(dir: string, tasks: readonly SeedTask[], claims: readonly unknown[] = []): void {
  bridgeProjectEnv(dir);
  const store = initProjectTaskStore(dir);
  store.inTransaction(() => {
    for (const task of tasks) {
      const slash = task.ref.indexOf('/');
      if (slash < 1) throw new Error(`Seeded task ref must be feature/slug: ${task.ref}`);
      const { spec } = prepareProjectTask(store, {
        feature: typeof task.feature === 'string' ? task.feature : task.ref.slice(0, slash),
        ref: task.ref.slice(slash + 1),
        title: task.title ?? task.ref,
        task_type: task.task_type, priority: task.priority, description: task.description,
        acceptance_criteria: task.acceptance_criteria, depends_on: task.depends_on,
        required_provider: task.required_provider,
        model: task.model, review_level: task.review_level, merge_strategy: task.merge_strategy,
      });
      store.createTask({ ...spec, ...(typeof task.created_at === 'string' ? { createdAt: task.created_at } : {}) });
      const status = (task.status ?? 'todo') as TaskStatus;
      if (status === 'claimed' || status === 'in_progress') {
        const claim = (claims as Array<Record<string, unknown>>).find((entry) => entry.task_ref === task.ref
          && (entry.state === 'claimed' || entry.state === 'in_progress'));
        const runId = typeof claim?.run_id === 'string' ? claim.run_id : `run-seed-${task.ref.replace(/[^a-z0-9]+/g, '-')}`;
        const agentId = typeof claim?.agent_id === 'string' ? claim.agent_id : null;
        store.applyTransition(task.ref, { cause: 'claim', to: 'claimed', runId, actorId: agentId });
        store.bindRun(runId, task.ref, agentId);
        if (status === 'in_progress') store.applyTransition(task.ref, { cause: 'run_start', to: 'in_progress', runId, actorId: agentId });
      } else if (status !== 'todo') {
        store.applyTransition(task.ref, {
          cause: 'migration_import', to: status, actorId: 'human',
          reason: typeof task.blocked_reason === 'string' ? task.blocked_reason : 'seeded test fixture',
        });
      }
      const dispatch: Partial<TaskDispatchState> & { attemptCount?: number } = {
        owner: typeof task.owner === 'string' ? task.owner : null,
        planningState: (task.planning_state ?? null) as TaskDispatchState['planningState'],
        delegatedBy: typeof task.delegated_by === 'string' ? task.delegated_by : null,
        requeueEligibleAfter: typeof task.requeue_eligible_after === 'string' ? task.requeue_eligible_after : null,
      };
      if (typeof task.attempt_count === 'number') dispatch.attemptCount = task.attempt_count;
      store.setDispatchState(task.ref, dispatch);
    }
  });
  refreshBacklogProjection(dir);
}

/**
 * Records the coordinator's merge confirmation for an in_progress task: the
 * only way a project task becomes done.
 */
export function recordMergeConfirmation(dir: string, taskRef: string): void {
  const store = initProjectTaskStore(dir);
  store.transition(taskRef, 'merge_succeeded', 'done');
  refreshBacklogProjection(dir);
}

/**
 * Writes a minimal valid project state directory: the project task store
 * (runtime.db) holding the seeded tasks, agents.json, claims.json, and an
 * empty events.jsonl.
 */
export function seedState(
  dir: string,
  options: { tasks?: unknown[]; claims?: unknown[]; agents?: unknown[] } = {}
): void {
  const { tasks = [], claims = [], agents = [] } = options;
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
  seedProjectTasks(dir, tasks as SeedTask[], claims);
}

export function readStateFile<T = unknown>(dir: string, filename: string): T {
  return JSON.parse(readFileSync(join(dir, filename), 'utf8')) as T;
}

// ---------------------------------------------------------------------------
// State assertion helpers for coordinator tests
// ---------------------------------------------------------------------------

export function readAgents(dir: string): Array<Record<string, unknown>> {
  return readStateFile<{ agents: Array<Record<string, unknown>> }>(dir, 'agents.json').agents;
}

export function readClaims(dir: string): Array<Record<string, unknown>> {
  return readStateFile<{ claims: Array<Record<string, unknown>> }>(dir, 'claims.json').claims;
}

/** The project's tasks in the backlog shape, read from the project task store. */
export function readBacklog(dir: string): { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> } {
  return readProjectStateBacklog(dir) as unknown as { features: Array<{ ref?: string; tasks: Array<Record<string, unknown>> }> };
}

// ---------------------------------------------------------------------------
// Mock factories for coordinator tests
// ---------------------------------------------------------------------------

/**
 * Returns a mock module object for './adapters/index.ts'.
 * Pass overrides to replace specific adapter methods; all others get sensible defaults.
 *
 * Usage:
 *   vi.doMock('./adapters/index.ts', () => makeAdapterMock({ start: mockStart, send: mockSend }));
 */
export function makeAdapterMock(overrides: Record<string, unknown> = {}): { createAdapter: () => Record<string, unknown> } {
  return {
    createAdapter: () => ({
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      start: vi.fn().mockResolvedValue({ session_handle: 'tmux:default', provider_ref: null }),
      send: vi.fn().mockResolvedValue(''),
      stop: vi.fn().mockResolvedValue(undefined),
      attach: vi.fn().mockResolvedValue(''),
      getOutputTail: vi.fn().mockReturnValue(null),
      ...overrides,
    }),
  };
}

/**
 * Returns a mock module object for './lib/runWorktree.ts'.
 * Pass overrides to replace specific functions.
 *
 * Usage:
 *   vi.doMock('./lib/runWorktree.ts', () => makeRunWorktreeMock());
 *   vi.doMock('./lib/runWorktree.ts', () => makeRunWorktreeMock({
 *     getRunWorktree: vi.fn().mockReturnValue({ branch: 'task/foo', worktree_path: '/tmp/foo' }),
 *   }));
 */
export function makeRunWorktreeMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ensureRunWorktree: vi.fn().mockReturnValue({
      run_id: 'run-allocated',
      branch: 'task/run-allocated',
      worktree_path: '/tmp/orc-worktrees/run-allocated',
    }),
    cleanupRunWorktree: vi.fn().mockReturnValue(true),
    deleteRunWorktree: vi.fn().mockReturnValue(true),
    pruneMissingRunWorktrees: vi.fn().mockReturnValue(0),
    getRunWorktree: vi.fn().mockReturnValue(null),
    ...overrides,
  };
}
