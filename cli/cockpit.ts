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
 *   orc cockpit state
 *   (each takes --client=<tmux client>: report in that client's message line, as the cockpit keys do)
 *
 * Applies one cockpit tab transition (lib/cockpitTabs.ts) and its tmux side
 * effects (adapters/tmuxCockpit.ts). Runs only inside the cockpit: from its key
 * bindings, the dashboard, or a shell in one of its panes.
 */
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlClient, listProjects, type ProjectListEntry } from '../client.ts';
import {
  UNREGISTERED_PROJECT_PREFIX, applyCockpitTransition, cockpitAgentTab, cockpitMessage, cockpitRunning, insideCockpit, readCockpitTabs,
  type AgentTabResolver, type CockpitTabProject,
} from '../adapters/tmuxCockpit.ts';
import {
  closeTab, cycleProject, cycleTab, nextAttention, openAgent, selectProject, selectTab,
  type AttentionAgent, type CockpitTabState, type TabTransition,
} from '../lib/cockpitTabs.ts';
import { USAGE } from './usage.ts';

export type CockpitCommand =
  | { action: 'project'; target: string }
  | { action: 'open'; agentId: string; projectId: string | null }
  | { action: 'tab'; tab: number | string }
  | { action: 'next' | 'prev' }
  | { action: 'close'; agentId: string | null }
  | { action: 'attention' }
  | { action: 'state' };

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
      return done({ action }, 0);
    case 'close':
      return done({ action, agentId: first ?? null }, 1);
    case undefined:
      return { error: 'missing action' };
    default:
      return { error: `unknown action '${action}'` };
  }
}

/** The transition a command applies; `waiting` is what `attention` cycles through. */
export function cockpitTransition(command: Exclude<CockpitCommand, { action: 'state' }>, waiting: AttentionAgent[] = []): (state: CockpitTabState) => TabTransition {
  switch (command.action) {
    case 'project':
      if (command.target === 'next') return (state) => cycleProject(state, 1);
      if (command.target === 'prev') return (state) => cycleProject(state, -1);
      return (state) => selectProject(state, command.target);
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
      return (state) => nextAttention(state, waiting);
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
  /** The command that runs orc, for the agent tabs it opens. */
  orc: string[];
  log: (line: string) => void;
  error: (line: string) => void;
}

function runtimeImportPath(relativeTsPath: string, relativeJsPath: string): string {
  return import.meta.url.endsWith('.ts') ? relativeTsPath : relativeJsPath;
}

const defaultDeps = (): CockpitDeps => ({
  inside: () => insideCockpit(),
  running: cockpitRunning,
  apply: applyCockpitTransition,
  read: readCockpitTabs,
  projects: () => listProjects(),
  waiting: waitingAgents,
  message: cockpitMessage,
  orc: [process.execPath, fileURLToPath(new URL(runtimeImportPath('./orc.ts', './orc.js'), import.meta.url))],
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
    let projects: ProjectListEntry[] | null = null;
    const registered = () => (projects ??= deps.projects());
    const waiting = command.action === 'attention' ? await deps.waiting(deps.read(), registered()) : [];
    const resolve: AgentTabResolver = (projectId, agentId) => cockpitAgentTab(agentId, tabProject(projectId, registered()), deps.orc);
    const result = deps.apply(cockpitTransition(command, waiting), resolve);
    return report(result.ok, result.message);
  } catch (error) {
    return report(false, `orc cockpit: ${(error as Error).message}`);
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  void runCockpit(process.argv.slice(2)).then((code) => process.exit(code));
}
