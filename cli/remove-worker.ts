#!/usr/bin/env node
/**
 * cli/remove-worker.ts
 * Usage: node cli/remove-worker.ts <worker_id> [--keep-session]
 */
import { getAgent, removeAgent } from '../lib/agentRegistry.ts';
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
