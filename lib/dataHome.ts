import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * orc's per-user data home (registry.db and every project's state directory).
 * Built-ins only: the client entry (`orc-state/client`) resolves it too.
 * An empty or blank `ORC_DATA_HOME` counts as unset.
 */
export function projectDataHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORC_DATA_HOME?.trim()) return resolve(env.ORC_DATA_HOME);
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'orc-state');
  return join(env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(homedir(), '.local', 'share'), 'orc-state');
}
