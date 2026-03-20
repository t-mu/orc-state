#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { validateProgressCommandInput } from '../lib/progressValidation.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { Claim } from '../types/claims.ts';
import type { FailurePolicy } from '../types/events.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');
const failureReason = flag('reason') ?? 'worker reported failure';
const failureCode = flag('code') ?? 'ERR_WORKER_REPORTED_FAILURE';
const policy = flag('policy') ?? 'requeue';

const VALID_POLICIES = ['requeue', 'block'];
if (!VALID_POLICIES.includes(policy)) {
  console.error(`Invalid policy: ${policy}. Must be one of: ${VALID_POLICIES.join(', ')}`);
  process.exit(1);
}

if (!runId || !agentId) {
  console.error('Usage: orc-run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--code=<code>] [--policy=requeue|block]');
  process.exit(1);
}

function loadClaim(currentRunId: string): Claim | null {
  try {
    return readClaims(STATE_DIR).claims.find((claim) => claim.run_id === currentRunId) ?? null;
  } catch {
    return null;
  }
}

try {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'run_failed',
    runId,
    agentId,
    phase: null,
    reason: failureReason,
    policy,
  }, claim);

  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'run_failed',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {
      reason: failureReason,
      code: failureCode,
      policy: policy as FailurePolicy,
    },
  }, { lockStrategy: 'none' });
  console.log(`run_failed: ${runId} (${agentId}) reason=${failureReason}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
