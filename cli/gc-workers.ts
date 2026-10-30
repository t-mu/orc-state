#!/usr/bin/env node
/**
 * cli/gc-workers.ts
 * Usage: node cli/gc-workers.ts
 *
 * Removes workers that are definitely stale (offline or dead status, or a dead heartbeat).
 * A worker that holds an active claim is kept: the coordinator recovers its run.
 * The master and scouts are never touched (scouts are removed with remove_scout).
 * Uses adapter.heartbeatProbe() - works with any adapter implementation.
 */
import { listAgents, removeAgent } from '../lib/agentRegistry.ts';
import { readClaims } from '../lib/stateReader.ts';
import { createAdapter } from '../adapters/index.ts';
import { STATE_DIR } from '../lib/paths.ts';

const claimed = new Set((readClaims(STATE_DIR).claims ?? [])
  .filter((claim) => ['claimed', 'in_progress'].includes(claim.state))
  .map((claim) => claim.agent_id));
const workers = listAgents(STATE_DIR)
  .filter((agent) => agent.role !== 'master' && agent.role !== 'scout' && !claimed.has(agent.agent_id));
let removedOffline = 0;
let removedStale = 0;

for (const worker of workers) {
  if (worker.status === 'offline' || worker.status === 'dead') {
    removeAgent(STATE_DIR, worker.agent_id);
    removedOffline++;
    continue;
  }

  if (!worker.session_handle) {
    continue;
  }

  try {
    const adapter = createAdapter(worker.provider);
    const alive = await adapter.heartbeatProbe(worker.session_handle);
    if (!alive) {
      removeAgent(STATE_DIR, worker.agent_id);
      removedStale++;
    }
  } catch {
    // Treat adapter failure as unknown; do not remove to avoid false positives.
  }
}

const totalRemoved = removedOffline + removedStale;
console.log(`Worker GC complete. Removed ${totalRemoved} worker(s).`);
console.log(`  offline removed: ${removedOffline}`);
console.log(`  stale removed:   ${removedStale}`);
