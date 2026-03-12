#!/usr/bin/env node
/**
 * cli/progress.ts
 * Usage:
 *   node cli/progress.ts --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flag } from '../lib/args.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { recordAgentActivity } from '../lib/agentActivity.ts';
import { startRun, heartbeat, finishRun, setRunFinalizationState } from '../lib/claimManager.ts';
import { validateProgressInput } from '../lib/progressValidation.ts';
import { STATE_DIR } from '../lib/paths.ts';

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

function loadClaim(currentRunId: string) {
  try {
    const claims = JSON.parse(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8'));
    return (claims.claims ?? []).find((c: Record<string, unknown>) => c.run_id === currentRunId) ?? null;
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
  const taskRef = (validatedClaim as unknown as Record<string, unknown>).task_ref as string;

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
          retry_count: (updatedClaim as unknown as Record<string, unknown>).finalization_retry_count as number,
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
          retry_count: ((updatedClaim as unknown as Record<string, unknown>).finalization_retry_count ?? 0) as number,
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
  console.error((error as Error).message);
  process.exit(1);
}
