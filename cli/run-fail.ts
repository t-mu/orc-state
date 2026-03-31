#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { executeRunFail } from '../lib/runCommands.ts';
import { cliError } from './shared.ts';

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
  executeRunFail(runId, agentId, failureReason, failureCode, policy);
} catch (error) {
  cliError(error);
}
