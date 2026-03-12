#!/usr/bin/env node
/**
 * cli/clear-workers.ts
 * Usage: node cli/clear-workers.ts
 *
 * Removes workers that are definitely stale (offline status or dead heartbeat).
 * Uses adapter.heartbeatProbe() - works with any adapter implementation.
 */
import { listAgents, removeAgent } from '../lib/agentRegistry.ts';
import { createAdapter } from '../adapters/index.ts';
import { STATE_DIR } from '../lib/paths.ts';

const workers = listAgents(STATE_DIR);
let removedOffline = 0;
let removedStale = 0;

for (const worker of workers) {
  if (worker.status === 'offline') {
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
console.log(`Worker clearall complete. Removed ${totalRemoved} worker(s).`);
console.log(`  offline removed: ${removedOffline}`);
console.log(`  stale removed:   ${removedStale}`);
