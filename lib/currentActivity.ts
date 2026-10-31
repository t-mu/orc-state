import type { RunActivitySnapshot } from './runActivityStore.ts';

/** An explicit note outranks the to-do label only while it is younger than this. */
export const ACTIVITY_NOTE_FRESH_MS = 5 * 60_000;
/** An activity line older than this is shown dimmed. */
export const ACTIVITY_STALE_MS = 2 * 60_000;
/** Longest activity text carried in status payloads (MCP responses stay compact). */
export const ACTIVITY_TEXT_MAX = 120;

function capText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= ACTIVITY_TEXT_MAX ? flat : `${flat.slice(0, ACTIVITY_TEXT_MAX - 1)}…`;
}

export interface CurrentActivity {
  text: string;
  source: 'note' | 'todo' | 'tool';
  ts: string;
}

const TOOL_VERBS: Record<string, string> = {
  Edit: 'Editing',
  MultiEdit: 'Editing',
  NotebookEdit: 'Editing',
  Write: 'Writing',
  Read: 'Reading',
  Bash: 'Running',
  Grep: 'Searching',
  Glob: 'Finding',
  WebFetch: 'Fetching',
  WebSearch: 'Searching the web:',
};

/** Render a tool call readably: `Editing lib/providers.ts`, `Running npm test`, `Reviewing: critic`. */
export function describeToolAction(tool: string, brief: string | null | undefined): string {
  const detail = (brief ?? '').trim();
  if (tool === 'Agent' || tool === 'Task') {
    if (!detail) return 'Delegating to a sub-agent';
    return /critic|integrator|review/i.test(detail) ? `Reviewing: ${detail}` : `Delegating: ${detail}`;
  }
  const verb = TOOL_VERBS[tool];
  if (!detail) return verb ? `${verb.replace(/:$/, '')} (${tool})` : tool;
  return verb ? `${verb} ${detail}` : `${tool}: ${detail}`;
}

/**
 * Pick the line that best says what a run is doing (pure). Ranking:
 * a note younger than ACTIVITY_NOTE_FRESH_MS, then a non-empty to-do label,
 * then the last tool call. Null when the snapshot has none of these.
 */
export function selectCurrentActivity(
  snapshot: RunActivitySnapshot | null | undefined,
  nowMs: number = Date.now(),
): CurrentActivity | null {
  if (!snapshot) return null;
  const { label, source, label_ts: labelTs } = snapshot;
  if (label && labelTs && source === 'note' && nowMs - Date.parse(labelTs) < ACTIVITY_NOTE_FRESH_MS) {
    return { text: capText(label), source: 'note', ts: labelTs };
  }
  if (label && labelTs && source === 'todo') {
    return { text: capText(label), source: 'todo', ts: labelTs };
  }
  if (snapshot.last_tool && snapshot.last_tool_ts) {
    return { text: capText(describeToolAction(snapshot.last_tool, snapshot.last_tool_brief)), source: 'tool', ts: snapshot.last_tool_ts };
  }
  return null;
}

/** Whole seconds since `ts` (never negative), or null for an unparseable timestamp. */
export function activityAgeSeconds(ts: string, nowMs: number = Date.now()): number | null {
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

export function isActivityStale(ts: string, nowMs: number = Date.now()): boolean {
  const age = activityAgeSeconds(ts, nowMs);
  return age != null && age * 1000 >= ACTIVITY_STALE_MS;
}

/** Compact age: `12s ago`, `3m ago`, `2h ago`. */
export function formatActivityAge(seconds: number | null): string {
  if (seconds == null) return '?';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/**
 * Format the activity line to fit `width` columns: `<prefix><text>   (<age>)`.
 * The text is truncated with `…`; the age suffix is always kept.
 */
export function formatActivityLine(
  activity: CurrentActivity,
  width: number,
  nowMs: number = Date.now(),
  prefix = '└ ',
): string {
  const suffix = `   (${formatActivityAge(activityAgeSeconds(activity.ts, nowMs))})`;
  const room = Math.max(1, width - prefix.length - suffix.length);
  const text = activity.text.replace(/\s+/g, ' ').trim();
  const clipped = text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`;
  return `${prefix}${clipped}${suffix}`;
}
