#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { validateProgressInput } from '../lib/progressValidation.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { loadClaim, cliError } from './shared.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-heartbeat --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressInput({
    event: 'heartbeat',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);

  if (validatedClaim.lease_expires_at && new Date(validatedClaim.lease_expires_at) < new Date()) {
    console.error(`Error: Lease for run ${runId} has already expired at ${validatedClaim.lease_expires_at}. The task may have been requeued.`);
    process.exit(1);
  }

  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'heartbeat',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {},
  }, { lockStrategy: 'none' });
  console.log(`heartbeat: ${runId} (${agentId})`);
} catch (error) {
  cliError(error);
}
