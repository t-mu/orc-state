#!/usr/bin/env node
/**
 * cli/remove-worker.mjs
 * Usage: node cli/remove-worker.mjs <worker_id> [--keep-session]
 */
import { getAgent, removeAgent } from '../lib/agentRegistry.mjs';
import { createAdapter } from '../adapters/index.mjs';
import { STATE_DIR } from '../lib/paths.mjs';

const workerId = process.argv[2];
const keepSession = process.argv.includes('--keep-session');

if (!workerId) {
  console.error('Usage: orc-worker-remove <worker_id> [--keep-session]');
  process.exit(1);
}

const worker = getAgent(STATE_DIR, workerId);
if (!worker) {
  console.error(`Worker not found: ${workerId}`);
  process.exit(1);
}

if (worker.session_handle && !keepSession) {
  try {
    const adapter = createAdapter(worker.provider);
    await adapter.stop(worker.session_handle);
  } catch (error) {
    console.error(`Warning: failed stopping session for ${workerId}: ${error.message}`);
  }
}

removeAgent(STATE_DIR, workerId);
console.log(`Removed worker ${workerId}`);
