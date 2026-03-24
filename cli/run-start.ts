#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { validateProgressCommandInput } from '../lib/progressValidation.ts';
import { startRun } from '../lib/claimManager.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { Claim } from '../types/claims.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-start --run-id=<id> --agent-id=<id>');
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
    event: 'run_started',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);

  const at = new Date().toISOString();
  appendSequencedEvent(STATE_DIR, {
    ts: at,
    event: 'run_started',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {},
  }, { lockStrategy: 'none' });

  // Update claims.json synchronously so enforceRunStartLifecycle sees in_progress
  // immediately, without waiting for the coordinator's event polling cycle (~30 s).
  try {
    startRun(STATE_DIR, runId, agentId, { emitEvent: false, at });
  } catch {
    // Ignore: coordinator may have already transitioned the claim via event processing.
  }

  console.log(`run_started: ${runId} (${agentId})`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
