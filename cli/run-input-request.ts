#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

import { flag, intFlag } from '../lib/args.ts';
import { appendSequencedEvent, readEventsSince } from '../lib/eventLog.ts';
import { EVENTS_FILE, STATE_DIR } from '../lib/paths.ts';
import { heartbeat, setRunInputState } from '../lib/claimManager.ts';
import { validateProgressInput } from '../lib/progressValidation.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { Claim } from '../types/claims.ts';

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

function loadClaim(currentRunId: string): Claim | null {
  try {
    return readClaims(STATE_DIR).claims.find((claim) => claim.run_id === currentRunId) ?? null;
  } catch {
    return null;
  }
}

let requestSeq: number;
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
    task_ref: (validatedClaim as unknown as Record<string, unknown>).task_ref as string | undefined,
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
  const responseEvent = (events as Array<Record<string, unknown>>).find((event) =>
    event.event === 'input_response'
      && event.run_id === runId
      && event.agent_id === agentId
      && typeof (event.payload as Record<string, unknown>)?.response === 'string',
  );

  if (responseEvent) {
    try {
      setRunInputState(STATE_DIR, runId, agentId, { inputState: null });
    } catch {
      // Ignore races with terminal events or cleanup.
    }
    process.stdout.write(`${String((responseEvent.payload as Record<string, unknown>).response)}\n`);
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
