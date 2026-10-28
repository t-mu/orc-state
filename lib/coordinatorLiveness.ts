import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive, isSameProcess } from './processIdentity.ts';

/** The coordinator pid lock's contents; `process_start` is absent in locks written before it was recorded. */
export interface CoordinatorLock { pid?: unknown; started_at?: unknown; process_start?: unknown }

/**
 * True when the process that wrote this lock still runs. A recorded start
 * fingerprint tells a reused PID (common in containers) from the coordinator;
 * an older lock without one falls back to the bare PID.
 */
export function isCoordinatorLockHeld(lock: CoordinatorLock | null | undefined): boolean {
  const pid = lock?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  return typeof lock?.process_start === 'string' ? isSameProcess({ pid, start: lock.process_start }) : isPidAlive(pid);
}

/** The pid of the live coordinator holding this state directory's pid lock, or null. */
export function runningCoordinatorPid(stateDir: string): number | null {
  try {
    const lock = JSON.parse(readFileSync(join(stateDir, 'coordinator.pid'), 'utf8')) as CoordinatorLock;
    return isCoordinatorLockHeld(lock) ? lock.pid as number : null;
  } catch {
    return null;
  }
}
