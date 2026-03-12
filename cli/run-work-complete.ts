#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { heartbeat, setRunFinalizationState } from '../lib/claimManager.ts';
import { recordAgentActivity } from '../lib/agentActivity.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { validateProgressInput } from '../lib/progressValidation.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-work-complete --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

function loadClaim(currentRunId: string) {
  try {
    const claims = JSON.parse(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8'));
    return (claims.claims ?? []).find((claim: Record<string, unknown>) => claim.run_id === currentRunId) ?? null;
  } catch {
    return null;
  }
}

function nextFinalizationTransition(claim: Record<string, unknown> | null) {
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
  const validatedClaimRecord = validatedClaim as unknown as Record<string, unknown>;
  const transition = nextFinalizationTransition(validatedClaimRecord);

  heartbeat(STATE_DIR, runId, agentId, { emitEvent: false });
  const updatedClaim = setRunFinalizationState(STATE_DIR, runId, agentId, {
    finalizationState: transition.status as import('../types/claims.ts').FinalizationState,
    blockedReason: null,
  });
  const updatedClaimRecord = updatedClaim as unknown as Record<string, unknown>;
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: transition.event as 'work_complete' | 'ready_to_merge',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaimRecord.task_ref as string,
    agent_id: agentId,
    payload: {
      status: transition.status as 'awaiting_finalize' | 'ready_to_merge',
      retry_count: (updatedClaimRecord.finalization_retry_count ?? 0) as number,
    },
  } as import('../types/events.ts').OrcEventInput);
  recordAgentActivity(STATE_DIR, agentId);
  console.log(`${transition.event}: ${runId} (${agentId}) ${transition.message}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
