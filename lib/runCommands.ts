import { setTimeout as delay } from 'node:timers/promises';

import { INPUT_REQUEST_HEARTBEAT_INTERVAL_MS } from './constants.ts';
import { DEFAULT_INPUT_REQUEST_TIMEOUT_MS } from './inputRequestConfig.ts';
import { logger } from './logger.ts';
import { submitLifecycle } from './lifecycleDispatch.ts';
import type { LifecycleRequest, LifecycleResult } from './workerLifecycle.ts';

const INPUT_REQUEST_TIMEOUT_GRACE_MS = 250;

type Submit = (request: LifecycleRequest) => Promise<LifecycleResult>;

async function report(request: LifecycleRequest, submit: Submit = submitLifecycle): Promise<void> {
  console.log((await submit(request)).message);
}

export function executeRunStart(runId: string, agentId: string): Promise<void> {
  return report({ op: 'run-start', run_id: runId, agent_id: agentId });
}

export function executeRunFail(runId: string, agentId: string, reason: string, code: string, policy: string): Promise<void> {
  return report({ op: 'run-fail', run_id: runId, agent_id: agentId, reason, code, policy });
}

export function executeRunFinish(runId: string, agentId: string): Promise<void> {
  return report({ op: 'run-finish', run_id: runId, agent_id: agentId });
}

export function executeRunWorkComplete(runId: string, agentId: string): Promise<void> {
  return report({ op: 'run-work-complete', run_id: runId, agent_id: agentId });
}

/**
 * Ask the master a question and wait for the answer. Every state read and
 * write goes through `submit`, so in a registered project the worker only
 * talks to its coordinator. Resolves with the exit code.
 */
export async function executeRunInputRequest(
  runId: string,
  agentId: string,
  question: string,
  timeoutMs: number = DEFAULT_INPUT_REQUEST_TIMEOUT_MS,
  pollMs: number = 1000,
  submit: Submit = submitLifecycle,
): Promise<number> {
  const timedOut = (): number => {
    logger.error(`Timed out waiting for input_response for run ${runId} after ${timeoutMs}ms`);
    return 1;
  };
  const requested = await submit({ op: 'input-request', run_id: runId, agent_id: agentId, question });
  if (!requested.active || !requested.request_id) return timedOut();
  const poll = (heartbeat: boolean) => submit({
    op: 'input-poll', run_id: runId, agent_id: agentId,
    request_id: requested.request_id!, request_seq: requested.request_seq ?? 0, heartbeat,
  });

  const deadline = Date.now() + timeoutMs;
  let lastHeartbeatAt = Date.now();
  for (;;) {
    const now = Date.now();
    const heartbeat = (now - lastHeartbeatAt) >= INPUT_REQUEST_HEARTBEAT_INTERVAL_MS;
    const state = await poll(heartbeat);
    if (heartbeat) lastHeartbeatAt = now;
    if (typeof state.response === 'string') {
      process.stdout.write(`${state.response}\n`);
      return 0;
    }
    if (!state.active || Date.now() >= deadline) break;
    await delay(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }

  const graceDeadline = Date.now() + INPUT_REQUEST_TIMEOUT_GRACE_MS;
  while (Date.now() < graceDeadline) {
    const state = await poll(false);
    if (typeof state.response === 'string') {
      process.stdout.write(`${state.response}\n`);
      return 0;
    }
    if (!state.active) break;
    await delay(Math.max(5, Math.min(25, graceDeadline - Date.now())));
  }

  await submit({ op: 'input-timeout', run_id: runId, agent_id: agentId });
  return timedOut();
}
