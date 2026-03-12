#!/usr/bin/env node
import { heartbeat } from '../lib/claimManager.mjs';
import { recordAgentActivity } from '../lib/agentActivity.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-heartbeat --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  const { lease_expires_at: leaseExpiresAt } = heartbeat(STATE_DIR, runId, agentId);
  recordAgentActivity(STATE_DIR, agentId);
  console.log(`heartbeat: ${runId} (lease until ${leaseExpiresAt})`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
