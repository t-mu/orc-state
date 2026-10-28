import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from './processIdentity.ts';

/** The pid of the live coordinator holding this state directory's pid lock, or null. */
export function runningCoordinatorPid(stateDir: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(join(stateDir, 'coordinator.pid'), 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isPidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}
