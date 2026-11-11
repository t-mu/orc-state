/**
 * lib/cockpit2/viewState.ts — the cockpit's view state on disk.
 *
 * `cockpit/view-state.json` under orc's data home (the path comes from the CLI
 * layer) keeps what the cockpit shows: its projects, each project's open tabs
 * and active tab, the active project, and each project's last known master
 * tmux target, so a restarted cockpit reopens the same tabs and can show a
 * master whose coordinator is down. It never holds orchestration state.
 *
 * Updates read, change and replace the file atomically (a 0600 temp file
 * renamed over it) while holding a lock file the CLI layer names, so
 * concurrent writers, in this cockpit or another process, never leave a torn
 * file or lose each other's changes. A missing or corrupt file loads as the
 * defaults.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMPTY_COCKPIT_STATE, parseTabs, type CockpitTabState } from '../cockpitTabs.ts';

export interface TmuxTarget { socket: string; session: string }

export interface ViewState {
  tabs: CockpitTabState;
  /** Each project's master target as last seen from its running coordinator, by project id. */
  masterTargets: Record<string, TmuxTarget>;
}

export const DEFAULT_VIEW_STATE: ViewState = { tabs: EMPTY_COCKPIT_STATE, masterTargets: {} };

const VERSION = 1;

export function serializeViewState(state: ViewState): string {
  return `${JSON.stringify({ v: VERSION, ...state.tabs, masterTargets: state.masterTargets }, null, 2)}\n`;
}

const isTarget = (value: unknown): value is TmuxTarget => {
  const { socket, session } = (value ?? {}) as Record<string, unknown>;
  return typeof socket === 'string' && socket !== '' && typeof session === 'string' && session !== '';
};

/** A stored view state; the defaults when `raw` is missing or not a valid one. Invalid master targets are dropped. */
export function parseViewState(raw: string | null | undefined): ViewState {
  const tabs = parseTabs(raw);
  if (!tabs) return DEFAULT_VIEW_STATE;
  const stored = (JSON.parse(raw as string) as { masterTargets?: unknown }).masterTargets;
  const masterTargets: Record<string, TmuxTarget> = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [projectId, target] of Object.entries(stored)) {
      if (isTarget(target)) masterTargets[projectId] = { socket: target.socket, session: target.session };
    }
  }
  return { tabs, masterTargets };
}

export interface ViewStateStore {
  /** The stored state, or the defaults when the file is missing or corrupt. */
  load(): ViewState;
  /**
   * Reads the stored state, changes it with `change` and writes the result,
   * all under the lock, so a change another writer made in between is seen
   * by `change` and not lost. Resolves with what was written.
   */
  update(change: (stored: ViewState) => ViewState): Promise<ViewState>;
}

export interface ViewStateStoreOptions {
  /** The view-state file (`cockpit/view-state.json` under orc's data home). */
  path: string;
  /** The lock file held while the view state is written; passed in by the CLI layer with the path. */
  lockPath: string;
  /** How long an update waits for the lock before it fails (default 2 s). */
  lockTimeoutMs?: number;
  /** A lock file older than this was left by a crashed writer and is taken over (default 10 s). */
  staleLockMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const readToken = (lockPath: string): string | null => {
  try { return readFileSync(lockPath, 'utf8'); } catch { return null; }
};

/**
 * Takes the lock: creates `lockPath` exclusively with a unique token in it.
 * A stale lock is renamed aside (only one waiter can win that rename) and,
 * when what was moved turns out to be a fresh lock after all, put back.
 */
async function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): Promise<string> {
  const token = `${process.pid} ${randomBytes(8).toString('hex')}\n`;
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, token); } finally { closeSync(fd); }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let stale = false;
    try { stale = Date.now() - statSync(lockPath).mtimeMs > staleMs; } catch { continue; /* released meanwhile */ }
    if (stale) {
      const aside = `${lockPath}.${randomBytes(4).toString('hex')}.stale`;
      try { renameSync(lockPath, aside); } catch { continue; /* another waiter took it over */ }
      try {
        // Moved a lock taken between the stat and the rename: give it back (fails when a newer one exists).
        if (Date.now() - statSync(aside).mtimeMs <= staleMs) linkSync(aside, lockPath);
      } catch { /* a newer lock exists, or the aside is gone */ }
      try { unlinkSync(aside); } catch { /* gone */ }
      continue;
    }
    if (Date.now() > until) throw new Error(`the view state is locked by another writer (${lockPath})`);
    await sleep(5 + Math.random() * 10);
  }
}

/** Releases the lock only while it still holds this writer's token (it may have been taken over as stale). */
function releaseLock(lockPath: string, token: string): void {
  if (readToken(lockPath) !== token) return;
  try { unlinkSync(lockPath); } catch { /* gone */ }
}

function readState(path: string): ViewState {
  try {
    return parseViewState(readFileSync(path, 'utf8'));
  } catch {
    return DEFAULT_VIEW_STATE;
  }
}

/** The store at `options.path`; its directory is created 0700 on first write. */
export function createViewStateStore(options: ViewStateStoreOptions): ViewStateStore {
  const { path, lockPath } = options;
  const timeoutMs = options.lockTimeoutMs ?? 2_000;
  const staleMs = options.staleLockMs ?? 10_000;
  return {
    load: () => readState(path),
    async update(change) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
      const token = await acquireLock(lockPath, timeoutMs, staleMs);
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        const next = change(readState(path));
        const fd = openSync(temp, 'wx', 0o600);
        try {
          writeSync(fd, serializeViewState(next));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, path);
        return next;
      } catch (error) {
        try { unlinkSync(temp); } catch { /* never created */ }
        throw error;
      } finally {
        releaseLock(lockPath, token);
      }
    },
  };
}
