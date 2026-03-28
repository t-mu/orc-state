#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { validateProgressInput } from '../lib/progressValidation.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { Claim } from '../types/claims.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-heartbeat --run-id=<id> --agent-id=<id>');
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
  const { claim: validatedClaim } = validateProgressInput({
    event: 'heartbeat',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);

  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'heartbeat',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {},
  }, { lockStrategy: 'none' });
  console.log(`heartbeat: ${runId} (${agentId})`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}
