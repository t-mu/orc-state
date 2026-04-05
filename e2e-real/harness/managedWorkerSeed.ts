/**
 * e2e-real/harness/managedWorkerSeed.ts
 *
 * Seeds the exact coordinator/worker runtime state needed for managed-worker
 * dispatch in the temp repo. The coordinator should pick up these seeds on its
 * first tick and launch a real worker session without needing a master session.
 *
 * This mirrors the blessed worker-pool dispatch path:
 *   - agents.json has one managed slot (`orc-1`) in `idle` status
 *   - backlog.json has the provided tasks as `todo` + `ready_for_dispatch`
 *   - claims.json is empty
 *   - events.db is initialized
 *
 * Invariant: no master-only state is seeded.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../../types/backlog.ts';
import type { Agent } from '../../types/agents.ts';
import { initEventsDb } from '../../lib/eventLog.ts';
import { atomicWriteJson } from '../../lib/atomicWrite.ts';

export interface SeedOptions {
  /** Provider to use for the managed worker slot (default: 'claude'). */
  provider?: string;
  /** Feature ref to group tasks under (default: 'smoke'). */
  featureRef?: string;
}

/**
 * Seed the managed-worker dispatch baseline into `stateDir`.
 *
 * After seeding, the coordinator can be started against the temp repo and it
 * will take the managed dispatch path on its first tick.
 */
export function seedManagedWorkerBaseline(
  stateDir: string,
  tasks: (Pick<Task, 'ref' | 'title'> & { depends_on?: string[] })[],
  options: SeedOptions = {},
): void {
  const { provider = 'claude', featureRef = 'smoke' } = options;

  mkdirSync(stateDir, { recursive: true });

  // Managed worker slot: idle, no session handle
  const managedWorker: Agent = {
    agent_id: 'orc-1',
    provider: provider as Agent['provider'],
    model: null,
    dispatch_mode: null,
    role: 'worker',
    capabilities: [],
    status: 'idle',
    session_handle: null,
    session_token: null,
    session_started_at: null,
    session_ready_at: null,
    provider_ref: null,
    last_heartbeat_at: null,
    registered_at: new Date().toISOString(),
  };

  atomicWriteJson(join(stateDir, 'agents.json'), {
    version: '1',
    agents: [managedWorker],
  });

  // Backlog tasks: ready for dispatch (preserve depends_on if provided)
  const backlogTasks = tasks.map((t) => ({
    ref: t.ref,
    title: t.title,
    status: 'todo',
    planning_state: 'ready_for_dispatch',
    task_type: 'implementation',
    ...(t.depends_on ? { depends_on: t.depends_on } : {}),
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
