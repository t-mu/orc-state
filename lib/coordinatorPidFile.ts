import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import type { SchemaSupport } from './schemaCompat.ts';
import { isCoordinatorLockHeld, type CoordinatorLock } from './coordinatorLiveness.ts';

/** What a coordinator wrote into its pid lock when it acquired it. */
export interface CoordinatorPidRecord {
  pid: number; started_at: string; process_start: string | null;
  /** The schemas this coordinator supports, read by a newer binary before it migrates (`lib/schemaCompat.ts`). */
  schemas?: SchemaSupport;
}

type ReadResult = { state: 'missing' } | { state: 'present'; lock: CoordinatorLock | null };

function readLock(path: string): ReadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    throw error;
  }
  try {
    return { state: 'present', lock: JSON.parse(text) as CoordinatorLock };
  } catch {
    return { state: 'present', lock: null };
  }
}

/** The lock names this coordinator: the same pid, and the same process start when both record one. */
export function isOwnCoordinatorLock(lock: CoordinatorLock | null | undefined, self: CoordinatorPidRecord): boolean {
  if (lock?.pid !== self.pid) return false;
  return typeof lock.process_start !== 'string' || self.process_start == null || lock.process_start === self.process_start;
}

/**
 * Removes the pid lock only when it still names this coordinator. A lock
 * another coordinator wrote (or one that cannot be read) is left in place.
 */
export function releaseCoordinatorPidFile(path: string, self: CoordinatorPidRecord): 'removed' | 'missing' | 'foreign' {
  const current = readLock(path);
  if (current.state === 'missing') return 'missing';
  if (!isOwnCoordinatorLock(current.lock, self)) return 'foreign';
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  return 'removed';
}

export type PidFileCheck = 'present' | 'recreated' | 'foreign_live' | 'foreign_stale';

/**
 * A running coordinator's check that its pid lock is still in place:
 * re-creates a missing file with the original payload, and never touches a
 * file that names another process (`foreign_live` when that process still
 * runs as the coordinator it recorded).
 */
export function ensureCoordinatorPidFile(path: string, self: CoordinatorPidRecord): PidFileCheck {
  const current = readLock(path);
  if (current.state === 'present') {
    if (isOwnCoordinatorLock(current.lock, self)) return 'present';
    return isCoordinatorLockHeld(current.lock) ? 'foreign_live' : 'foreign_stale';
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY);
  } catch (error) {
    // Another process created it between the read and the open: judge that file instead.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return ensureCoordinatorPidFile(path, self);
    throw error;
  }
  try {
    writeSync(fd, JSON.stringify(self), null, 'utf8');
  } finally {
    closeSync(fd);
  }
  return 'recreated';
}
