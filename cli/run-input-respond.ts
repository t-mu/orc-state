#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flag } from '../lib/args.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { setRunInputState } from '../lib/claimManager.ts';

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
    const raw = readFileSync(join(STATE_DIR, 'events.jsonl'), 'utf8').trim();
    if (!raw) return null;
    const events = raw.split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .reverse();
    return events.find((event) =>
      event.event === 'input_requested'
      && event.run_id === currentRunId
      && event.agent_id === currentAgentId
      && typeof (event.payload as Record<string, unknown>)?.question === 'string') ?? null;
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
  task_ref: latestRequest?.task_ref as string | undefined,
  agent_id: agentId,
  payload: {
    response,
    question: (latestRequest?.payload as Record<string, unknown> | undefined)?.question ?? null,
  },
});

console.log(`input_response: ${runId} (${agentId})`);
