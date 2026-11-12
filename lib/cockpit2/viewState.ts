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
 * renamed over it) while holding a lock file the CLI layer names (lockFile.ts),
 * so concurrent writers, in this cockpit or another process, never leave a
 * torn file or lose each other's changes. A missing or corrupt file loads as
 * the defaults.
 *
 * Another process adds a project to a running cockpit by writing it here
 * (`addProject`) and waking the cockpit (instance.ts), which takes the
 * projects it does not have yet (`mergeProjects`) on the wake-up and on every
 * save, so its own saves never drop them.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { EMPTY_COCKPIT_STATE, parseTabs, showProject, type CockpitTabState } from '../cockpitTabs.ts';
import { acquireLockFile, releaseLockFile } from './lockFile.ts';

export interface TmuxTarget { socket: string; session: string }

export interface ViewState {
  tabs: CockpitTabState;
  /** Each project's master target as last seen from its running coordinator, by project id. */
  masterTargets: Record<string, TmuxTarget>;
  /** The sidebar's width as the user dragged it; absent for the default. */
  sidebarCols?: number;
  /** What each agent session tab (`agent:N`, explorer.ts) runs, by project id then tab id; absent when there are none. */
  agentTabs?: AgentTabs;
}

/** An agent session tab's provider and the custom agent it was started as (null for a fresh session). */
export interface AgentTabInfo { provider: string; agent: string | null }
export type AgentTabs = Record<string, Record<string, AgentTabInfo>>;

export const DEFAULT_VIEW_STATE: ViewState = { tabs: EMPTY_COCKPIT_STATE, masterTargets: {} };

const VERSION = 1;

export function serializeViewState(state: ViewState): string {
  const sidebar = state.sidebarCols === undefined ? {} : { sidebarCols: state.sidebarCols };
  const agentTabs = Object.fromEntries(Object.entries(state.agentTabs ?? {}).filter(([, tabs]) => Object.keys(tabs).length > 0));
  const agents = Object.keys(agentTabs).length ? { agentTabs } : {};
  return `${JSON.stringify({ v: VERSION, ...state.tabs, masterTargets: state.masterTargets, ...sidebar, ...agents }, null, 2)}\n`;
}

const isTarget = (value: unknown): value is TmuxTarget => {
  const { socket, session } = (value ?? {}) as Record<string, unknown>;
  return typeof socket === 'string' && socket !== '' && typeof session === 'string' && session !== '';
};

/** A stored view state; the defaults when `raw` is missing or not a valid one. Invalid master targets are dropped. */
export function parseViewState(raw: string | null | undefined): ViewState {
  const tabs = parseTabs(raw);
  if (!tabs) return DEFAULT_VIEW_STATE;
  const parsed = JSON.parse(raw as string) as { masterTargets?: unknown; sidebarCols?: unknown; agentTabs?: unknown };
  const stored = parsed.masterTargets;
  const masterTargets: Record<string, TmuxTarget> = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [projectId, target] of Object.entries(stored)) {
      if (isTarget(target)) masterTargets[projectId] = { socket: target.socket, session: target.session };
    }
  }
  const width = parsed.sidebarCols;
  const sidebar = typeof width === 'number' && Number.isInteger(width) && width >= MIN_SIDEBAR_COLS && width <= MAX_SIDEBAR_COLS ? { sidebarCols: width } : {};
  const agentTabs = parseAgentTabs(parsed.agentTabs);
  return { tabs, masterTargets, ...sidebar, ...(Object.keys(agentTabs).length ? { agentTabs } : {}) };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Stored agent session tabs; an entry that is not a provider and an agent name (or null) is dropped. */
function parseAgentTabs(stored: unknown): AgentTabs {
  const result: AgentTabs = {};
  if (!isRecord(stored)) return result;
  for (const [projectId, tabs] of Object.entries(stored)) {
    if (!isRecord(tabs)) continue;
    for (const [tabId, info] of Object.entries(tabs)) {
      if (!isRecord(info) || typeof info.provider !== 'string' || !(info.agent === null || typeof info.agent === 'string')) continue;
      (result[projectId] ??= {})[tabId] = { provider: info.provider, agent: info.agent };
    }
  }
  return result;
}

/** The range a dragged sidebar width is kept in. */
export const MIN_SIDEBAR_COLS = 24;
export const MAX_SIDEBAR_COLS = 60;

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
      const token = await acquireLockFile(lockPath, {
        token: `${process.pid} ${randomBytes(8).toString('hex')}\n`,
        timeoutMs,
        // A writer holds the lock for milliseconds: an old one was left by a crashed writer.
        isStale: (file) => { try { return Date.now() - statSync(file).mtimeMs > staleMs; } catch { return false; } },
        heldMessage: (file) => `the view state is locked by another writer (${file})`,
      });
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
        releaseLockFile(lockPath, token);
      }
    },
  };
}

/**
 * `ours` with the projects only `stored` has appended in their stored order:
 * another process added them (no transition removes a project), so a save or
 * a reload keeps them. Ours win for every project both have.
 */
export function mergeProjects(ours: CockpitTabState, stored: CockpitTabState): CockpitTabState {
  const known = new Set(ours.projects.map((project) => project.projectId));
  const added = stored.projects.filter((project) => !known.has(project.projectId));
  if (added.length === 0) return ours;
  return { ...ours, projects: [...ours.projects, ...added.map((project) => ({ ...project, tabs: [...project.tabs] }))] };
}

/** Adds `projectId` to the stored view state and makes it the active project, as a running cockpit then shows it. */
export function addProject(store: ViewStateStore, projectId: string): Promise<ViewState> {
  return store.update((stored) => ({ ...stored, tabs: showProject(stored.tabs, projectId).state }));
}
