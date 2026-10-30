import { join } from 'node:path';
import { ControlClient } from './controlClient.ts';
import { ControlError } from './controlProtocol.ts';
import { runningCoordinatorPid } from './coordinatorLiveness.ts';
import { resolveControlPrincipal, requireProjectAuthor } from './controlPrincipal.ts';
import { clientCredential } from './sessionCredentials.ts';

/** Coordinator requests are applied once received, so a timeout is never retried (see lifecycleDispatch). */
const COORDINATOR_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The one rule for a client's project write: the running coordinator applies
 * it. Only when the request provably never reached one (`unavailable`) and no
 * live coordinator holds the project's pid lock does the caller apply it
 * directly, after the coordinator's own authorization, and say so. A
 * coordinator that holds the project but is not answering (starting, shutting
 * down, between descriptors) still owns its writes, so the caller refuses
 * with a retryable error.
 */
export async function routeToCoordinator<A, T>(stateDir: string, operation: string, {
  credential, remote, authorize, direct, warn,
}: {
  credential: string | null;
  remote: (client: ControlClient) => Promise<T>;
  authorize: () => A;
  direct: (authorized: A) => T;
  warn: (line: string) => void;
}): Promise<T> {
  try {
    return await remote(new ControlClient(stateDir, { credential, timeoutMs: COORDINATOR_REQUEST_TIMEOUT_MS }));
  } catch (error) {
    if (!(error instanceof ControlError) || error.code !== 'unavailable') throw error;
  }
  const pid = runningCoordinatorPid(stateDir);
  if (pid !== null) {
    throw new ControlError('unavailable', `The coordinator (pid ${pid}) is running but its control API is not answering; retry ${operation} in a moment. If pid ${pid} is not an orc coordinator, remove ${join(stateDir, 'coordinator.pid')}`, 503);
  }
  const authorized = authorize();
  warn(`coordinator is not running; applying ${operation} directly`);
  return direct(authorized);
}

/** Route a project authoring write to its coordinator; direct writes require a stopped coordinator. */
export function submitProjectWrite<T>(stateDir: string, operation: string, actorId: string | undefined,
  remote: (client: ControlClient) => Promise<T>, direct: (actorId: string) => T,
  { credential = clientCredential(), warn = (line: string) => console.error(line) }: {
    credential?: string | null; warn?: (line: string) => void;
  } = {}): Promise<T> {
  return routeToCoordinator(stateDir, operation, {
    credential, remote, direct, warn,
    // The direct path applies the coordinator's own rule, so a worker session cannot use it either.
    authorize: () => requireProjectAuthor(stateDir, resolveControlPrincipal(stateDir, credential, credential === null), actorId),
  });
}
