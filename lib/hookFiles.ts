import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The agent a `pty-hook-events/` file belongs to: every file there is named
 * `<agent_id>.ndjson` plus an optional suffix (`.processing`, the
 * `.tasks.json` label sidecar, or its `.tasks.json.<pid>.tmp` write).
 * Returns null for a file that does not follow that naming.
 */
export function hookFileAgentId(name: string): string | null {
  const index = name.indexOf('.ndjson');
  return index > 0 ? name.slice(0, index) : null;
}

/**
 * Remove `pty-hook-events/` files whose agent is no longer registered: a
 * session that crashed before its adapter's stop() ran leaves them behind, and
 * nothing else deletes them. Files of registered agents and files that do not
 * follow the naming are kept. Returns the removed file names.
 */
export function gcOrphanedHookFiles(stateDir: string, registeredAgentIds: Iterable<string>): string[] {
  const registered = new Set(registeredAgentIds);
  const dir = join(stateDir, 'pty-hook-events');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const agentId = hookFileAgentId(name);
    if (agentId === null || registered.has(agentId)) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch {
      // Already gone.
    }
  }
  return removed;
}
