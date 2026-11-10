#!/usr/bin/env node
/**
 * cli/cockpit.ts
 * Usage:
 *   orc cockpit project <project_id|next|prev>
 *   orc cockpit open <agent_id> [<project_id>]
 *   orc cockpit tab <n|master|agent_id>
 *   orc cockpit next | prev
 *   orc cockpit close [<agent_id>]
 *   orc cockpit attention
 *   orc cockpit tasks [close]
 *   orc cockpit state
 *   orc cockpit bar
 *   orc cockpit explorer <project_id>
 *   (each action takes --client=<tmux client>: report in that client's message line, as the cockpit keys do)
 *
 * Applies one cockpit tab transition (lib/cockpitTabs.ts) and its tmux side
 * effects (adapters/tmuxCockpit.ts). Runs only inside the cockpit: from its key
 * bindings, the sidebar, the tab bar, or a shell in one of its panes. `bar` is
 * what the tab bar pane runs: the active project's tabs, clickable.
 * `tasks` shows the task explorer in the slot (`tasks close` puts the active
 * tab back); `explorer` is what the explorer's pane runs.
 */
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlClient, ProjectWatcher, listProjects, type ProjectListEntry } from '../client.ts';
import {
  UNREGISTERED_PROJECT_PREFIX, applyCockpitTransition, cockpitAgentTab, cockpitMessage, cockpitRunning, cockpitStoppedProject, insideCockpit,
  focusCockpitSlot, openExplorer, readCockpitBar, readCockpitTabs, refreshCockpit, watchCockpitChanges,
  type AgentTabResolver, type CockpitBarView, type CockpitTabProject, type StoppedProjectResolver,
} from '../adapters/tmuxCockpit.ts';
import {
  closeTab, cycleProject, cycleTab, nextAttention, openAgent, selectTab, showProject, showableAttention,
  type AttentionAgent, type CockpitTabState, type OpenTab, type TabTransition,
} from '../lib/cockpitTabs.ts';
import { USAGE } from './usage.ts';

export type CockpitCommand =
  | { action: 'project'; target: string }
  | { action: 'open'; agentId: string; projectId: string | null }
  | { action: 'tab'; tab: number | string }
  | { action: 'next' | 'prev' }
  | { action: 'close'; agentId: string | null }
  | { action: 'attention' }
  | { action: 'tasks'; close: boolean }
  | { action: 'explorer'; projectId: string }
  | { action: 'state' }
  | { action: 'bar' };

/** The command and `--client`, or why the arguments are not one. */
export function parseCockpitArgs(argv: string[]): { command: CockpitCommand; client: string | null } | { error: string } {
  let client: string | null = null;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--client=')) client = arg.slice('--client='.length) || null;
    else if (arg.startsWith('-')) return { error: `unknown option '${arg}'` };
    else positional.push(arg);
  }
  const [action, first, second] = positional;
  const done = (command: CockpitCommand, allowed: number) => (positional.length - 1 > allowed
    ? { error: `too many arguments for '${action}'` }
    : { command, client });
  switch (action) {
    case 'project':
      return first ? done({ action, target: first }, 1) : { error: 'project needs a project id, next or prev' };
    case 'open':
      return first ? done({ action, agentId: first, projectId: second ?? null }, 2) : { error: 'open needs an agent id' };
    case 'tab':
      if (!first) return { error: 'tab needs a tab number, master or an agent id' };
      return done({ action, tab: /^\d+$/.test(first) ? Number(first) : first }, 1);
    case 'next':
    case 'prev':
    case 'attention':
    case 'state':
    case 'bar':
      return done({ action }, 0);
    case 'close':
      return done({ action, agentId: first ?? null }, 1);
    case 'tasks':
      if (first !== undefined && first !== 'close') return { error: `tasks takes only 'close', not '${first}'` };
      return done({ action, close: first === 'close' }, 1);
    case 'explorer':
      return first ? done({ action, projectId: first }, 1) : { error: 'explorer needs a project id' };
    case undefined:
      return { error: 'missing action' };
    default:
      return { error: `unknown action '${action}'` };
  }
}

/** The transition a command applies, given the open tabs; `waiting` is what `attention` cycles through (those it can show). */
export function cockpitTransition(command: Exclude<CockpitCommand, { action: 'state' | 'bar' | 'explorer' }>, waiting: AttentionAgent[] = []): (state: CockpitTabState, open: OpenTab[]) => TabTransition {
  switch (command.action) {
    case 'tasks':
      // Closing the explorer is this transition: it puts the active tab back, and the explorer's pane (out of the slot) is killed. Opening it is `openExplorer`.
      return (state) => ({ ok: true, state, message: command.close ? 'Closed the task explorer.' : 'Opened the task explorer.' });
    case 'project':
      if (command.target === 'next') return (state) => cycleProject(state, 1);
      if (command.target === 'prev') return (state) => cycleProject(state, -1);
      // A project the cockpit has no tab for is added; it shows how to start it.
      return (state) => showProject(state, command.target);
    case 'open':
      return (state) => {
        const projectId = command.projectId ?? state.activeProject;
        return projectId
          ? openAgent(state, projectId, command.agentId)
          : { ok: false, state, message: 'No project is open in the cockpit; name the project: orc cockpit open <agent_id> <project_id>.' };
      };
    case 'tab':
      return (state) => selectTab(state, command.tab);
    case 'next':
      return (state) => cycleTab(state, 1);
    case 'prev':
      return (state) => cycleTab(state, -1);
    case 'close':
      return (state) => closeTab(state, command.agentId);
    case 'attention':
      return (state, open) => nextAttention(state, showableAttention(waiting, open));
  }
}

/** A project an agent tab can open for: a registered one, or an unregistered state directory (`unregistered:<dir>`). */
export function tabProject(projectId: string, projects: ProjectListEntry[]): CockpitTabProject {
  const entry = projects.find((project) => project.id === projectId);
  if (entry) return { project_id: entry.id, name: entry.name, state_dir: entry.state_dir, target_repo_root: entry.target_repo_root };
  if (projectId.startsWith(UNREGISTERED_PROJECT_PREFIX)) {
    const stateDir = projectId.slice(UNREGISTERED_PROJECT_PREFIX.length);
    return { project_id: projectId, name: basename(stateDir), state_dir: stateDir, target_repo_root: process.cwd() };
  }
  throw new Error(`unknown project '${projectId}' (orc project list shows the registered ones)`);
}

const ATTENTION_ORDER = ['permission_prompt', 'question', 'stalled', 'no_progress'];
const STATUS_TIMEOUT_MS = 2_000;

/**
 * The agents needing attention, project by project (the cockpit's projects in
 * order, then the other registered ones), within a project by kind
 * (permission prompts first). Projects whose coordinator is not running or does
 * not answer in time are skipped.
 */
export async function waitingAgents(state: CockpitTabState, projects: ProjectListEntry[]): Promise<AttentionAgent[]> {
  const ids = [...state.projects.map((project) => project.projectId), ...projects.map((project) => project.id)];
  const order = ids.filter((id, index) => ids.indexOf(id) === index);
  const perProject = await Promise.all(order.map(async (projectId): Promise<AttentionAgent[]> => {
    const entry = projects.find((project) => project.id === projectId);
    if (entry && !entry.coordinator_running) return [];
    const stateDir = entry?.state_dir ?? (projectId.startsWith(UNREGISTERED_PROJECT_PREFIX) ? projectId.slice(UNREGISTERED_PROJECT_PREFIX.length) : null);
    if (!stateDir) return [];
    try {
      const status = await new ControlClient(stateDir).status({ events: 0 }, { timeoutMs: STATUS_TIMEOUT_MS });
      return status.worker_capacity.slots
        .filter((slot) => slot.attention)
        .sort((a, b) => ATTENTION_ORDER.indexOf(a.attention!.kind) - ATTENTION_ORDER.indexOf(b.attention!.kind))
        .map((slot) => ({ projectId, agentId: slot.agent_id, ...(slot.role === 'master' ? { master: true } : {}) }));
    } catch {
      return [];
    }
  }));
  return perProject.flat();
}

export interface CockpitDeps {
  inside: () => boolean;
  running: () => boolean;
  apply: typeof applyCockpitTransition;
  read: () => CockpitTabState;
  projects: () => ProjectListEntry[];
  waiting: (state: CockpitTabState, projects: ProjectListEntry[]) => Promise<AttentionAgent[]>;
  message: (client: string, text: string) => void;
  /** The tab bar's view, what puts a closed slot back, the change signal it redraws on, and what focuses the slot after a click. */
  bar: () => CockpitBarView;
  refresh: () => void;
  changes: (onChange: () => void) => () => void;
  focusSlot: () => void;
  /** Shows the task explorer of a project in the slot; 'switched' when it already is. */
  openExplorer: (projectId: string) => 'opened' | 'switched';
  /** The project watcher the explorer's and the tab bar's panes read the projects from. */
  watcher: () => ProjectWatcher;
  /** The command that runs orc, for the agent tabs it opens. */
  orc: string[];
  log: (line: string) => void;
  error: (line: string) => void;
}

function runtimeImportPath(relativeTsPath: string, relativeJsPath: string): string {
  return import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath;
}

/** The command that runs orc, for the panes this command opens. */
const cockpitOrc = (): string[] => [process.execPath, fileURLToPath(new URL(runtimeImportPath('./orc.ts', './orc.js'), import.meta.url))];

const defaultDeps = (): CockpitDeps => ({
  inside: () => insideCockpit(),
  running: cockpitRunning,
  apply: applyCockpitTransition,
  read: readCockpitTabs,
  projects: () => listProjects(),
  waiting: waitingAgents,
  message: cockpitMessage,
  bar: readCockpitBar,
  refresh: () => { refreshCockpit(); },
  changes: (onChange) => watchCockpitChanges(onChange),
  focusSlot: () => { focusCockpitSlot(); },
  openExplorer: (projectId) => openExplorer(projectId, cockpitOrc()),
  watcher: () => new ProjectWatcher({ listProjects: () => listProjects() }),
  orc: cockpitOrc(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

export const NOT_IN_COCKPIT = 'orc cockpit runs inside the cockpit: from its keys or a shell in one of its panes. orc start-session opens the cockpit.';

/**
 * Runs `orc cockpit`. Outside the cockpit it exits 1. With `--client` (a
 * cockpit key) the outcome goes to that client's message line and a refused
 * action exits 0, so tmux shows only the message; otherwise a refused or
 * failed action prints to stderr and exits 1.
 */
export async function runCockpit(argv: string[], deps: CockpitDeps = defaultDeps()): Promise<number> {
  const parsed = parseCockpitArgs(argv);
  if ('error' in parsed) {
    deps.error(`orc cockpit: ${parsed.error}\nUsage: ${USAGE.cockpit}`);
    return 1;
  }
  const { command, client } = parsed;
  if (!deps.inside() || !deps.running()) {
    deps.error(NOT_IN_COCKPIT);
    return 1;
  }
  const report = (ok: boolean, text: string): number => {
    if (client) {
      deps.message(client, text);
      return 0;
    }
    if (ok) deps.log(text);
    else deps.error(text);
    return ok ? 0 : 1;
  };
  try {
    if (command.action === 'state') {
      deps.log(JSON.stringify(deps.read()));
      return 0;
    }
    if (command.action === 'bar') return await runTabBar(deps);
    if (command.action === 'explorer') {
      // Loaded on demand: the explorer is a TSX view, and the other actions must not load it.
      const { runTaskExplorer } = await (import(runtimeImportPath('../lib/tui/ExplorerView.ts', '../lib/tui/ExplorerView.js')) as Promise<typeof import('../lib/tui/ExplorerView.ts')>);
      return await runTaskExplorer(command.projectId, deps.watcher());
    }
    if (command.action === 'tasks' && !command.close) {
      const state = deps.read();
      if (!state.activeProject) return report(false, 'No project is open in the cockpit; run orc start-session in one.');
      return report(true, deps.openExplorer(state.activeProject) === 'opened' ? 'Opened the task explorer.' : 'The task explorer is already shown.');
    }
    let projects: ProjectListEntry[] | null = null;
    const registered = () => (projects ??= deps.projects());
    const waiting = command.action === 'attention' ? await deps.waiting(deps.read(), registered()) : [];
    const resolve: AgentTabResolver = (projectId, agentId) => cockpitAgentTab(agentId, tabProject(projectId, registered()), deps.orc);
    const stopped: StoppedProjectResolver = (projectId) => cockpitStoppedProject(tabProject(projectId, registered()));
    const result = deps.apply(cockpitTransition(command, waiting), resolve, stopped);
    return report(result.ok, result.message);
  } catch (error) {
    return report(false, `orc cockpit: ${(error as Error).message}`);
  }
}

/**
 * Runs the tab bar (lib/tui/TabBar.tsx) until the pane closes: the active
 * project's tabs, redrawn when an action signals a change (and at the
 * sidebar's refresh otherwise), attention from the project watcher. A click
 * runs `orc cockpit tab` or `close`; a slot that was closed is put back.
 */
async function runTabBar(deps: CockpitDeps): Promise<number> {
  // Loaded on demand, as the explorer is: the other actions must not load Ink.
  const { runTabBar: runApp } = await (import(runtimeImportPath('../lib/tui/TabBar.tsx', '../lib/tui/TabBar.js')) as Promise<typeof import('../lib/tui/TabBar.tsx')>);
  const { runOrcCommand } = await (import(runtimeImportPath('./watch.ts', './watch.js')) as Promise<typeof import('./watch.ts')>);
  return runApp({
    read: () => {
      const view = deps.bar();
      if (view.slotMissing) deps.refresh();
      return view.state;
    },
    watcher: deps.watcher(),
    changes: deps.changes,
    actions: {
      select: (tab) => runOrcCommand([...deps.orc, 'cockpit', 'tab', tab]),
      close: (agentId) => runOrcCommand([...deps.orc, 'cockpit', 'close', agentId]),
      focusSlot: () => { deps.focusSlot(); },
    },
  });
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  void runCockpit(process.argv.slice(2)).then((code) => process.exit(code));
}
