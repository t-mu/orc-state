/**
 * lib/cockpit2/instance.ts — one cockpit per user.
 *
 * A running cockpit holds the instance lock (`cockpit/cockpit2.lock` under
 * orc's data home; the CLI layer passes the path): a lock file (lockFile.ts)
 * holding its pid and process start time. A new cockpit claiming the lock:
 * - finds no lock, or a stale one (its pid is dead, or reused by another
 *   process: the start time differs), and takes it silently;
 * - finds a live cockpit, and asks it to exit (takeover): it writes an exit
 *   request next to the lock naming itself and wakes the holder, which sees
 *   the request, quits and releases the lock; the claim fails when the holder
 *   does not let go in time.
 *
 * A wake-up without an exit request asks a running cockpit to reload its view
 * state: how another process adds a project to it (viewState.ts `addProject`).
 * The process checks (`isRunning`) and the wake-up (a signal) are passed in by
 * the CLI layer.
 */
import { randomBytes } from 'node:crypto';
import { statSync, unlinkSync, writeFileSync } from 'node:fs';
import { acquireLockFile, readLockFile, releaseLockFile } from './lockFile.ts';

/** A cockpit process: its pid and process start time, so a reused pid is told apart. */
export interface InstanceHolder { pid: number; start: string }

export interface InstanceOptions {
  /** The instance lock file. */
  lockPath: string;
  /** This process. */
  self: InstanceHolder;
  /** Whether the process still runs: its pid is alive and has the same start time. */
  isRunning: (holder: InstanceHolder) => boolean;
  /** Wakes a running cockpit (the CLI layer sends a signal): it then exits when asked to, else reloads its view state. */
  wake(holder: InstanceHolder): void;
  /** How long a takeover waits for the running cockpit to exit (default 5 s). */
  timeoutMs?: number;
  /** The pause between two looks at the lock (default 50 ms). */
  pollMs?: number;
}

export interface InstanceClaim {
  /** The running cockpit that was asked to exit, or null when none ran. */
  replaced: InstanceHolder | null;
  /** Releases the lock while this cockpit still holds it; idempotent. */
  release: () => void;
}

/** A lock file this young that holds no valid holder may be mid-write; an older one was left broken. */
const TORN_LOCK_MS = 10_000;

/** The exit request a cockpit taking over writes next to the lock. */
export const exitRequestPath = (lockPath: string) => `${lockPath}.exit`;

/** The holder a lock file or exit request names, or null when it names none. */
export function parseHolder(text: string | null): InstanceHolder | null {
  if (!text) return null;
  try {
    const { pid, start } = JSON.parse(text) as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || typeof start !== 'string' || start === '') return null;
    return { pid: pid as number, start };
  } catch {
    return null;
  }
}

const sameHolder = (a: InstanceHolder, b: InstanceHolder) => a.pid === b.pid && a.start === b.start;

/** The cockpit holding the lock while it still runs, else null. */
export function liveInstance(lockPath: string, isRunning: (holder: InstanceHolder) => boolean): InstanceHolder | null {
  const holder = parseHolder(readLockFile(lockPath));
  return holder && isRunning(holder) ? holder : null;
}

/** Whether a running cockpit other than `self` asked this one to exit. */
export function exitRequested(lockPath: string, self: InstanceHolder, isRunning: (holder: InstanceHolder) => boolean): boolean {
  const requester = parseHolder(readLockFile(exitRequestPath(lockPath)));
  return !!requester && !sameHolder(requester, self) && isRunning(requester);
}

/** Takes the instance lock for `self`, taking over a stale lock silently and asking a running cockpit to exit. */
export async function claimInstance(options: InstanceOptions): Promise<InstanceClaim> {
  const { lockPath, self, isRunning } = options;
  const token = `${JSON.stringify({ pid: self.pid, start: self.start, nonce: randomBytes(6).toString('hex') })}\n`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let replaced: InstanceHolder | null = null;
  let held: InstanceHolder | null = null;
  await acquireLockFile(lockPath, {
    token,
    timeoutMs,
    pollMs: options.pollMs ?? 50,
    isStale(file) {
      const text = readLockFile(file);
      if (text === null) return false;
      const holder = parseHolder(text);
      if (holder) return !isRunning(holder);
      try { return Date.now() - statSync(file).mtimeMs > TORN_LOCK_MS; } catch { return false; }
    },
    onHeld(file) {
      held = parseHolder(readLockFile(file));
      // Asked once per holder: the request stays until the next cockpit holds the lock.
      if (!held || (replaced && sameHolder(replaced, held))) return;
      replaced = held;
      writeFileSync(exitRequestPath(lockPath), `${JSON.stringify(self)}\n`, { mode: 0o600 });
      options.wake(held);
    },
    heldMessage: () => {
      const pid = held?.pid;
      return `the cockpit running as pid ${pid ?? '?'} did not exit within ${timeoutMs / 1000} s (lock ${lockPath}); close it, or end it with kill ${pid ?? '<pid>'} (docs/recovery.md)`;
    },
  });
  // The request is answered: a later wake-up of this cockpit is a reload.
  try { unlinkSync(exitRequestPath(lockPath)); } catch { /* none was written */ }
  return { replaced, release: () => releaseLockFile(lockPath, token) };
}
