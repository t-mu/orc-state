import { setTimeout as delay } from 'node:timers/promises';
import { ControlClient } from './controlClient.ts';
import { ControlError } from './controlProtocol.ts';
import { ACTIVE_PROJECT, STATE_DIR } from './paths.ts';
import { applyLifecycle, type LifecycleRequest, type LifecycleResult } from './workerLifecycle.ts';

/** How long a worker waits for a stopped or restarting coordinator before giving up. */
const DEFAULT_RETRY_MS = 120_000;
const RETRY_INTERVAL_MS = 1_000;
/**
 * A request the coordinator received may still be applied after a client
 * timeout, so a timeout is never retried; it is long enough to cover a tick
 * that blocks the coordinator's event loop (a merge, a rebase).
 */
const REQUEST_TIMEOUT_MS = 120_000;

function retryWindowMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.ORC_CONTROL_RETRY_MS);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_MS;
}

/**
 * Send a lifecycle request to the coordinator, retrying only while the
 * request provably never reached it: no endpoint, a refused connection, or a
 * daemon that is shutting down.
 */
export async function sendLifecycle(
  client: Pick<ControlClient, 'lifecycle'>,
  request: LifecycleRequest,
  { retryMs = retryWindowMs(process.env), intervalMs = RETRY_INTERVAL_MS, warn = (line: string) => console.error(line) } = {},
): Promise<LifecycleResult> {
  const deadline = Date.now() + retryMs;
  let warned = false;
  for (;;) {
    try {
      return await client.lifecycle(request);
    } catch (error) {
      if (!(error instanceof ControlError) || error.code !== 'unavailable' || Date.now() >= deadline) throw error;
      if (!warned) warn(`coordinator unavailable (${error.message}); retrying for up to ${Math.round(retryMs / 1000)}s`);
      warned = true;
      await delay(intervalMs);
    }
  }
}

/**
 * Apply a worker lifecycle request in the active layout. A registered project
 * sends it to the coordinator over its control socket with the worker's
 * session credential; a legacy installation still applies it in this process.
 */
export async function submitLifecycle(request: LifecycleRequest, env: NodeJS.ProcessEnv = process.env): Promise<LifecycleResult> {
  if (!ACTIVE_PROJECT) return applyLifecycle(STATE_DIR, request);
  const sessionToken = env.ORC_SESSION_SECRET?.trim();
  if (!sessionToken) {
    throw new Error(`In a registered project the coordinator applies ${request.op}; run it from the worker session (ORC_SESSION_SECRET is not set)`);
  }
  return sendLifecycle(new ControlClient(STATE_DIR, { sessionToken, timeoutMs: REQUEST_TIMEOUT_MS }), request);
}

