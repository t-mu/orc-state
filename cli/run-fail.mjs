#!/usr/bin/env node
import { finishRun } from '../lib/claimManager.mjs';
import { recordAgentActivity } from '../lib/agentActivity.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';

const runId = flag('run-id');
const agentId = flag('agent-id');
const failureReason = flag('reason') ?? 'worker reported failure';
const failureCode = flag('code') ?? 'ERR_WORKER_REPORTED_FAILURE';
const policy = flag('policy') ?? 'requeue';

const VALID_POLICIES = ['requeue', 'block'];
if (!VALID_POLICIES.includes(policy)) {
  console.error(`Invalid policy: ${policy}. Must be one of: ${VALID_POLICIES.join(', ')}`);
  process.exit(1);
}

if (!runId || !agentId) {
  console.error('Usage: orc-run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--code=<code>] [--policy=requeue|block]');
  process.exit(1);
}

try {
  finishRun(STATE_DIR, runId, agentId, {
    success: false,
    failureReason,
    failureCode,
    policy,
  });
  recordAgentActivity(STATE_DIR, agentId);
  console.log(`run_failed: ${runId} (${agentId}) reason=${failureReason}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
