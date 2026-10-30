import { join } from 'node:path';
import { ControlClient } from './controlClient.ts';
import { ControlError } from './controlProtocol.ts';
import { runningCoordinatorPid } from './coordinatorLiveness.ts';
import { resolveControlPrincipal, requireProjectAuthor } from './controlPrincipal.ts';
import { clientCredential } from './sessionCredentials.ts';

/** Route a project authoring write to its coordinator; direct writes require a stopped coordinator. */
export async function submitProjectWrite<T>(stateDir: string, operation: string, actorId: string | undefined,
  remote: (client: ControlClient) => Promise<T>, direct: (actorId: string) => T,
  { credential = clientCredential(), warn = (line: string) => console.error(line) }: {
    credential?: string | null; warn?: (line: string) => void;
  } = {}): Promise<T> {
  try {
    return await remote(new ControlClient(stateDir, { credential, timeoutMs: 120_000 }));
  } catch (error) {
    if (!(error instanceof ControlError) || error.code !== 'unavailable') throw error;
  }
  const pid = runningCoordinatorPid(stateDir);
  if (pid !== null) throw new ControlError('unavailable',
    `The coordinator (pid ${pid}) is running but its control API is not answering; retry ${operation} in a moment. If pid ${pid} is not an orc coordinator, remove ${join(stateDir, 'coordinator.pid')}`, 503);
  const actor = requireProjectAuthor(stateDir, resolveControlPrincipal(stateDir, credential, credential === null), actorId);
  warn(`coordinator is not running; applying ${operation} directly`);
  return direct(actor);
}
