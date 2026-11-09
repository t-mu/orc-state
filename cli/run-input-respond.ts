#!/usr/bin/env node
/**
 * cli/run-input-respond.ts
 * Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>] [--json]
 *
 * Answer a worker's input request, as the running master session (its
 * ORC_MASTER_SECRET) or from an operator shell. The project's running
 * coordinator applies it.
 */
import { boolFlag, flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/operatorDispatch.ts';
import { failCommand, printJson } from './shared.ts';
import { USAGE } from './usage.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const response = flag('response');
// Without --actor-id: the master session, or `human` for the operator.
const actorId = flag('actor-id');
const requestedId = flag('request-id');
const json = boolFlag('json');

if (!runId || !agentId || !response) {
  console.error(`Usage: ${USAGE['run-input-respond']}`);
  process.exit(1);
}

const result = await submitOperatorMutation({
  op: 'respond-input', run_id: runId, agent_id: agentId, response, record_memory: true, ...(actorId ? { actor_id: actorId } : {}),
  ...(requestedId ? { request_id: requestedId } : {}),
}).catch((error: unknown) => failCommand(error, json));

if (json) printJson(result);
else console.log(`input_response: ${runId} (${agentId})`);
