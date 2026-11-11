/**
 * lib/cockpitTabs.ts
 *
 * The cockpit's view state and its transitions, pure: which project is active
 * and, per project, its open tabs (the master tab first, then agent tabs in
 * opening order) and its active tab. The cockpit (lib/cockpit2/app.ts)
 * applies them and keeps the state in its view-state file
 * (lib/cockpit2/viewState.ts).
 */

/** The master tab's id. Agent tabs are named by agent id. */
export const MASTER_TAB = 'master';

export interface ProjectTabs {
  projectId: string;
  /** Open agent tabs, by agent id, in opening order; the master tab is always open and not listed. */
  tabs: string[];
  /** The active tab: an agent id from `tabs`, or null for the master tab. */
  active: string | null;
}

export interface CockpitTabState {
  /** The active project's id; null only while no project is open. */
  activeProject: string | null;
  /** The cockpit's projects in the order they were added. */
  projects: ProjectTabs[];
}

export const EMPTY_COCKPIT_STATE: CockpitTabState = { activeProject: null, projects: [] };

/** A transition's outcome: the next state and what happened, or why it was refused (the state unchanged). */
export type TabTransition =
  | { ok: true; state: CockpitTabState; message: string }
  | { ok: false; state: CockpitTabState; message: string };

/** An agent that needs a human, as `nextAttention` cycles through them; `master` for a project's master. */
export interface AttentionAgent { projectId: string; agentId: string; master?: boolean }

const ok = (state: CockpitTabState, message: string): TabTransition => ({ ok: true, state, message });
const refused = (state: CockpitTabState, message: string): TabTransition => ({ ok: false, state, message });

function findProject(state: CockpitTabState, projectId: string | null): ProjectTabs | null {
  return state.projects.find((project) => project.projectId === projectId) ?? null;
}

function withProject(state: CockpitTabState, next: ProjectTabs, activate = true): CockpitTabState {
  const present = state.projects.some((project) => project.projectId === next.projectId);
  return {
    activeProject: activate ? next.projectId : state.activeProject,
    projects: present
      ? state.projects.map((project) => (project.projectId === next.projectId ? next : project))
      : [...state.projects, next],
  };
}

const tabLabel = (agentId: string | null) => (agentId === null ? 'the master tab' : `${agentId}'s tab`);

/** The active project's tabs, or a refusal when no project is open. */
function activeProject(state: CockpitTabState): ProjectTabs | TabTransition {
  return findProject(state, state.activeProject) ?? refused(state, 'No project is open in the cockpit; run orc start-session in one.');
}

const isProject = (value: ProjectTabs | TabTransition): value is ProjectTabs => 'projectId' in value;

/** Make `projectId` the active project; its tabs and active tab are as it left them. */
export function selectProject(state: CockpitTabState, projectId: string): TabTransition {
  const project = findProject(state, projectId);
  if (!project) return refused(state, `Unknown project '${projectId}': it has no tab in the cockpit; run orc start-session in it.`);
  return ok({ ...state, activeProject: projectId }, `Switched to project ${projectId}.`);
}

/**
 * Make `projectId` the active project, adding it (master tab only) when the
 * cockpit has no tab for it: the cockpit then shows that it is not running.
 */
export function showProject(state: CockpitTabState, projectId: string): TabTransition {
  if (!projectId) return refused(state, 'Showing a project needs a project id.');
  if (findProject(state, projectId)) return selectProject(state, projectId);
  return ok(withProject(state, { projectId, tabs: [], active: null }), `Switched to project ${projectId}.`);
}

/** Make the next (`delta` 1) or previous (-1) project active, wrapping around. */
export function cycleProject(state: CockpitTabState, delta: 1 | -1): TabTransition {
  if (state.projects.length === 0) return refused(state, 'No project is open in the cockpit; run orc start-session in one.');
  const index = state.projects.findIndex((project) => project.projectId === state.activeProject);
  const next = state.projects[(Math.max(index, 0) + delta + state.projects.length) % state.projects.length];
  return selectProject(state, next.projectId);
}

/**
 * Show `agentId`'s tab in `projectId`: activate it when open, else open it after
 * the project's other tabs. The project becomes active; one the cockpit has no
 * tabs for yet is added (its master tab first).
 */
export function openAgent(state: CockpitTabState, projectId: string, agentId: string): TabTransition {
  if (!projectId || !agentId) return refused(state, 'Opening a tab needs a project and an agent id.');
  const project = findProject(state, projectId) ?? { projectId, tabs: [], active: null };
  if (project.tabs.includes(agentId)) {
    return ok(withProject(state, { ...project, active: agentId }), `Switched to ${agentId}'s tab.`);
  }
  return ok(withProject(state, { ...project, tabs: [...project.tabs, agentId], active: agentId }), `Opened ${agentId} in a new tab.`);
}

/** The active project's tabs in order: the master tab (null) first. */
function orderedTabs(project: ProjectTabs): (string | null)[] {
  return [null, ...project.tabs];
}

/**
 * Activate a tab of the active project: by its 1-based position (`1` is the
 * master tab), or by id (`master` or an open agent tab's agent id).
 */
export function selectTab(state: CockpitTabState, tab: number | string): TabTransition {
  const project = activeProject(state);
  if (!isProject(project)) return project;
  let target: string | null;
  if (typeof tab === 'number') {
    const tabs = orderedTabs(project);
    if (!Number.isInteger(tab) || tab < 1 || tab > tabs.length) {
      return refused(state, `No tab ${tab}: the project has ${tabs.length} tab${tabs.length === 1 ? '' : 's'}.`);
    }
    target = tabs[tab - 1];
  } else if (tab === MASTER_TAB) {
    target = null;
  } else if (project.tabs.includes(tab)) {
    target = tab;
  } else {
    return refused(state, `No tab for agent '${tab}' in this project; open it from the sidebar.`);
  }
  return ok(withProject(state, { ...project, active: target }), `Switched to ${tabLabel(target)}.`);
}

/** Activate the active project's next (`delta` 1) or previous (-1) tab, wrapping around. */
export function cycleTab(state: CockpitTabState, delta: 1 | -1): TabTransition {
  const project = activeProject(state);
  if (!isProject(project)) return project;
  const tabs = orderedTabs(project);
  const index = Math.max(0, tabs.indexOf(project.active));
  return selectTab(state, ((index + delta + tabs.length) % tabs.length) + 1);
}

/**
 * Close an agent tab of the active project (the active tab when `agentId` is
 * omitted). The master tab never closes. Closing the active tab activates the
 * tab that takes its place (the next one), else the one before it.
 */
export function closeTab(state: CockpitTabState, agentId?: string | null): TabTransition {
  const project = activeProject(state);
  if (!isProject(project)) return project;
  const target = agentId === undefined || agentId === null ? project.active : agentId === MASTER_TAB ? null : agentId;
  if (target === null) return refused(state, 'The master tab stays open; close agent tabs only.');
  const index = project.tabs.indexOf(target);
  if (index < 0) return refused(state, `No tab for agent '${target}' in this project.`);
  const tabs = project.tabs.filter((tab) => tab !== target);
  const active = project.active === target ? (tabs[index] ?? tabs[index - 1] ?? null) : project.active;
  return ok(withProject(state, { ...project, tabs, active }), `Closed ${target}'s tab; ${tabLabel(active)} is active.`);
}

/**
 * Show the next agent needing attention: the one after the shown tab in
 * `waiting` (in the order given, wrapping around), else the first. Its project
 * becomes active; an agent's tab opens when it has none, a master's project
 * shows its master tab. Nothing changes when no agent is waiting.
 */
export function nextAttention(state: CockpitTabState, waiting: AttentionAgent[]): TabTransition {
  if (waiting.length === 0) return ok(state, 'No agent needs attention.');
  const shown = findProject(state, state.activeProject);
  const index = shown
    ? waiting.findIndex((agent) => agent.projectId === shown.projectId && (agent.master ? shown.active === null : agent.agentId === shown.active))
    : -1;
  const next = waiting[(index + 1) % waiting.length];
  if (!next.master) return openAgent(state, next.projectId, next.agentId);
  const project = findProject(state, next.projectId) ?? { projectId: next.projectId, tabs: [], active: null };
  return ok(withProject(state, { ...project, active: null }), `Switched to ${next.projectId}'s master.`);
}

/**
 * The waiting agents the cockpit can show: a master only when its project has
 * a master tab open (an agent tab opens on demand). Otherwise a waiting master
 * of a project with no tab would be picked, and refused, on every press.
 */
export function showableAttention(waiting: AttentionAgent[], open: OpenTab[]): AttentionAgent[] {
  return waiting.filter((agent) => !agent.master || open.some((tab) => tab.projectId === agent.projectId && tab.agentId === null));
}

/** One cockpit tab as its window shows it: a project's master tab (`agentId` null) or an agent tab. */
export interface OpenTab { projectId: string; agentId: string | null }

/**
 * The state made consistent with the tabs actually open (in window order):
 * tabs whose window is gone are dropped (a project with no window left
 * altogether too), open windows the state does not list are added after the
 * listed ones, an active tab that was dropped falls back to the master tab,
 * and the tab `shown` (the cockpit's current window) becomes the active one,
 * so a click or a plain tmux key that changed the window is kept. A missing or
 * unreadable stored state is rebuilt from the windows alone this way.
 */
export function reconcileTabs(state: CockpitTabState, open: OpenTab[], shown: OpenTab | null): CockpitTabState {
  const order: string[] = [];
  for (const project of [...state.projects.map((entry) => entry.projectId), ...open.map((tab) => tab.projectId)]) {
    if (open.some((tab) => tab.projectId === project) && !order.includes(project)) order.push(project);
  }
  const projects = order.map((projectId): ProjectTabs => {
    const stored = findProject(state, projectId);
    const windows = open.filter((tab) => tab.projectId === projectId && tab.agentId !== null).map((tab) => tab.agentId as string);
    const tabs = [...(stored?.tabs ?? []).filter((agentId) => windows.includes(agentId)), ...windows.filter((agentId) => !stored?.tabs.includes(agentId))];
    const uniqueTabs = tabs.filter((agentId, index) => tabs.indexOf(agentId) === index);
    const active = stored?.active != null && uniqueTabs.includes(stored.active) ? stored.active : null;
    return { projectId, tabs: uniqueTabs, active };
  });
  let activeProjectId = state.activeProject && order.includes(state.activeProject) ? state.activeProject : (order[0] ?? null);
  if (shown && order.includes(shown.projectId)) {
    activeProjectId = shown.projectId;
    const project = projects.find((entry) => entry.projectId === shown.projectId)!;
    if (shown.agentId === null || project.tabs.includes(shown.agentId)) project.active = shown.agentId;
  }
  return { activeProject: activeProjectId, projects };
}

/** Agent tabs open in `before` and gone in `after`: the windows to close. */
export function closedTabs(before: CockpitTabState, after: CockpitTabState): OpenTab[] {
  return before.projects.flatMap((project) => {
    const kept = findProject(after, project.projectId)?.tabs ?? [];
    return project.tabs.filter((agentId) => !kept.includes(agentId)).map((agentId) => ({ projectId: project.projectId, agentId }));
  });
}

/** The tab the cockpit shows: the active project's active tab; null while no project is open. */
export function shownTab(state: CockpitTabState): OpenTab | null {
  const project = findProject(state, state.activeProject);
  return project ? { projectId: project.projectId, agentId: project.active } : null;
}

/** The state as stored in the cockpit server option. */
export function serializeTabs(state: CockpitTabState): string {
  return JSON.stringify({ v: 1, ...state });
}

/** A stored state, or null when it is missing or not a valid one (then it is rebuilt from the windows). */
export function parseTabs(raw: string | null | undefined): CockpitTabState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { v, activeProject, projects } = parsed as Record<string, unknown>;
  if (v !== 1 || !(activeProject === null || typeof activeProject === 'string') || !Array.isArray(projects)) return null;
  const valid = projects.every((project: unknown) => {
    if (!project || typeof project !== 'object') return false;
    const { projectId, tabs, active } = project as Record<string, unknown>;
    return typeof projectId === 'string' && projectId !== ''
      && Array.isArray(tabs) && tabs.every((tab) => typeof tab === 'string' && tab !== '')
      && (active === null || (typeof active === 'string' && tabs.includes(active)));
  });
  if (!valid) return null;
  return {
    activeProject,
    projects: (projects as ProjectTabs[]).map(({ projectId, tabs, active }) => ({ projectId, tabs: [...tabs], active })),
  };
}
