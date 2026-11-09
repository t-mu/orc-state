import type { ProjectConnectionState } from '../../client.ts';
import { buildWorkerSlotViewModels, type TuiAttention, type TuiProjectView, type TuiRecentEvent } from './status.ts';

/**
 * The cockpit dashboard's view model: every watched project with its agents
 * and what they need from a human, plus a feed of notification events across
 * projects. Pure data, so the view can compare two models and skip a render
 * when nothing changed (no flicker).
 */

export type AttentionKind = TuiAttention['kind'];

/** Attention kinds, highest precedence first (as `ATTENTION_PRECEDENCE` in the status view). */
export const ATTENTION_KINDS: readonly AttentionKind[] = ['permission_prompt', 'question', 'stalled', 'no_progress'];

/** The badge text on an agent row. */
export const ATTENTION_BADGE: Readonly<Record<AttentionKind, string>> = {
  permission_prompt: 'PERMISSION',
  question: 'QUESTION',
  stalled: 'STALLED',
  no_progress: 'NO PROGRESS',
};

/** The short name in a project's attention counts. */
export const ATTENTION_COUNT_LABEL: Readonly<Record<AttentionKind, string>> = {
  permission_prompt: 'permission',
  question: 'question',
  stalled: 'stalled',
  no_progress: 'no progress',
};

/** Events the feed shows: the notification class (`NOTIFICATION_EVENT_TYPES` in lib/eventLog.ts). */
export const NOTIFICATION_EVENTS: ReadonlySet<string> = new Set([
  'run_finished',
  'run_failed',
  'run_cancelled',
  'worker_needs_attention',
  'input_requested',
  'input_response',
]);

/** The feed keeps at most this many entries. */
export const FEED_LIMIT = 20;

export interface DashboardAgent {
  /** `<project_id>/<agent_id>`: unique across projects, the selection key. */
  key: string;
  agent_id: string;
  role: string;
  task_ref: string | null;
  /** The run's state, else the slot's. */
  state: string;
  phase: string | null;
  activity: string | null;
  attention: { kind: AttentionKind; detail: string | null } | null;
}

export interface DashboardProject {
  project_id: string;
  name: string;
  /** The project's state directory (the task explorer's client reads it) and checkout, for opening an agent's terminal. */
  state_dir: string;
  target_repo_root: string;
  /** The project this dashboard was started for. */
  current: boolean;
  connection: ProjectConnectionState;
  error: string | null;
  /** The agents are from the last known status (the project is not `running`). */
  stale: boolean;
  /** Agents needing attention first (by kind), then in status order. */
  agents: DashboardAgent[];
  attention: Record<AttentionKind, number>;
  attentionTotal: number;
}

export interface DashboardFeedEntry {
  /** `<project_id>:<seq>` (or the event's own identity without a seq): dedupes status and stream copies. */
  key: string;
  project: string;
  seq: number | null;
  ts: string | null;
  event: string;
  agent_id: string | null;
  task_ref: string | null;
  /** `worker_needs_attention`'s reason. */
  reason: string | null;
}

export interface DashboardModel {
  projects: DashboardProject[];
  /** Oldest first, at most `FEED_LIMIT`. */
  feed: DashboardFeedEntry[];
  /** Why nothing is shown: an unreadable registry or no project at all. */
  notice: string | null;
}

function emptyCounts(): Record<AttentionKind, number> {
  return { permission_prompt: 0, question: 0, stalled: 0, no_progress: 0 };
}

function attentionRank(agent: DashboardAgent): number {
  return agent.attention ? ATTENTION_KINDS.indexOf(agent.attention.kind) : ATTENTION_KINDS.length;
}

export function buildDashboardProject(view: TuiProjectView, current: boolean): DashboardProject {
  const slots = view.status ? buildWorkerSlotViewModels(view.status) : [];
  const master = view.status?.master;
  const masterRow: DashboardAgent[] = master
    ? [{
        key: `${view.project_id}/${master.agent_id}`, agent_id: master.agent_id, role: 'master',
        task_ref: null, state: master.status, phase: null, activity: null, attention: null,
      }]
    : [];
  const agents = masterRow.concat(slots.map((slot): DashboardAgent => ({
    key: `${view.project_id}/${slot.slot_id}`,
    agent_id: slot.slot_id,
    role: slot.role,
    task_ref: slot.task_ref,
    state: slot.run_state ?? slot.slot_state,
    phase: slot.current_phase,
    activity: slot.activity_label,
    attention: slot.attention
      ? { kind: slot.attention.kind, detail: slot.attention.detail?.replace(/\s+/g, ' ').trim() || null }
      : null,
  })));
  // Array.prototype.sort is stable: equal ranks keep the status order.
  agents.sort((a, b) => attentionRank(a) - attentionRank(b));
  const attention = emptyCounts();
  for (const agent of agents) if (agent.attention) attention[agent.attention.kind] += 1;
  return {
    project_id: view.project_id,
    name: view.name,
    state_dir: view.state_dir,
    target_repo_root: view.target_repo_root,
    current,
    connection: view.connection,
    error: view.error,
    stale: view.stale,
    agents,
    attention,
    attentionTotal: agents.filter(agent => agent.attention).length,
  };
}

/** Every project, the one for `stateDir` first, the others in watcher order. */
export function buildDashboardProjects(views: TuiProjectView[], stateDir: string): DashboardProject[] {
  const current = views.filter(view => view.state_dir === stateDir);
  const others = views.filter(view => view.state_dir !== stateDir);
  return [...current.map(view => buildDashboardProject(view, true)), ...others.map(view => buildDashboardProject(view, false))];
}

/** The notification events among `events` as feed entries of `project`. */
export function notificationEntries(project: { project_id: string; name: string }, events: TuiRecentEvent[]): DashboardFeedEntry[] {
  const entries: DashboardFeedEntry[] = [];
  for (const event of events) {
    if (!event.event || !NOTIFICATION_EVENTS.has(event.event)) continue;
    const seq = typeof event.seq === 'number' ? event.seq : null;
    const reason = (event as { payload?: { reason?: unknown } }).payload?.reason;
    entries.push({
      key: seq != null
        ? `${project.project_id}:${seq}`
        : `${project.project_id}:${event.ts ?? ''}:${event.event}:${event.run_id ?? ''}:${event.agent_id ?? ''}`,
      project: project.name,
      seq,
      ts: event.ts ?? null,
      event: event.event,
      agent_id: event.agent_id ?? null,
      task_ref: event.task_ref ?? null,
      reason: typeof reason === 'string' ? reason : null,
    });
  }
  return entries;
}

function entryTime(entry: DashboardFeedEntry): number {
  const time = entry.ts ? Date.parse(entry.ts) : NaN;
  return Number.isFinite(time) ? time : 0;
}

/** `current` plus `incoming`, deduplicated by key, oldest first, cut to the newest `limit`. */
export function mergeFeed(current: DashboardFeedEntry[], incoming: DashboardFeedEntry[], limit = FEED_LIMIT): DashboardFeedEntry[] {
  const byKey = new Map(current.map(entry => [entry.key, entry]));
  for (const entry of incoming) byKey.set(entry.key, entry);
  const merged = [...byKey.values()].sort((a, b) => entryTime(a) - entryTime(b) || (a.seq ?? 0) - (b.seq ?? 0));
  return merged.slice(-limit);
}

export function buildDashboardModel(
  views: TuiProjectView[],
  stateDir: string,
  feed: DashboardFeedEntry[],
  registryError: string | null,
): DashboardModel {
  const projects = buildDashboardProjects(views, stateDir);
  const notice = registryError
    ? `registry error: ${registryError}`
    : projects.length === 0 ? 'no registered projects' : null;
  return { projects, feed, notice };
}

/** The agents in display order (the selection moves through these). */
export function dashboardAgents(model: DashboardModel): DashboardAgent[] {
  return model.projects.flatMap(project => project.agents);
}

// ── Height fitting ───────────────────────────────────────────────────────────
// Ink clears the whole terminal on every render once the frame is as tall as
// the terminal, which reads as flicker, so the frame stays below `rows`.

/** `full`: three rows per agent (identity, task, activity); `compact`: one. */
export type AgentDetail = 'full' | 'compact';

export const AGENT_LINES: Readonly<Record<AgentDetail, number>> = { full: 3, compact: 1 };

/** The feed keeps at least this many rows (title included) while agents are cut. */
const MIN_FEED_LINES = 3;

export interface DashboardLayout {
  detail: AgentDetail;
  /** Agents shown per project (the rest collapse into a "+N more" row); Infinity shows all. */
  maxAgentsPerProject: number;
  /** Feed entries shown (newest kept). */
  feedLines: number;
}

/** Rows of a project section, agents excluded: title, attention counts, error, and the "(no agents)" row. */
export function projectChromeLines(project: DashboardProject): number {
  return 1
    + (project.attentionTotal > 0 ? 1 : 0)
    + (project.error ? 1 : 0)
    + (project.agents.length === 0 ? 1 : 0);
}

function agentRows(project: DashboardProject, detail: AgentDetail, maxAgents: number): number {
  const shown = Math.min(project.agents.length, maxAgents);
  const more = project.agents.length > shown ? 1 : 0;
  return shown * AGENT_LINES[detail] + more;
}

/** Rows above the feed: the title line, the notice, each project section and the gap before the feed. */
function bodyLines(model: DashboardModel, detail: AgentDetail, maxAgents: number): number {
  let lines = 1 + (model.notice ? 1 : 0);
  for (const project of model.projects) lines += projectChromeLines(project) + agentRows(project, detail, maxAgents);
  return lines + 1;
}

/**
 * How much of the dashboard fits `rows` (undefined: no TTY, show everything).
 * Agents collapse, then each project's list is cut (agents needing attention
 * sort first, so they go last). Projects themselves are never cut: with more
 * project rows than the terminal has, the frame can still reach `rows`.
 */
export function computeDashboardLayout(model: DashboardModel, rows: number | undefined): DashboardLayout {
  const feedWanted = 1 + Math.max(1, model.feed.length);
  if (rows == null) return { detail: 'full', maxAgentsPerProject: Infinity, feedLines: model.feed.length };
  const budget = rows - 1;
  const fits = (detail: AgentDetail, maxAgents: number, feedRows: number) => bodyLines(model, detail, maxAgents) + feedRows <= budget;
  const feedRows = (detail: AgentDetail, maxAgents: number) => Math.max(0, budget - bodyLines(model, detail, maxAgents));

  for (const detail of ['full', 'compact'] as const) {
    if (fits(detail, Infinity, Math.min(feedWanted, MIN_FEED_LINES))) {
      return { detail, maxAgentsPerProject: Infinity, feedLines: Math.max(0, Math.min(model.feed.length, feedRows(detail, Infinity) - 1)) };
    }
  }
  const most = Math.max(0, ...model.projects.map(project => project.agents.length));
  for (let maxAgents = most - 1; maxAgents >= 0; maxAgents -= 1) {
    if (fits('compact', maxAgents, Math.min(feedWanted, MIN_FEED_LINES)) || maxAgents === 0) {
      return { detail: 'compact', maxAgentsPerProject: maxAgents, feedLines: Math.max(0, Math.min(model.feed.length, feedRows('compact', maxAgents) - 1)) };
    }
  }
  return { detail: 'compact', maxAgentsPerProject: 0, feedLines: 0 };
}
