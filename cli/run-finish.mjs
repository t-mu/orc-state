#!/usr/bin/env node
import { finishRun } from '../lib/claimManager.mjs';
import { recordAgentActivity } from '../lib/agentActivity.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-finish --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  finishRun(STATE_DIR, runId, agentId, { success: true });
  recordAgentActivity(STATE_DIR, agentId);
  console.log(`run_finished: ${runId} (${agentId})`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
