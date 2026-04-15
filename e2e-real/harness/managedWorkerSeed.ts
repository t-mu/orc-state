/**
 * e2e-real/harness/managedWorkerSeed.ts
 *
 * Seeds the exact coordinator/runtime state needed for task-scoped worker
 * dispatch in the temp repo. The coordinator should pick up these seeds on its
 * first tick and launch a real worker session without needing a master session.
 *
 * This mirrors the blessed coordinator dispatch path:
 *   - agents.json starts empty; workers are registered dynamically at dispatch
 *   - backlog.json has the provided tasks as `todo` + `ready_for_dispatch`
 *   - claims.json is empty
 *   - events.db is initialized
 *
 * Invariant: no master-only state is seeded.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../types/backlog.ts';
import { initEventsDb } from '../../lib/eventLog.ts';
import { atomicWriteJson } from '../../lib/atomicWrite.ts';

export interface SeedOptions {
  /** Provider retained for call-site compatibility (default: 'claude'). */
  provider?: string;
  /** Feature ref to group tasks under (default: 'smoke'). */
  featureRef?: string;
}

/**
 * Seed the task-scoped worker dispatch baseline into `stateDir`.
 *
 * After seeding, the coordinator can be started against the temp repo and it
 * will take the managed dispatch path on its first tick.
 */
export function seedManagedWorkerBaseline(
  stateDir: string,
  tasks: (Pick<Task, 'ref' | 'title'> & { depends_on?: string[] })[],
  options: SeedOptions = {},
): void {
  const { provider: _provider = 'claude', featureRef = 'smoke' } = options;

  mkdirSync(stateDir, { recursive: true });

  atomicWriteJson(join(stateDir, 'agents.json'), {
    version: '1',
    agents: [],
  });

  // Backlog tasks: ready for dispatch, preserving depends_on for sequential dispatch
  const backlogTasks = tasks.map((t) => ({
    ref: t.ref,
    title: t.title,
    status: 'todo',
    planning_state: 'ready_for_dispatch',
    task_type: 'implementation',
    ...(t.depends_on != null && t.depends_on.length > 0 ? { depends_on: t.depends_on } : {}),
  }));

  atomicWriteJson(join(stateDir, 'backlog.json'), {
    version: '1',
    features: [
      {
        ref: featureRef,
        title: featureRef.charAt(0).toUpperCase() + featureRef.slice(1),
        tasks: backlogTasks,
      },
    ],
  });

  // Empty claims
  atomicWriteJson(join(stateDir, 'claims.json'), { version: '1', claims: [] });

  // Initialize events DB
  initEventsDb(stateDir);
}
