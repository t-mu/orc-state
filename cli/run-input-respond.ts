#!/usr/bin/env node
/**
 * cli/run-input-respond.ts
 * Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>]
 *
 * Answer a worker's input request, as the running master session (its
 * ORC_MASTER_SECRET). The project's running coordinator applies it.
 */
import { flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const response = flag('response');
// Without --actor-id: the master session.
const actorId = flag('actor-id');
const requestedId = flag('request-id');

if (!runId || !agentId || !response) {
  console.error('Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>]');
  process.exit(1);
}

try {
  await submitOperatorMutation({
    op: 'respond-input', run_id: runId, agent_id: agentId, response, record_memory: true, ...(actorId ? { actor_id: actorId } : {}),
    ...(requestedId ? { request_id: requestedId } : {}),
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`input_response: ${runId} (${agentId})`);
