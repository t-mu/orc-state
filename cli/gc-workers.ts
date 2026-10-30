#!/usr/bin/env node
/**
 * cli/gc-workers.ts
 * Usage: node cli/gc-workers.ts
 *
 * Removes offline and dead worker records. A running coordinator removes these
 * itself (along with workers whose session exited), so this covers the case
 * where no coordinator is running.
 * A worker that holds an active claim is kept: the coordinator recovers its run.
 * The master and scouts are never touched (scouts are removed with remove_scout).
 */
import { listAgents, removeAgent } from '../lib/agentRegistry.ts';
import { readClaims } from '../lib/stateReader.ts';
import { assertProjectMode, STATE_DIR } from '../lib/paths.ts';
import { cliError } from './shared.ts';

try {
  assertProjectMode();
} catch (error) {
  cliError(error);
}

const claimed = new Set((readClaims(STATE_DIR).claims ?? [])
  .filter((claim) => ['claimed', 'in_progress'].includes(claim.state))
  .map((claim) => claim.agent_id));
const workers = listAgents(STATE_DIR)
  .filter((agent) => agent.role !== 'master' && agent.role !== 'scout' && !claimed.has(agent.agent_id));
let removed = 0;

for (const worker of workers) {
  if (worker.status === 'offline' || worker.status === 'dead') {
    removeAgent(STATE_DIR, worker.agent_id);
    removed++;
  }
}

console.log(`Worker GC complete. Removed ${removed} worker(s).`);
