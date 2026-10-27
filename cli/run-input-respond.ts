#!/usr/bin/env node
/**
 * cli/run-input-respond.ts
 * Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>]
 *
 * Answer a worker's input request. In a registered project the running
 * coordinator applies it; a direct answer (legacy installation, or no
 * coordinator running) must come from the running master session
 * (--session-token or ORC_SESSION_TOKEN).
 */
import { flag } from '../lib/args.ts';
import { submitOperatorMutation } from '../lib/lifecycleDispatch.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const response = flag('response');
const actorId = flag('actor-id') ?? 'master';
const requestedId = flag('request-id');

if (!runId || !agentId || !response) {
  console.error('Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>]');
  process.exit(1);
}

try {
  await submitOperatorMutation({
    op: 'respond-input', run_id: runId, agent_id: agentId, response, actor_id: actorId, record_memory: true,
    ...(requestedId ? { request_id: requestedId } : {}),
  }, { direct: { sessionId: flag('session-token') ?? process.env.ORC_SESSION_TOKEN ?? null } });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`input_response: ${runId} (${agentId})`);
