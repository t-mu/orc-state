#!/usr/bin/env node
/**
 * cli/watch.ts
 * Usage:
 *   node cli/watch.ts [--interval-ms=5000] [--once]
 *
 * The cockpit dashboard, standalone (the cockpit's dashboard pane runs this
 * command). Every view is built from orc-state/client: a ProjectWatcher over
 * every registered project, never the state files. The project this command
 * runs for is listed first; without a running coordinator it is shown as stopped.
 */
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from 'ink';
import { createElement } from 'react';
import { ProjectWatcher, type ProjectListEntry, type ProjectWatchState, type ProjectWatchUpdate } from '../client.ts';
import { insideCockpit, openAgentTab, switchToMasterTab, type CockpitAgentTab } from '../adapters/tmuxCockpit.ts';
import { boolFlag, intFlag } from '../lib/args.ts';
import { renderBanner } from '../lib/banner.ts';
import { colorFormatStatus } from '../lib/colorStatus.ts';
import { STATE_DIR, TARGET_REPO_ROOT } from '../lib/paths.ts';
import { describeProjects, listProjects } from '../lib/projectList.ts';
import { cliError } from './shared.ts';
import type { AgentOpener } from '../lib/tui/App.tsx';
import type { DashboardAgent, DashboardProject } from '../lib/tui/dashboard.ts';

/** What `orc watch` reads: the client's `ProjectWatcher` (tests inject a fake). */
export interface WatchSource {
  start(): void;
  stop(): Promise<void>;
  projects(): ProjectWatchState[];
  onUpdate(listener: (update: ProjectWatchUpdate) => void): () => void;
}

export interface WatchOptions {
  intervalMs: number;
  once: boolean;
  /** State directory of the project shown in full. */
  stateDir: string;
  /** The watcher; a `ProjectWatcher` over the registry (plus `stateDir` when unregistered) by default. */
  source?: WatchSource;
  /** How long `--once` waits for the project's first connection to settle (default 5000 ms). */
  settleTimeoutMs?: number;
  /** Enter on an agent: open or switch to its terminal (set inside the cockpit). */
  onOpen?: AgentOpener;
}

const once = boolFlag('once');
const intervalMs = intFlag('interval-ms', 5000);

/**
 * The registered projects, plus `stateDir` itself when no registered project
 * owns it (an `ORC_STATE_DIR` without a registry), so it is still watched.
 */
export function watchedProjectList(stateDir: string, list: () => ProjectListEntry[] = () => listProjects()): () => ProjectListEntry[] {
  return () => {
    const listed = list();
    if (listed.some(entry => entry.state_dir === stateDir)) return listed;
    const [own] = describeProjects({
      list: () => [{ id: `unregistered:${stateDir}`, name: basename(stateDir), canonicalGitRoot: TARGET_REPO_ROOT, stateDir, createdAt: '' }],
    });
    return [...listed, own];
  };
}

export function createWatchSource(stateDir: string): WatchSource {
  return new ProjectWatcher({ listProjects: watchedProjectList(stateDir) });
}

/** Ids `watchedProjectList` gives a state directory no registered project owns. */
const UNREGISTERED_PREFIX = 'unregistered:';

/**
 * The cockpit tab of `agent`'s live terminal: `orc terminal <agent_id> --write`
 * for its project (`--project=<id>`, or `ORC_STATE_DIR` for an unregistered one).
 */
export function agentTab(agent: Pick<DashboardAgent, 'agent_id'>, project: Pick<DashboardProject, 'project_id' | 'name' | 'state_dir' | 'target_repo_root'>, orc: string[]): CockpitAgentTab {
  const unregistered = project.project_id.startsWith(UNREGISTERED_PREFIX);
  return {
    projectId: project.project_id,
    projectName: project.name,
    agentId: agent.agent_id,
    root: project.target_repo_root,
    command: [...orc, 'terminal', agent.agent_id, '--write', ...(unregistered ? [] : [`--project=${project.project_id}`])],
    env: unregistered ? { ORC_STATE_DIR: project.state_dir } : {},
  };
}

export interface CockpitTabs {
  openAgentTab: (tab: CockpitAgentTab) => 'opened' | 'switched';
  switchToMasterTab: (projectId: string) => boolean;
}

/** Enter in the cockpit: a master switches to its project's tab, any other agent to its own tab (opened on first use). */
export function cockpitOpener(orc: string[], tabs: CockpitTabs = { openAgentTab, switchToMasterTab }): AgentOpener {
  return (agent, project) => {
    if (agent.role === 'master') {
      if (!tabs.switchToMasterTab(project.project_id)) throw new Error(`${project.name} has no cockpit tab; run orc start-session in it`);
      return `switched to ${project.name}'s master`;
    }
    return tabs.openAgentTab(agentTab(agent, project, orc)) === 'opened'
      ? `opened ${agent.agent_id} in a new tab`
      : `switched to ${agent.agent_id}'s tab`;
  };
}

function currentProject(source: WatchSource, stateDir: string): ProjectWatchState | null {
  return source.projects().find(state => state.project.state_dir === stateDir) ?? null;
}

/** The first connect has settled: the project is not `connecting`, and a `running` project has its status. */
function settled(state: ProjectWatchState | null): boolean {
  if (!state) return true;
  if (state.connection === 'connecting') return false;
  return state.connection !== 'running' || state.status !== null;
}

/** Resolve once the project's first connection has settled, or after `timeoutMs`. */
export function waitForSettled(source: WatchSource, stateDir: string, timeoutMs: number): Promise<void> {
  if (settled(currentProject(source, stateDir))) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = source.onUpdate(() => {
      if (settled(currentProject(source, stateDir))) done();
    });
  });
}

function connectionLine(state: ProjectWatchState): string {
  const label = state.connection === 'stopped' ? 'stopped (coordinator not running)' : state.connection;
  return `coordinator: ${state.error ? `${label}: ${state.error}` : label}`;
}

/** The plain snapshot of `stateDir`'s project; false when it cannot be shown (not watched, unreachable, incompatible). */
export function renderPlainSnapshot(
  source: WatchSource,
  { intervalMs, stateDir }: Pick<WatchOptions, 'intervalMs' | 'stateDir'>,
  registryError: string | null = null,
): boolean {
  const state = currentProject(source, stateDir);
  process.stdout.write('\x1b[2J\x1b[H');
  if (process.stdout.isTTY) console.log(renderBanner());

  let ok: boolean;
  if (!state) {
    console.log(registryError ? `registry error: ${registryError}` : `project: not watched (${stateDir})`);
    ok = false;
  } else {
    ok = state.connection === 'running' || state.connection === 'stopped';
    if (state.status) {
      // The status names the project itself (`Orchestrator Status`, then the project line).
      // A project that is no longer running keeps its last status, as the TUI shows it.
      console.log(colorFormatStatus(state.status));
      console.log('');
      console.log(`${connectionLine(state)}${state.connection === 'running' ? '' : ' (showing last known status)'}`);
    } else {
      const { project } = state;
      console.log(`project: ${project.name} (${project.id}) → ${project.target_repo_root}`);
      console.log(connectionLine(state));
    }
  }

  const others = source.projects().filter(other => other.project.state_dir !== stateDir);
  if (others.length > 0) {
    console.log('');
    console.log(`Other projects (${others.length}):`);
    for (const other of others) console.log(`  ${other.project.name.padEnd(24)} ${other.connection}`);
  }

  console.log('');
  console.log(`watch interval: ${intervalMs}ms`);
  console.log(`updated at: ${new Date().toISOString()}`);
  return ok;
}

export async function runFallbackWatch(options: WatchOptions): Promise<number | null> {
  const source = options.source ?? createWatchSource(options.stateDir);
  let registryError: string | null = null;
  const unsubscribe = source.onUpdate((update) => {
    if (update.type === 'registry_error') registryError = update.error.message;
    else if (update.type === 'added' || update.type === 'removed') registryError = null;
  });
  source.start();

  if (options.once) {
    await waitForSettled(source, options.stateDir, options.settleTimeoutMs ?? 5000);
    const ok = renderPlainSnapshot(source, options, registryError);
    unsubscribe();
    await source.stop();
    return ok ? 0 : 1;
  }

  // Live: draw right away (the project may still be connecting) and redraw every interval.
  renderPlainSnapshot(source, options, registryError);
  const timer = setInterval(() => {
    renderPlainSnapshot(source, options, registryError);
  }, options.intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    unsubscribe();
    void source.stop().finally(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return null;
}

function runtimeImportPath(relativeTsPath: string, relativeJsPath: string): string {
  return import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath;
}

/** The cockpit dashboard (`lib/tui/App.tsx`) on its own: the view the cockpit's dashboard pane runs. */
export async function runTtyWatch(options: WatchOptions): Promise<number> {
  const { App } = await (import(runtimeImportPath('../lib/tui/App.tsx', '../lib/tui/App.js')) as Promise<typeof import('../lib/tui/App.tsx')>);

  const source = options.source ?? createWatchSource(options.stateDir);
  source.start();
  if (options.once) await waitForSettled(source, options.stateDir, options.settleTimeoutMs ?? 5000);

  const instance = render(createElement(App, {
    source,
    stateDir: options.stateDir,
    intervalMs: options.intervalMs,
    ...(options.onOpen ? { onOpen: options.onOpen } : {}),
  }));

  if (options.once) {
    await waitForFirstFrame();
    instance.unmount();
  }

  await instance.waitUntilExit();
  await source.stop();
  return 0;
}

function waitForFirstFrame(): Promise<void> {
  return new Promise(resolve => {
    setImmediate(resolve);
  });
}

export async function main(): Promise<number | null> {
  const options: WatchOptions = {
    once,
    intervalMs,
    stateDir: STATE_DIR,
  };

  if (!process.stdout.isTTY) {
    return runFallbackWatch(options);
  }
  if (insideCockpit()) {
    options.onOpen = cockpitOpener([process.execPath, fileURLToPath(new URL(runtimeImportPath('./orc.ts', './orc.js'), import.meta.url))]);
  }

  return runTtyWatch(options);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  void main()
    .then(code => {
      if (code !== null) {
        process.exit(code);
      }
    })
    .catch(error => {
      cliError(error);
    });
}
