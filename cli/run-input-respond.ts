#!/usr/bin/env node
import { flag } from '../lib/args.ts';
import { appendSequencedEvent, queryEvents } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const response = flag('response');
const actorId = flag('actor-id') ?? 'master';

if (!runId || !agentId || !response) {
  console.error('Usage: orc-run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>]');
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
    question: (latestRequest?.payload as Record<string, unknown> | undefined)?.question ?? null,
  },
});

console.log(`input_response: ${runId} (${agentId})`);
