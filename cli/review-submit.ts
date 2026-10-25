#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { submitLifecycle } from '../lib/lifecycleDispatch.ts';
import { cliError } from './shared.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const outcome = flag('outcome');
const reason = flag('reason');

const VALID_OUTCOMES = ['approved', 'findings'] as const;

if (!runId || !agentId) {
  console.error('Usage: orc review-submit --run-id=<id> --agent-id=<id> --outcome=<approved|findings> --reason=<text>');
  process.exit(1);
}

if (!VALID_OUTCOMES.includes(outcome as never)) {
  console.error(`--outcome must be 'approved' or 'findings', got: ${outcome}`);
  process.exit(1);
}

if (!reason?.trim()) {
  console.error('--reason is required and must not be empty');
  process.exit(1);
}

try {
  const result = await submitLifecycle({
    op: 'review-submit', run_id: runId, agent_id: agentId, outcome: outcome as 'approved' | 'findings', reason,
  });
  console.log(result.message);
} catch (error) {
  cliError(error);
}
