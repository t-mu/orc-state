#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';
import { validateProgressCommandInput } from '../lib/progressValidation.ts';
import { readBacklog, findTask } from '../lib/stateReader.ts';
import { loadClaim, cliError } from './shared.ts';
import type { Claim } from '../types/claims.ts';

const runId = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-work-complete --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

function nextFinalizationTransition(claim: Claim | null) {
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
  const { claim: validatedClaim } = validateProgressCommandInput({
    event: 'work_complete',
    runId,
    agentId,
    phase: null,
    reason: null,
    policy: null,
  }, claim);
  // Gate: reject if task not marked done
  const taskRef = validatedClaim.task_ref;
  if (taskRef) {
    const backlog = readBacklog(STATE_DIR);
    const task = findTask(backlog, taskRef);
    if (task && task.status !== 'done') {
      console.error(
        `Error: task not marked done — call orc task-mark-done ${taskRef} first`,
      );
      process.exit(1);
    }
  }

  const transition = nextFinalizationTransition(validatedClaim);
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: transition.event as 'work_complete' | 'ready_to_merge',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: {
      status: transition.status as 'awaiting_finalize' | 'ready_to_merge',
    },
  } as import('../types/events.ts').OrcEventInput, { lockStrategy: 'none' });
  console.log(`${transition.event}: ${runId} (${agentId}) ${transition.message}`);
} catch (error) {
  cliError(error);
}
