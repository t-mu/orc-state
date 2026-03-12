#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { flag, intFlag } from '../lib/args.mjs';
import { appendSequencedEvent, readEventsSince } from '../lib/eventLog.mjs';
import { EVENTS_FILE, STATE_DIR } from '../lib/paths.mjs';
import { heartbeat, setRunInputState } from '../lib/claimManager.mjs';
import { validateProgressInput } from '../lib/progressValidation.mjs';

const runId = flag('run-id');
const agentId = flag('agent-id');
const question = flag('question');
const timeoutMs = intFlag('timeout-ms', 25 * 60 * 1000);
const pollMs = intFlag('poll-ms', 1000);
const HEARTBEAT_INTERVAL_MS = 60_000;

if (!runId || !agentId || !question) {
  console.error('Usage: orc-run-input-request --run-id=<id> --agent-id=<id> --question=<text> [--timeout-ms=<ms>] [--poll-ms=<ms>]');
  process.exit(1);
}

function loadClaim(currentRunId) {
  try {
    const claims = JSON.parse(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8'));
    return (claims.claims ?? []).find((claim) => claim.run_id === currentRunId) ?? null;
  } catch {
    return null;
  }
}

let requestSeq;
try {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressInput({
    event: 'need_input',
    runId,
    agentId,
    phase: null,
    reason: 'master_input_required',
    policy: null,
  }, claim);

  const nowIso = new Date().toISOString();
  heartbeat(STATE_DIR, runId, agentId, { emitEvent: false });
  setRunInputState(STATE_DIR, runId, agentId, {
    inputState: 'awaiting_input',
    requestedAt: nowIso,
  });
  requestSeq = appendSequencedEvent(STATE_DIR, {
    ts: nowIso,
    event: 'input_requested',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {
      question,
    },
  });
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const deadline = Date.now() + timeoutMs;
let lastHeartbeatAt = Date.now();

while (Date.now() < deadline) {
  const events = readEventsSince(EVENTS_FILE, requestSeq);
  const responseEvent = events.find((event) =>
    event.event === 'input_response'
      && event.run_id === runId
      && event.agent_id === agentId
      && typeof event.payload?.response === 'string',
  );

  if (responseEvent) {
    try {
      setRunInputState(STATE_DIR, runId, agentId, { inputState: null });
    } catch {
      // Ignore races with terminal events or cleanup.
    }
    process.stdout.write(`${responseEvent.payload.response}\n`);
    process.exit(0);
  }

  if ((Date.now() - lastHeartbeatAt) >= HEARTBEAT_INTERVAL_MS) {
    try {
      heartbeat(STATE_DIR, runId, agentId);
      lastHeartbeatAt = Date.now();
    } catch {
      // The matching input_response, terminal run event, or claim cleanup may
      // have arrived while we were waiting. Let the polling loop finish normally.
    }
  }

  await delay(pollMs);
}

try {
  setRunInputState(STATE_DIR, runId, agentId, { inputState: null });
} catch {
  // Claim may already be terminal or removed. Timeout reporting still proceeds.
}
console.error(`Timed out waiting for input_response for run ${runId} after ${timeoutMs}ms`);
process.exit(1);
