#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flag } from '../lib/args.mjs';
import { appendSequencedEvent } from '../lib/eventLog.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { setRunInputState } from '../lib/claimManager.mjs';

const runId = flag('run-id');
const agentId = flag('agent-id');
const response = flag('response');
const actorId = flag('actor-id') ?? 'master';

if (!runId || !agentId || !response) {
  console.error('Usage: orc-run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>]');
  process.exit(1);
}

function readLatestInputRequest(currentRunId, currentAgentId) {
  try {
    const raw = readFileSync(join(STATE_DIR, 'events.jsonl'), 'utf8').trim();
    if (!raw) return null;
    const events = raw.split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .reverse();
    return events.find((event) =>
      event.event === 'input_requested'
      && event.run_id === currentRunId
      && event.agent_id === currentAgentId
      && typeof event.payload?.question === 'string');
  } catch {
    return null;
  }
}

const latestRequest = readLatestInputRequest(runId, agentId);

try {
  setRunInputState(STATE_DIR, runId, agentId, { inputState: null });
} catch {
  // Allow master replies to be recorded even if the claim just completed.
}

appendSequencedEvent(STATE_DIR, {
  ts: new Date().toISOString(),
  event: 'input_response',
  actor_type: 'agent',
  actor_id: actorId,
  run_id: runId,
  task_ref: latestRequest?.task_ref,
  agent_id: agentId,
  payload: {
    response,
    question: latestRequest?.payload?.question ?? null,
  },
});

console.log(`input_response: ${runId} (${agentId})`);
