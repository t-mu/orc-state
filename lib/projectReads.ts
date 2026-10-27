import { ControlClient } from './controlClient.ts';
import { ControlError } from './controlProtocol.ts';
import { ACTIVE_PROJECT, STATE_DIR } from './paths.ts';

/**
 * Read project state the way a sandboxed worker can. A registered project
 * asks its running coordinator, which holds the databases open; with the
 * coordinator stopped the read falls back to the state directory, which
 * opens it read-only. A legacy installation always reads directly.
 */
export async function readProjectState<T>(
  remote: (client: ControlClient) => Promise<T>,
  local: () => T,
  { project = ACTIVE_PROJECT, client = () => new ControlClient(STATE_DIR) }: { project?: unknown; client?: () => ControlClient } = {},
): Promise<T> {
  if (!project) return local();
  try {
    return await remote(client());
  } catch (error) {
    if (!(error instanceof ControlError) || error.code !== 'unavailable') throw error;
  }
  try {
    return local();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The coordinator is not running and the project state could not be read directly (${reason}); retry once the coordinator is running`);
  }
}
