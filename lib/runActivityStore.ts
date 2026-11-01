import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteJson } from './atomicWrite.ts';
import type { RunActivityHookEvent } from './hookEventBus.ts';

/**
 * Per-run activity projection derived from harness hook events.
 *
 * The coordinator is its only writer: it rewrites the whole file atomically
 * when a run's snapshot changes and drops a run's entry when the run ends.
 * Other processes (`orc status`, `orc watch`, the MCP server) read it with
 * `readRunActivity`.
 */
export const RUN_ACTIVITY_FILE = 'run-activity.json';

/** Minimum gap between two `activity_note` events for one run. */
export const ACTIVITY_NOTE_THROTTLE_MS = 30_000;

export type RunActivitySource = 'todo' | 'note' | 'tool';

/**
 * How long an unfinished tool call keeps a run out of the shortened hook idle
 * thresholds. A tool call that never reports back (it failed, or the session
 * was interrupted) stops counting after this, so the run falls back to the
 * thresholds of a run without hooks rather than staying live forever.
 */
export const TOOL_IN_FLIGHT_MAX_MS = 60 * 60_000;
/** Cap on remembered open tool calls per run. */
const MAX_OPEN_TOOLS = 16;
/** Key for a tool call whose harness reported no tool_use_id. */
const ANONYMOUS_TOOL = '_';

export interface RunActivitySnapshot {
  run_id: string;
  agent_id: string;
  label: string | null;
  source: RunActivitySource | null;
  label_ts: string | null;
  last_tool: string | null;
  last_tool_brief: string | null;
  last_tool_ts: string | null;
  /** Tool calls started (PreToolUse) and not yet finished (PostToolUse): tool_use_id → start time. */
  open_tools?: Record<string, string>;
}

export type RunActivityMap = Record<string, RunActivitySnapshot>;

interface RunActivityFile {
  version: 1;
  runs: RunActivityMap;
}

/** Read every run's activity snapshot, keyed by run_id. Missing or unreadable file → {}. */
export function readRunActivity(stateDir: string): RunActivityMap {
  const path = join(stateDir, RUN_ACTIVITY_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RunActivityFile> | null;
    const runs = parsed?.runs;
    return runs && typeof runs === 'object' && !Array.isArray(runs) ? runs : {};
  } catch {
    return {};
  }
}

/** Replace the projection. Coordinator-only. */
export function writeRunActivity(stateDir: string, runs: RunActivityMap): void {
  atomicWriteJson(join(stateDir, RUN_ACTIVITY_FILE), { version: 1, runs } satisfies RunActivityFile);
}

function toolLabel(tool: string, brief: string): string {
  return brief ? `${tool}: ${brief}` : tool;
}

function isNewer(ts: string, current: string | null): boolean {
  return current == null || Date.parse(ts) >= Date.parse(current);
}

/** Drop open tool calls past TOOL_IN_FLIGHT_MAX_MS and keep at most MAX_OPEN_TOOLS (newest). */
function pruneOpenTools(open: Record<string, string>, nowMs: number): Record<string, string> | undefined {
  const kept = Object.entries(open)
    .filter(([, ts]) => nowMs - Date.parse(ts) < TOOL_IN_FLIGHT_MAX_MS)
    .sort(([, a], [, b]) => Date.parse(a) - Date.parse(b))
    .slice(-MAX_OPEN_TOOLS);
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * Fold hook events into a run's snapshot (pure). Timestamps in the future are
 * clamped to `nowMs`. A todo or note label is the run's label; a tool call
 * labels the run only while it has no todo/note label. An empty todo label
 * clears the label back to the last tool call.
 */
export function applyHookActivity(
  previous: RunActivitySnapshot | undefined,
  runId: string,
  agentId: string,
  events: RunActivityHookEvent[],
  nowMs: number = Date.now(),
): RunActivitySnapshot {
  const next: RunActivitySnapshot = previous
    ? { ...previous, agent_id: agentId }
    : {
        run_id: runId, agent_id: agentId, label: null, source: null, label_ts: null,
        last_tool: null, last_tool_brief: null, last_tool_ts: null,
      };
  let open: Record<string, string> = { ...(previous?.open_tools ?? {}) };
  for (const event of events) {
    const ts = new Date(Math.min(Date.parse(event.ts), nowMs)).toISOString();
    if (event.type === 'tool_start') {
      open[event.id ?? ANONYMOUS_TOOL] = ts;
      continue;
    }
    if (event.type === 'tool') {
      // A finished call closes its start, even when an older record arrives late.
      const key = event.id ?? ANONYMOUS_TOOL;
      if (key in open) {
        const { [key]: _closed, ...rest } = open;
        open = rest;
      }
      if (!isNewer(ts, next.last_tool_ts)) continue;
      next.last_tool = event.tool;
      next.last_tool_brief = event.brief;
      next.last_tool_ts = ts;
      if (next.source == null || next.source === 'tool') {
        next.label = toolLabel(event.tool, event.brief);
        next.source = 'tool';
        next.label_ts = ts;
      }
    } else {
      if (next.source !== 'tool' && !isNewer(ts, next.label_ts)) continue;
      if (event.label === '') {
        // A cleared to-do label: fall back to the last tool call, as if no label had been set.
        if (next.source === 'tool') continue;
        next.label = next.last_tool == null ? null : toolLabel(next.last_tool, next.last_tool_brief ?? '');
        next.source = next.last_tool == null ? null : 'tool';
        next.label_ts = next.last_tool == null ? null : next.last_tool_ts;
        continue;
      }
      next.label = event.label;
      next.source = event.source;
      next.label_ts = ts;
    }
  }
  const openTools = pruneOpenTools(open, nowMs);
  if (openTools) next.open_tools = openTools;
  else delete next.open_tools;
  return next;
}

/** True while the run has a tool call started within TOOL_IN_FLIGHT_MAX_MS that has not finished. */
export function toolInFlight(snapshot: RunActivitySnapshot | null | undefined, nowMs: number = Date.now()): boolean {
  return Object.values(snapshot?.open_tools ?? {}).some((ts) => nowMs - Date.parse(ts) < TOOL_IN_FLIGHT_MAX_MS);
}

/** Latest hook-observed activity time for a run (label or tool call), or null. */
export function latestHookActivityTs(snapshot: RunActivitySnapshot | null | undefined): string | null {
  if (!snapshot) return null;
  const candidates = [snapshot.label_ts, snapshot.last_tool_ts, ...Object.values(snapshot.open_tools ?? {})]
    .filter((ts): ts is string => typeof ts === 'string');
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

export interface ActivityNoteState {
  label: string;
  emitted_at_ms: number;
}

/**
 * Decide whether a run's current label warrants an `activity_note` event:
 * only when it differs from the last emitted label, and at most once per
 * ACTIVITY_NOTE_THROTTLE_MS. A change suppressed by the throttle is emitted
 * on a later tick if the label still differs.
 */
export function shouldEmitActivityNote(
  last: ActivityNoteState | undefined,
  label: string | null,
  nowMs: number,
  throttleMs: number = ACTIVITY_NOTE_THROTTLE_MS,
): boolean {
  if (!label) return false;
  if (!last) return true;
  if (last.label === label) return false;
  return nowMs - last.emitted_at_ms >= throttleMs;
}
