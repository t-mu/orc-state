#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';

import { flag, intFlag } from '../lib/args.ts';
import { appendSequencedEvent, readEventsSince } from '../lib/eventLog.ts';
import { DEFAULT_INPUT_REQUEST_TIMEOUT_MS } from '../lib/inputRequestConfig.ts';
import { EVENTS_FILE, STATE_DIR } from '../lib/paths.ts';
import { validateProgressInput } from '../lib/progressValidation.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { Claim } from '../types/claims.ts';
import type { FailurePolicy } from '../types/events.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const question = flag('question');
const timeoutMs = intFlag('timeout-ms', DEFAULT_INPUT_REQUEST_TIMEOUT_MS);
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
let taskRef: string;

function readLatestInputResponse() {
  const events = readEventsSince(EVENTS_FILE, requestSeq);
  return events.find((event) =>
    event.event === 'input_response'
      && event.run_id === runId
      && event.agent_id === agentId
      && typeof (event.payload as Record<string, unknown>)?.response === 'string',
  );
}

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
  taskRef = validatedClaim.task_ref;

  const nowIso = new Date().toISOString();
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
  const responseEvent = readLatestInputResponse();

  if (responseEvent) {
    process.stdout.write(`${String((responseEvent.payload as Record<string, unknown>).response)}\n`);
    process.exit(0);
  }

  if ((Date.now() - lastHeartbeatAt) >= HEARTBEAT_INTERVAL_MS) {
    appendSequencedEvent(STATE_DIR, {
      ts: new Date().toISOString(),
      event: 'heartbeat',
      actor_type: 'agent',
      actor_id: agentId,
      run_id: runId,
      task_ref: taskRef,
      agent_id: agentId,
    }, { lockStrategy: 'none' });
    lastHeartbeatAt = Date.now();
  }

  await delay(pollMs);
}

const finalResponseEvent = readLatestInputResponse();
if (finalResponseEvent) {
  process.stdout.write(`${String((finalResponseEvent.payload as Record<string, unknown>).response)}\n`);
  process.exit(0);
}

const currentClaim = loadClaim(runId);
const shouldEmitTimeoutFailure = currentClaim != null
  && currentClaim.agent_id === agentId
  && ['claimed', 'in_progress'].includes(currentClaim.state);

if (shouldEmitTimeoutFailure) {
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'run_failed',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: taskRef,
    agent_id: agentId,
    payload: {
      reason: 'input_request_timeout',
      code: 'ERR_INPUT_REQUEST_TIMEOUT',
      policy: 'requeue' as FailurePolicy,
    },
  }, { lockStrategy: 'none' });
}
console.error(`Timed out waiting for input_response for run ${runId} after ${timeoutMs}ms`);
process.exit(1);
