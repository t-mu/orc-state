/**
 * lib/cockpit2/lockFile.ts — the cockpit's lock files: the view-state write
 * lock (viewState.ts) and the single-instance lock (instance.ts).
 *
 * A lock is a file created exclusively (`wx`, mode 0600) holding its owner's
 * token; it is released only while it still holds that token, so an owner
 * whose lock was taken over never removes its successor's. A lock the caller's
 * `isStale` rejects is renamed aside (only one waiter can win that rename);
 * when what was moved turns out not to be stale after all, it is put back.
 *
 * Why not lib/lock.ts: that lock guards orchestration state, synchronously,
 * and fails at once while a live process holds it. The cockpit's locks wait
 * (asynchronously, so the cockpit keeps drawing) and decide staleness per
 * use: the view-state lock by age (a writer holds it for milliseconds), the
 * instance lock by its holder's pid and process start time (a cockpit holds
 * it for hours, and a reused pid must not keep it).
 */
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export interface LockOptions {
  /** What the lock file holds while this owner has it; unique per acquisition. */
  token: string;
  /** How long to wait for the lock before failing. */
  timeoutMs: number;
  /** Whether the lock file at `path` was left by an owner that no longer holds it. A file that is gone is not stale. */
  isStale(path: string): boolean;
  /** Called on every wait while a lock that is not stale is held (the instance lock asks its holder to exit here). */
  onHeld?(path: string): void;
  /** The error message when the wait times out. */
  heldMessage(path: string): string;
  /** The pause between two attempts (default 5 to 15 ms). */
  pollMs?: number;
}

export const readLockFile = (path: string): string | null => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Takes the lock at `lockPath`, waiting while another owner holds it; resolves with the token written. */
export async function acquireLockFile(lockPath: string, options: LockOptions): Promise<string> {
  const { token } = options;
  const until = Date.now() + options.timeoutMs;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 }); // the first cockpit on a fresh data home
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, token); } finally { closeSync(fd); }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (options.isStale(lockPath)) {
      const aside = `${lockPath}.${randomBytes(4).toString('hex')}.stale`;
      try { renameSync(lockPath, aside); } catch { continue; /* released, or another waiter took it over */ }
      try {
        // Moved a lock taken between the check and the rename: give it back (fails when a newer one exists).
        if (!options.isStale(aside)) linkSync(aside, lockPath);
      } catch { /* a newer lock exists, or the aside is gone */ }
      try { unlinkSync(aside); } catch { /* gone */ }
      continue;
    }
    if (readLockFile(lockPath) === null) continue; // released meanwhile
    options.onHeld?.(lockPath);
    if (Date.now() > until) throw new Error(options.heldMessage(lockPath));
    await sleep(options.pollMs ?? 5 + Math.random() * 10);
  }
}

/** Releases the lock only while it still holds `token` (it may have been taken over as stale). */
export function releaseLockFile(lockPath: string, token: string): void {
  if (readLockFile(lockPath) !== token) return;
  try { unlinkSync(lockPath); } catch { /* gone */ }
}
