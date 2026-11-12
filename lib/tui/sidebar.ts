import type { ProjectConnectionState } from '../../client.ts';
import { fitToWidth, stringWidth } from '../cellWidth.ts';
import { buildWorkerSlotViewModels, type TuiAttention, type TuiProjectView } from './status.ts';
import { windowStart } from './taskList.ts';

/**
 * The cockpit sidebar's view model: a status box for the active project, every
 * watched project with its state and attention count, and the active
 * project's workers and scouts as two-row entries. Pure data, so the view can
 * compare two models and skip a render when nothing changed (no flicker).
 */

export type AttentionKind = TuiAttention['kind'];

/** Attention kinds, highest precedence first (as `ATTENTION_PRECEDENCE` in the status view). */
export const ATTENTION_KINDS: readonly AttentionKind[] = ['permission_prompt', 'question', 'stalled', 'no_progress'];

/** The badge an agent needing attention shows in its phase's place. */
export const ATTENTION_BADGE: Readonly<Record<AttentionKind, string>> = {
  permission_prompt: 'PERMISSION',
  question: 'QUESTION',
  stalled: 'STALLED',
  no_progress: 'NO PROGRESS',
};

/**
 * A project's state: its coordinator's connection, with `unreachable` (a
 * coordinator recorded as running that does not answer) shown as `stale`.
 */
export type SidebarProjectState = Exclude<ProjectConnectionState, 'unreachable'> | 'stale';

export function projectState(connection: ProjectConnectionState): SidebarProjectState {
  return connection === 'unreachable' ? 'stale' : connection;
}

export interface SidebarAgent {
  /** `<project_id>/<agent_id>`: the selection key. */
  key: string;
  agent_id: string;
  role: string;
  /** Row 1: the run's phase, else the run's or the agent's state. */
  phase: string;
  /** Row 1: time since the run started (`12m`, `1h04`); null without a run. */
  elapsed: string | null;
  /** Row 2: the activity text (else the task, for a scout `scout`), or the question or reason of an attention; null when there is none. */
  detail: string | null;
  /** Shown as a badge in the phase's place; such agents sort first. */
  attention: AttentionKind | null;
  /** The run's task (null without one) and the agent's provider (null when unknown); set only when `sidebarAgents` is asked for `details`. */
  task_ref?: string | null;
  provider?: string | null;
}

export interface SidebarProject {
  project_id: string;
  name: string;
  /** The project's state directory and checkout (the task explorer and agent tabs use them). */
  state_dir: string;
  target_repo_root: string;
  /** The coordinator's connection, and how the sidebar shows it. */
  connection: ProjectConnectionState;
  state: SidebarProjectState;
  /** Why the project is stale or incompatible (null otherwise). */
  error: string | null;
  /** Agents of this project needing a human. */
  attention: number;
  /** The project whose agents the sidebar lists. */
  active: boolean;
}

export interface SidebarStatus {
  /** The active project's coordinator; null without an active project. */
  coordinator: SidebarProjectState | null;
  /** The active project's worker capacity; null without its status. */
  workers: { used: number; total: number } | null;
  /** Agents needing a human, across every project. */
  attention: number;
}

export interface SidebarModel {
  status: SidebarStatus;
  projects: SidebarProject[];
  activeProjectId: string | null;
  /** The active project's workers and scouts (never its master), attention first. */
  agents: SidebarAgent[];
  /** The agents are from the active project's last known status (it is not running). */
  agentsStale: boolean;
  /** The active project's task counts by status (`orc status`'s `tasks.counts`); null or absent without its status. */
  tasks?: Record<string, number> | null;
  /** Why nothing is shown: an unreadable registry or no project at all. */
  notice: string | null;
}

/** `45s` → `0m`, `12m`, `1h04`, `26h00`: run time at a glance, changing at most once a minute. */
export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`;
}

function oneLine(text: string | null | undefined): string | null {
  return text?.replace(/\s+/g, ' ').trim() || null;
}

/** Row 2 of an agent needing attention: the question or prompt, or why it needs a human. */
export function attentionDetail(kind: AttentionKind, detail: string | null, activity: string | null): string {
  switch (kind) {
    case 'question':
    case 'permission_prompt':
      return `? ${detail ?? '(text unavailable)'}`;
    case 'no_progress':
      return `no progress${detail ? ` in ${detail}` : ''}`;
    case 'stalled':
      return `stalled${activity ? `: ${activity}` : ''}`;
  }
}

function elapsedSince(startedAt: string | null, ageSeconds: number | null, nowMs: number): string | null {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  if (Number.isFinite(started)) return formatElapsed((nowMs - started) / 1000);
  return ageSeconds == null ? null : formatElapsed(ageSeconds);
}

function attentionRank(agent: SidebarAgent): number {
  return agent.attention ? ATTENTION_KINDS.indexOf(agent.attention) : ATTENTION_KINDS.length;
}

/**
 * A project's workers and scouts as sidebar rows, attention first (by kind), then in status order.
 * With `details`, each also carries its task ref and provider (the cockpit's agent cards show them).
 */
export function sidebarAgents(view: TuiProjectView, nowMs: number, options: { details?: boolean } = {}): SidebarAgent[] {
  if (!view.status) return [];
  const workers = buildWorkerSlotViewModels(view.status)
    .filter(slot => slot.role !== 'master')
    .map((slot): SidebarAgent => {
      const activity = oneLine(slot.activity_label);
      const attention = slot.attention?.kind ?? null;
      return {
        key: `${view.project_id}/${slot.slot_id}`,
        agent_id: slot.slot_id,
        role: slot.role,
        phase: slot.current_phase ?? slot.run_state ?? slot.slot_state,
        elapsed: slot.run_state ? elapsedSince(slot.run_started_at, slot.age_seconds, nowMs) : null,
        detail: attention ? attentionDetail(attention, oneLine(slot.attention?.detail), activity) : activity ?? slot.task_ref,
        attention,
        ...(options.details ? { task_ref: slot.task_ref, provider: slot.provider } : {}),
      };
    });
  const scouts = (view.status.scouts ?? []).map((scout): SidebarAgent => ({
    key: `${view.project_id}/${scout.agent_id}`,
    agent_id: scout.agent_id,
    role: 'scout',
    phase: scout.status,
    elapsed: elapsedSince(scout.launched_at, null, nowMs),
    detail: 'scout',
    attention: null,
    ...(options.details ? { task_ref: null, provider: scout.provider } : {}),
  }));
  // Array.prototype.sort is stable: equal ranks keep the status order.
  return [...workers, ...scouts].sort((a, b) => attentionRank(a) - attentionRank(b));
}

function attentionCount(view: TuiProjectView): number {
  return view.status?.worker_capacity.slots.filter(slot => slot.attention).length ?? 0;
}

/**
 * The sidebar's model. The active project is `activeProjectId` when it is
 * watched, else the one whose state directory is `stateDir`, else the first.
 */
export function buildSidebarModel(
  views: TuiProjectView[],
  options: { stateDir: string; activeProjectId: string | null; nowMs: number; registryError: string | null; agentDetails?: boolean },
): SidebarModel {
  const active = views.find(view => view.project_id === options.activeProjectId)
    ?? views.find(view => view.state_dir === options.stateDir)
    ?? views[0]
    ?? null;
  const projects = views.map((view): SidebarProject => ({
    project_id: view.project_id,
    name: view.name,
    state_dir: view.state_dir,
    target_repo_root: view.target_repo_root,
    connection: view.connection,
    state: projectState(view.connection),
    error: view.error,
    attention: attentionCount(view),
    active: view === active,
  }));
  const capacity = active?.status?.worker_capacity;
  return {
    status: {
      coordinator: active ? projectState(active.connection) : null,
      workers: capacity ? { used: capacity.used_slots, total: capacity.configured_slots } : null,
      attention: projects.reduce((sum, project) => sum + project.attention, 0),
    },
    projects,
    activeProjectId: active?.project_id ?? null,
    agents: active ? sidebarAgents(active, options.nowMs, { details: options.agentDetails ?? false }) : [],
    agentsStale: active?.stale ?? false,
    tasks: active?.status?.tasks?.counts ?? null,
    notice: options.registryError
      ? `registry error: ${options.registryError}`
      : views.length === 0 ? 'no registered projects' : null,
  };
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** `text` cut to `width` cells (display width: a wide character takes two), an ellipsis marking a cut. */
export function fitText(text: string, width: number): string {
  return fitToWidth(text, width);
}

/**
 * A row of exactly `width` cells (by display width): `left` (cut first), then a gap, then
 * `right` flush right (cut only when even it does not fit).
 */
export function fitRow(left: string, right: string, width: number): { left: string; gap: string; right: string } {
  const shownRight = fitText(right, width);
  const room = width - stringWidth(shownRight) - (shownRight && left ? 1 : 0);
  const shownLeft = fitText(left, Math.max(0, room));
  return { left: shownLeft, gap: ' '.repeat(Math.max(0, width - stringWidth(shownLeft) - stringWidth(shownRight))), right: shownRight };
}

/**
 * An agent's first row in `width` cells: its name (cut first), then its phase
 * (or attention badge) and elapsed time flush right.
 */
export function agentRowParts(agent: SidebarAgent, width: number): { name: string; gap: string; tag: string; elapsed: string } {
  const tag = agent.attention ? ATTENTION_BADGE[agent.attention] : agent.phase;
  const elapsed = agent.elapsed && width > stringWidth(agent.elapsed) + 2 ? ` ${agent.elapsed}` : '';
  const shownTag = fitText(tag, width - stringWidth(elapsed));
  const row = fitRow(agent.agent_id, `${shownTag}${elapsed}`, width);
  return { name: row.left, gap: row.gap, tag: shownTag, elapsed };
}

// ── Height fitting ───────────────────────────────────────────────────────────
// Ink clears the whole terminal on every render once the frame is as tall as
// the terminal, which reads as flicker, so the frame stays below `rows`.

/** Rows of a box's borders (the top one carries the title). */
export const BOX_CHROME = 2;
/** Rows an agent takes: name, phase and time; then its activity or attention. */
export const AGENT_ROWS = 2;

/** Rows inside the status box: coordinator, workers and attention, and the notice when there is one. */
export function statusLines(model: SidebarModel): number {
  return 2 + (model.notice ? 1 : 0);
}

export interface SidebarLayout {
  /** The first shown project and how many are shown (a `+N more` row counts the rest). */
  projectStart: number;
  projectCount: number;
  /** Indices into `model.agents` of the agents shown, in order (a `+N more` row counts the rest). */
  agents: number[];
}

/** Rows of the projects box's body: one per shown project (or the empty line) and the `+N more` row. */
export function projectBodyLines(model: SidebarModel, layout: SidebarLayout): number {
  return Math.max(1, layout.projectCount) + (layout.projectCount < model.projects.length ? 1 : 0);
}

/** Rows of the agents box's body: two per shown agent (or the empty line) and the `+N more` row. */
export function agentBodyLines(model: SidebarModel, layout: SidebarLayout): number {
  if (model.agents.length === 0) return 1;
  return AGENT_ROWS * layout.agents.length + (layout.agents.length < model.agents.length ? 1 : 0);
}

/**
 * How much of the sidebar fits `rows` (undefined: no TTY, show everything).
 * The status box always shows; the projects box shows every project unless
 * that leaves too little for the agents needing attention and two others,
 * then a window around `cursor.project`; the agents box gets the remaining rows: every
 * agent needing attention (they sort first, and are never cut) and a window
 * of the others around `cursor.agent`, with a `+N more` row for the rest.
 */
export function computeSidebarLayout(model: SidebarModel, rows: number | undefined, cursor: { project: number; agent: number } = { project: 0, agent: 0 }): SidebarLayout {
  const allAgents = model.agents.map((_, index) => index);
  const projectTotal = model.projects.length;
  if (rows == null) return { projectStart: 0, projectCount: projectTotal, agents: allAgents };

  const budget = rows - 1 - (BOX_CHROME + statusLines(model)) - 2 * BOX_CHROME;
  const attention = model.agents.filter(agent => agent.attention).length;
  // The projects box leaves room for every agent needing attention and two others (or a `+N more` row).
  const others = model.agents.length - attention;
  const minAgentLines = Math.max(1, AGENT_ROWS * (attention + Math.min(others, 2)) + (others > 2 ? 1 : 0));

  let projectCount = projectTotal;
  if (Math.max(1, projectTotal) > budget - minAgentLines) projectCount = Math.min(projectTotal, Math.max(1, budget - minAgentLines - 1));
  const projectStart = windowStart(cursor.project, projectTotal, projectCount);
  const projectLines = Math.max(1, projectCount) + (projectCount < projectTotal ? 1 : 0);

  const agentRoom = budget - projectLines;
  if (AGENT_ROWS * model.agents.length <= agentRoom) return { projectStart, projectCount, agents: allAgents };
  const otherCount = Math.min(others, Math.max(0, Math.floor((agentRoom - 1) / AGENT_ROWS) - attention));
  const otherCursor = Math.max(0, cursor.agent - attention);
  const otherStart = attention + windowStart(otherCursor, others, otherCount);
  const agents = [
    ...allAgents.slice(0, attention),
    ...allAgents.slice(otherStart, otherStart + otherCount),
  ];
  return { projectStart, projectCount, agents };
}

/** What a row of the sidebar's frame (0-based) is: a project, an agent (either of its rows), or neither. */
export type SidebarRowTarget = { kind: 'project'; index: number } | { kind: 'agent'; index: number } | null;

/** The project or agent on frame row `y` (0-based), as `layout` lays the sidebar out; mouse clicks hit-test with it. */
export function sidebarRowTarget(model: SidebarModel, layout: SidebarLayout, y: number): SidebarRowTarget {
  const projectsTop = BOX_CHROME + statusLines(model);
  const projectRow = y - projectsTop - 1;
  if (projectRow >= 0 && projectRow < layout.projectCount) return { kind: 'project', index: layout.projectStart + projectRow };
  const agentsTop = projectsTop + BOX_CHROME + projectBodyLines(model, layout);
  const agentRow = y - agentsTop - 1;
  if (agentRow >= 0 && agentRow < AGENT_ROWS * layout.agents.length) return { kind: 'agent', index: layout.agents[Math.floor(agentRow / AGENT_ROWS)] };
  return null;
}
