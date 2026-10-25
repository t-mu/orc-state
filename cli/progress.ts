#!/usr/bin/env node
/**
 * cli/progress.ts
 * Usage:
 *   node cli/progress.ts --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]
 */
import { flag } from '../lib/args.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { finishRun, heartbeat, startRun } from '../lib/claimManager.ts';
import { validateProgressCommandInput, validateProgressInput } from '../lib/progressValidation.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { loadClaim, cliError } from './shared.ts';
import type { EventFinalizationStatus, OrcEvent } from '../types/events.ts';
import { assertRunMayFinish } from '../lib/projectTasks.ts';

const event = flag('event');
const runId = flag('run-id');
const agentId = flag('agent-id');
const phase = flag('phase');
const reason = flag('reason');
const policy = flag('policy') ?? 'requeue';

if (!event || !runId || !agentId) {
  console.error('Usage: orc progress --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]');
  process.exit(1);
}

function finalizationPayload(eventName: string): { status: EventFinalizationStatus } | null {
  if (eventName === 'work_complete') {
    return {
      status: 'awaiting_finalize',
    };
  }
  if (eventName === 'finalize_rebase_started') {
    return {
      status: 'finalize_rebase_in_progress',
    };
  }
  if (eventName === 'ready_to_merge') {
    return {
      status: 'ready_to_merge',
    };
  }
  return null;
}

try {
  const claim = loadClaim(runId);
  const validator = event === 'heartbeat' ? validateProgressInput : validateProgressCommandInput;
  const { claim: validatedClaim } = validator({
    event: event as OrcEvent['event'],
    runId,
    agentId,
    phase,
    reason,
    policy,
  }, claim);

  if (event === 'run_started') {
    startRun(STATE_DIR, runId, agentId);
  } else if (event === 'run_finished') {
    assertRunMayFinish(STATE_DIR, claim!.task_ref);
    finishRun(STATE_DIR, runId, agentId, { success: true });
  } else if (event === 'run_failed') {
    finishRun(STATE_DIR, runId, agentId, {
      success: false, failureReason: reason, failureCode: 'ERR_WORKER_REPORTED_FAILURE', policy,
    });
  } else if (event === 'heartbeat') {
    heartbeat(STATE_DIR, runId, agentId);
  } else {
    const payload = finalizationPayload(event) ?? (reason ? { reason } : undefined);
    appendSequencedEvent(STATE_DIR, {
      ts: new Date().toISOString(),
      event: event as OrcEvent['event'],
      actor_type: 'agent',
      actor_id: agentId,
      run_id: runId,
      task_ref: validatedClaim.task_ref,
      agent_id: agentId,
      ...(phase ? { phase } : {}),
      ...(payload ? { payload } : {}),
    } as OrcEvent, { lockStrategy: 'none' });
  }

  console.log(`progress event accepted: ${event} run=${runId} agent=${agentId}`);
} catch (error) {
  cliError(error);
}
