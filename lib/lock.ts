import { openSync, closeSync, unlinkSync, existsSync, statSync, readFileSync, writeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { LOCK_STALE_MS } from './constants.ts';

/** Return the canonical lock file path for a state directory. */
export function lockPath(dir: string): string { return join(dir, '.lock'); }

/** Extremely stale malformed locks can be broken to avoid permanent deadlocks. */
const MALFORMED_STALE_BREAK_MS = LOCK_STALE_MS * 20;
const HELD_LOCK_TOKENS = new Map<string, string>();

function createLockToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Check whether a process with the given PID is alive.
 * Returns true if alive (including EPERM), false only for ESRCH (no such process).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Acquire a file-based exclusive lock. Throws if the lock is currently held
 * by a live process. Breaks locks that are older than LOCK_STALE_MS AND whose
 * holder process is confirmed dead.
 *
 * Uses O_EXCL (create-exclusive) which is atomic on local POSIX filesystems.
 * Writes the holding PID as JSON so stale detection can verify liveness.
 */
export function acquireLock(lockPath: string): void {
  const lockFlags = constants.O_EXCL | constants.O_WRONLY | constants.O_CREAT;
  const token = createLockToken();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(lockPath, lockFlags);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(fd);
      }
      HELD_LOCK_TOKENS.set(lockPath, token);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
    }

    if (!existsSync(lockPath)) continue;

    let age: number;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw e;
    }
    if (age <= LOCK_STALE_MS) {
      throw new Error(`Lock already held: ${lockPath}`);
    }

    // Fail closed unless we can prove the stale lock owner is dead.
    let storedPid: number | undefined;
    try {
      storedPid = (JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number })?.pid;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      if (age > MALFORMED_STALE_BREAK_MS) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException)?.code !== 'ENOENT') throw unlinkErr;
        }
        continue;
      }
      throw new Error(`Stale lock has unreadable metadata: ${lockPath}`);
    }
    if (!Number.isInteger(storedPid) || (storedPid as number) <= 0) {
      if (age > MALFORMED_STALE_BREAK_MS) {
        try {
          unlinkSync(lockPath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
        }
        continue;
      }
      throw new Error(`Stale lock is missing valid pid metadata: ${lockPath}`);
    }
    if (isProcessAlive(storedPid as number)) {
      throw new Error(`Lock held by live process ${storedPid}: ${lockPath}`);
    }
    // Holder is dead — safe to break and retry lock create.
    try {
      unlinkSync(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
  }
  throw new Error(`Failed to acquire lock due to concurrent updates: ${lockPath}`);
}

/** Release a previously acquired lock. No-op if the lock file is already gone. */
export function releaseLock(lockPath: string): void {
  let ownerPid: number | undefined;
  let token: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; token?: string };
    ownerPid = parsed?.pid;
    token = parsed?.token;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw new Error(`Cannot release lock with unreadable metadata: ${lockPath}`);
  }

  if (!Number.isInteger(ownerPid) || (ownerPid as number) <= 0) {
    throw new Error(`Cannot release lock with invalid pid metadata: ${lockPath}`);
  }
  if (ownerPid !== process.pid) {
    throw new Error(`Cannot release lock owned by process ${ownerPid}: ${lockPath}`);
  }
  const expectedToken = HELD_LOCK_TOKENS.get(lockPath);
  if (expectedToken && token !== expectedToken) {
    throw new Error(`Cannot release lock with mismatched token: ${lockPath}`);
  }

  try {
    unlinkSync(lockPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  } finally {
    HELD_LOCK_TOKENS.delete(lockPath);
  }
}

/**
 * Execute fn() while holding the lock at lockPath.
 * Always releases the lock, even if fn throws.
 */
export function withLock<T>(lockPath: string, fn: () => T): T {
  acquireLock(lockPath);
  let value: T;
  let fnError: unknown = null;
  try {
    value = fn();
  } catch (error) {
    fnError = error;
  }
  try {
    releaseLock(lockPath);
  } catch (releaseError) {
    if (fnError) {
      throw new Error(`Lock release failed after callback error: ${(releaseError as Error).message}`, { cause: fnError });
    }
    throw releaseError;
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (fnError) throw fnError;
  return value!;
}

/**
 * Async version of withLock. Awaits the promise returned by fn before releasing.
 */
export async function withLockAsync<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  acquireLock(lockPath);
  let value: T;
  let fnError: unknown = null;
  try {
    value = await fn();
  } catch (error) {
    fnError = error;
  }
  try {
    releaseLock(lockPath);
  } catch (releaseError) {
    if (fnError) {
      throw new Error(`Lock release failed after callback error: ${(releaseError as Error).message}`, { cause: fnError });
    }
    throw releaseError;
  }
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (fnError) throw fnError;
  return value!;
}
