#!/usr/bin/env node
/**
 * cli/progress.mjs
 * Usage:
 *   node cli/progress.mjs --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from '../lib/args.mjs';
import { appendSequencedEvent } from '../lib/eventLog.mjs';
import { recordAgentActivity } from '../lib/agentActivity.mjs';
import { startRun, heartbeat, finishRun, setRunFinalizationState } from '../lib/claimManager.mjs';
import { validateProgressInput } from '../lib/progressValidation.mjs';
import { STATE_DIR } from '../lib/paths.mjs';

const event = flag('event');
const runId = flag('run-id');
const agentId = flag('agent-id');
const phase = flag('phase');
const reason = flag('reason');
const policy = flag('policy') ?? 'requeue';

if (!event || !runId || !agentId) {
  console.error('Usage: orc-progress --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]');
  process.exit(1);
}

function loadClaim(currentRunId) {
  try {
    const claims = JSON.parse(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8'));
    return (claims.claims ?? []).find((c) => c.run_id === currentRunId) ?? null;
  } catch {
    return null;
  }
}

try {
  const claim = loadClaim(runId);
  const { claim: validatedClaim } = validateProgressInput({
    event,
    runId,
    agentId,
    phase,
    reason,
    policy,
  }, claim);
  const taskRef = validatedClaim.task_ref;

  switch (event) {
    case 'run_started':
      startRun(STATE_DIR, runId, agentId);
      break;
    case 'heartbeat':
      heartbeat(STATE_DIR, runId, agentId);
      break;
    case 'work_complete':
      heartbeat(STATE_DIR, runId, agentId, { emitEvent: false });
      setRunFinalizationState(STATE_DIR, runId, agentId, {
        finalizationState: 'awaiting_finalize',
        blockedReason: null,
      });
      appendSequencedEvent(STATE_DIR, {
        ts: new Date().toISOString(),
        event,
        actor_type: 'agent',
        actor_id: agentId,
        run_id: runId,
        task_ref: taskRef,
        agent_id: agentId,
        payload: { status: 'awaiting_finalize', retry_count: 0 },
      });
      break;
    case 'finalize_rebase_started': {
      const updatedClaim = setRunFinalizationState(STATE_DIR, runId, agentId, {
        finalizationState: 'finalize_rebase_in_progress',
        retryCountDelta: 1,
        blockedReason: null,
      });
      heartbeat(STATE_DIR, runId, agentId, { emitEvent: false });
      appendSequencedEvent(STATE_DIR, {
        ts: new Date().toISOString(),
        event,
        actor_type: 'agent',
        actor_id: agentId,
        run_id: runId,
        task_ref: taskRef,
        agent_id: agentId,
        payload: {
          status: 'finalize_rebase_in_progress',
          retry_count: updatedClaim.finalization_retry_count,
        },
      });
      break;
    }
    case 'ready_to_merge': {
      const updatedClaim = setRunFinalizationState(STATE_DIR, runId, agentId, {
        finalizationState: 'ready_to_merge',
        blockedReason: null,
      });
      heartbeat(STATE_DIR, runId, agentId, { emitEvent: false });
      appendSequencedEvent(STATE_DIR, {
        ts: new Date().toISOString(),
        event,
        actor_type: 'agent',
        actor_id: agentId,
        run_id: runId,
        task_ref: taskRef,
        agent_id: agentId,
        payload: {
          status: 'ready_to_merge',
          retry_count: updatedClaim.finalization_retry_count ?? 0,
        },
      });
      break;
    }
    case 'run_finished':
      finishRun(STATE_DIR, runId, agentId, { success: true });
      break;
    case 'run_failed':
      finishRun(STATE_DIR, runId, agentId, {
        success: false,
        failureReason: reason ?? 'worker reported failure',
        failureCode: 'ERR_WORKER_REPORTED_FAILURE',
        policy,
      });
      break;
    case 'phase_started':
    case 'phase_finished':
    case 'blocked':
    case 'need_input':
    case 'input_provided':
    case 'unblocked':
      // Any accepted run activity should keep the claim lease alive.
      heartbeat(STATE_DIR, runId, agentId, { emitEvent: false });
      appendSequencedEvent(STATE_DIR, {
        ts: new Date().toISOString(),
        event,
        actor_type: 'agent',
        actor_id: agentId,
        run_id: runId,
        task_ref: taskRef,
        agent_id: agentId,
        ...(phase ? { phase } : {}),
        ...(reason ? { payload: { reason } } : {}),
      });
      break;
    default:
      throw new Error(`Unsupported event: ${event}`);
  }

  recordAgentActivity(STATE_DIR, agentId);
  console.log(`progress event accepted: ${event} run=${runId} agent=${agentId}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
