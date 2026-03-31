#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
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
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'review_submitted',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    agent_id: agentId,
    payload: { outcome: outcome as 'approved' | 'findings', findings: reason },
  });
  console.log(`review_submitted: run=${runId} agent=${agentId} outcome=${outcome}`);
} catch (error) {
  cliError(error);
}
