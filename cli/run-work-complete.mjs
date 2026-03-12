#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSequencedEvent } from '../lib/eventLog.mjs';
import { heartbeat, setRunFinalizationState } from '../lib/claimManager.mjs';
import { recordAgentActivity } from '../lib/agentActivity.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';
import { validateProgressInput } from '../lib/progressValidation.mjs';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-work-complete --run-id=<id> --agent-id=<id>');
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

function nextFinalizationTransition(claim) {
  const currentState = claim?.finalization_state ?? null;
  if (currentState === null) {
    return {
      event: 'work_complete',
      status: 'awaiting_finalize',
      message: 'awaiting coordinator finalization',
    };
  }
  if (currentState === 'finalize_rebase_in_progress') {
    return {
      event: 'ready_to_merge',
      status: 'ready_to_merge',
      message: 'ready to merge after finalize rebase',
    };
  }
  throw new Error(`run-work-complete cannot be reported from finalization_state '${currentState}'`);
}

try {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressInput({
    event: 'work_complete',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);
  const transition = nextFinalizationTransition(validatedClaim);

  heartbeat(STATE_DIR, runId, agentId, { emitEvent: false });
  const updatedClaim = setRunFinalizationState(STATE_DIR, runId, agentId, {
    finalizationState: transition.status,
    blockedReason: null,
  });
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: transition.event,
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {
      status: transition.status,
      retry_count: updatedClaim.finalization_retry_count ?? 0,
    },
  });
  recordAgentActivity(STATE_DIR, agentId);
  console.log(`${transition.event}: ${runId} (${agentId}) ${transition.message}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
