#!/usr/bin/env node
/**
 * cli/remove-worker.ts
 * Usage: node cli/remove-worker.ts <worker_id> [--keep-session]
 *
 * Stops a worker's session (unless --keep-session) and removes its
 * registration. Refuses while the worker holds an active claim.
 */
import { getAgent, removeAgent } from '../lib/agentRegistry.ts';
import { readClaims } from '../lib/stateReader.ts';
import { createAdapter } from '../adapters/index.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { boolFlag } from '../lib/args.ts';
import { formatErrorMessage } from './shared.ts';

const workerId = process.argv[2];
const keepSession = boolFlag('keep-session');

if (!workerId) {
  console.error('Usage: orc worker-remove <worker_id> [--keep-session]');
  process.exit(1);
}

const worker = getAgent(STATE_DIR, workerId);
if (!worker) {
  console.error(`Worker not found: ${workerId}`);
  process.exit(1);
}

// The master is replaced with orc start-session; a scout is the master's, removed with remove_scout.
if (worker.role === 'master' || worker.role === 'scout') {
  console.error(`Cannot remove ${workerId}: it is the ${worker.role}, not a worker${worker.role === 'scout' ? ' (the master removes scouts with remove_scout)' : ''}`);
  process.exit(1);
}

const activeClaim = (readClaims(STATE_DIR).claims ?? []).find((claim) =>
  claim.agent_id === workerId && ['claimed', 'in_progress'].includes(claim.state),
);
if (activeClaim) {
  console.error(`Cannot remove ${workerId}: active claim exists (run_id=${activeClaim.run_id}, state=${activeClaim.state}); cancel or reset its task first`);
  process.exit(1);
}

if (worker.session_handle && !keepSession) {
  try {
    const adapter = createAdapter(worker.provider);
    await adapter.stop(worker.session_handle);
  } catch (error) {
    console.error(`Warning: failed stopping session for ${workerId}: ${formatErrorMessage(error)}`);
  }
}

removeAgent(STATE_DIR, workerId);
console.log(`Removed worker ${workerId}`);
