#!/usr/bin/env node
/**
 * cli/run-input-respond.ts
 * Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>]
 *   [--session-id=<master session id, legacy only>]
 *
 * Answer a worker's input request, as the running master session
 * (its ORC_MASTER_SECRET; its session id, --session-id or ORC_SESSION_ID, in a legacy installation). In a registered project the
 * running coordinator applies it.
 */
import { flag } from '../lib/args.ts';
import { clientCredential, sessionIdFromEnv } from '../lib/sessionCredentials.ts';
import { ACTIVE_PROJECT } from '../lib/paths.ts';
import { submitOperatorMutation } from '../lib/operatorMutations.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const response = flag('response');
// Without --actor-id: the master session in a project, `master` in a legacy installation.
const actorId = flag('actor-id') ?? (ACTIVE_PROJECT ? null : 'master');
const requestedId = flag('request-id');

if (!runId || !agentId || !response) {
  console.error('Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>] [--request-id=<id>] [--session-id=<master session id, legacy only>]');
  process.exit(1);
}

// A project authenticates the master by its secret; a legacy installation by the master's session id.
// --session-token is the older name of --session-id. A session id is a credential only in a legacy installation.
const legacySession = flag('session-id') ?? flag('session-token') ?? sessionIdFromEnv();
const credential = clientCredential() ?? (ACTIVE_PROJECT ? null : legacySession);
try {
  await submitOperatorMutation({
    op: 'respond-input', run_id: runId, agent_id: agentId, response, record_memory: true, ...(actorId ? { actor_id: actorId } : {}),
    ...(requestedId ? { request_id: requestedId } : {}),
  }, { credential, direct: { sessionId: legacySession } });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

console.log(`input_response: ${runId} (${agentId})`);
