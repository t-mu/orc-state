#!/usr/bin/env node
/**
 * cli/gc-workers.mjs
 * Usage: node cli/gc-workers.mjs [--deregister]
 *
 * Checks registered workers with a session_handle and marks unreachable ones
 * offline. With --deregister, removes unreachable workers from agents.json.
 * Uses adapter.heartbeatProbe() - works with any adapter implementation.
 */
import { listAgents, updateAgentRuntime, removeAgent } from '../lib/agentRegistry.mjs';
import { createAdapter } from '../adapters/index.mjs';
import { STATE_DIR } from '../lib/paths.mjs';

const deregister = process.argv.includes('--deregister');
const workers = listAgents(STATE_DIR);
let offlineCount = 0;
let removedCount = 0;

for (const worker of workers) {
  if (!worker.session_handle) continue;
  try {
    const adapter = createAdapter(worker.provider);
    const alive = await adapter.heartbeatProbe(worker.session_handle);
    if (alive) continue;

    if (deregister) {
      removeAgent(STATE_DIR, worker.agent_id);
      removedCount++;
      continue;
    }

    updateAgentRuntime(STATE_DIR, worker.agent_id, {
      status: 'offline',
      session_handle: null,
      provider_ref: null,
      last_status_change_at: new Date().toISOString(),
    });
    offlineCount++;
  } catch {
    // Ignore adapter errors in GC to avoid partial failure aborting the pass.
  }
}

if (deregister) {
  console.log(`Worker GC complete. Removed ${removedCount} stale worker(s).`);
} else {
  console.log(`Worker GC complete. Marked ${offlineCount} stale worker(s) offline.`);
}
