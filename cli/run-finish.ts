#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { validateProgressCommandInput } from '../lib/progressValidation.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { loadClaim, cliError } from './shared.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-finish --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'run_finished',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);

  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'run_finished',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {},
  }, { lockStrategy: 'none' });
  console.log(`run_finished: ${runId} (${agentId})`);
} catch (error) {
  cliError(error);
}
