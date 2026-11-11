/**
 * lib/cockpit2/viewState.ts — the cockpit's view state on disk.
 *
 * `cockpit/view-state.json` under orc's data home (the path comes from the CLI
 * layer) keeps what the cockpit shows: its projects, each project's open tabs
 * and active tab, the active project, and each project's last known master
 * tmux target, so a restarted cockpit reopens the same tabs and can show a
 * master whose coordinator is down. It never holds orchestration state.
 *
 * Saves replace the file atomically (a 0600 temp file renamed over it) while
 * holding `<path>.lock`, so concurrent saves, from this cockpit or another
 * process, never leave a torn or mixed file. A missing or corrupt file loads
 * as the defaults.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
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
  /** Replaces the stored state atomically under the lock. */
  save(state: ViewState): Promise<void>;
}

export interface ViewStateStoreOptions {
  /** How long a save waits for the lock before it fails (default 5 s). */
  lockTimeoutMs?: number;
  /** A lock file older than this was left by a crashed writer and is taken over (default 10 s). */
  staleLockMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireLock(lockPath: string, timeoutMs: number, staleMs: number): Promise<number> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeSync(fd, `${process.pid}\n`);
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue; }
    } catch { continue; /* released meanwhile */ }
    if (Date.now() > until) throw new Error(`view state is locked by another writer (${lockPath})`);
    await sleep(5 + Math.random() * 10);
  }
}

/** The store at `path` (`cockpit/view-state.json` under orc's data home); its directory is created 0700 on first save. */
export function createViewStateStore(path: string, options: ViewStateStoreOptions = {}): ViewStateStore {
  const lockPath = `${path}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? 5_000;
  const staleMs = options.staleLockMs ?? 10_000;
  return {
    load() {
      try {
        return parseViewState(readFileSync(path, 'utf8'));
      } catch {
        return DEFAULT_VIEW_STATE;
      }
    },
    async save(state) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const lock = await acquireLock(lockPath, timeoutMs, staleMs);
      const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        const fd = openSync(temp, 'wx', 0o600);
        try {
          writeSync(fd, serializeViewState(state));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, path);
      } catch (error) {
        try { unlinkSync(temp); } catch { /* never created */ }
        throw error;
      } finally {
        closeSync(lock);
        try { unlinkSync(lockPath); } catch { /* taken over as stale */ }
      }
    },
  };
}
