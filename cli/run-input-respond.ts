#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { appendSequencedEvent, queryEvents } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { storeDrawer, wingFromTaskRef } from '../lib/memoryStore.ts';
import { bridgeInputResponse } from '../lib/messageBridge.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const response = flag('response');
const actorId = flag('actor-id') ?? 'master';
const requestedId = flag('request-id');

if (!runId || !agentId || !response) {
  console.error('Usage: orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>]');
  process.exit(1);
}

function readLatestInputRequest(currentRunId: string, currentAgentId: string): Record<string, unknown> | null {
  try {
    const events = queryEvents(STATE_DIR, {
      run_id: currentRunId,
      agent_id: currentAgentId,
      event_type: 'input_requested',
    });
    const reversed = [...events].reverse();
    return (reversed.find((event) =>
      typeof (event.payload as Record<string, unknown>)?.question === 'string',
    ) as unknown as Record<string, unknown> | null) ?? null;
  } catch {
    return null;
  }
}

const latestRequest = readLatestInputRequest(runId, agentId);
const latestPayload = latestRequest?.payload as Record<string, unknown> | undefined;
const latestQuestion = typeof latestPayload?.question === 'string' ? latestPayload.question : null;
const latestRequestId = typeof latestPayload?.request_id === 'string' ? latestPayload.request_id : null;

let messageId: string | null;
try {
  messageId = bridgeInputResponse(STATE_DIR, runId, agentId, response, requestedId ?? latestRequestId);
  if (requestedId && !messageId) throw new Error('Input request is not pending for this run');
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

appendSequencedEvent(STATE_DIR, {
  ts: new Date().toISOString(),
  event: 'input_response',
  actor_type: 'human',
  actor_id: actorId,
  run_id: runId,
  task_ref: latestRequest?.task_ref as string | undefined,
  agent_id: agentId,
  payload: {
    response,
    question: latestQuestion,
    request_id: requestedId ?? latestRequestId,
    message_id: messageId,
  },
});

console.log(`input_response: ${runId} (${agentId})`);

const taskRef = latestRequest?.task_ref as string | undefined;
try {
  storeDrawer(STATE_DIR, {
    wing: wingFromTaskRef(taskRef ?? ''),
    hall: 'decisions', room: 'master-input',
    content: `Q: ${latestQuestion ?? '(unknown)'}\nA: ${response}`,
    importance: 7, sourceType: 'event', sourceRef: runId,
  });
} catch { /* memory system not initialized — silently skip */ }
