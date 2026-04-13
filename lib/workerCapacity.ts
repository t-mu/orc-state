import type { Agent } from '../types/agents.ts';

export interface WorkerCapacity {
  max: number;
  active: number;
  available: number;
}

/**
 * Compute worker capacity from the live agent registry.
 *
 * `active` is the count of all registered worker agents — any worker present in
 * agents.json is a live session that consumes a concurrency slot, including
 * workers that are booting or have not yet emitted run-start.
 *
 * `available` is how many additional workers may be dispatched before the pool
 * is full.
 */
export function computeWorkerCapacity(agents: Agent[], maxWorkers: number): WorkerCapacity {
  const active = agents.filter((a) => a.role === 'worker').length;
  return {
    max: maxWorkers,
    active,
    available: Math.max(0, maxWorkers - active),
  };
}
