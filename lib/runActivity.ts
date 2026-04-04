import type { OrcEvent } from '../types/events.ts';

const RUN_ACTIVITY_EVENTS = new Set([
  'run_started',
  'heartbeat',
  'work_complete',
  'finalize_rebase_started',
  'ready_to_merge',
  'phase_started',
  'phase_finished',
  'blocked',
  'need_input',
  'input_requested',
  'input_provided',
  'unblocked',
]);

export interface RunActivityDetail {
  ts: string;
  event: string;
  source: string;
}

export function claimedRunStartupAnchor(
  claim: { task_envelope_sent_at?: string | null; claimed_at?: string | null } | null | undefined,
): string | null {
  return claim?.task_envelope_sent_at ?? null;
}

/**
 * Generic helper: iterate events, keep latest value per run_id.
 * filter(e): return true if event should be considered.
 * extract(e): return the value to store for this event.
 */
function buildRunMap<T>(
  events: OrcEvent[] | null | undefined,
  filter: (e: { run_id?: string; ts?: string }) => boolean,
  extract: (e: { run_id?: string; ts?: string }) => T,
): Map<string, T> {
  const interim = new Map<string, { value: T; ts: string }>();
  for (const ev of events ?? []) {
    const e = ev as { run_id?: string; ts?: string };
    if (!e?.run_id || !e.ts) continue;
    if (!filter(e)) continue;
    const prev = interim.get(e.run_id);
    if (!prev || new Date(e.ts).getTime() > new Date(prev.ts).getTime()) {
      interim.set(e.run_id, { value: extract(e), ts: e.ts });
    }
  }
  const result = new Map<string, T>();
  for (const [runId, { value }] of interim) {
    result.set(runId, value);
  }
  return result;
}

/**
 * Build a map of run_id -> latest activity timestamp from event list.
 */
export function latestRunActivityMap(events: OrcEvent[] | null | undefined): Map<string, string> {
  type E = { run_id?: string; ts?: string; event?: string; actor_type?: string };
  return buildRunMap<string>(
    events,
    (ev) => {
      const e = ev as E;
      return RUN_ACTIVITY_EVENTS.has(e.event ?? '') &&
        e.actor_type !== 'coordinator' && e.actor_type !== 'human';
    },
    (ev) => (ev as E).ts!,
  );
}

/**
 * Build a map of run_id -> latest activity detail ({ ts, event, source }).
 */
export function latestRunActivityDetailMap(events: OrcEvent[] | null | undefined): Map<string, RunActivityDetail> {
  type E = { run_id?: string; ts?: string; event?: string; actor_type?: string; payload?: { source?: string } };
  return buildRunMap<RunActivityDetail>(
    events,
    (ev) => {
      const e = ev as E;
      return RUN_ACTIVITY_EVENTS.has(e.event ?? '') &&
        e.actor_type !== 'coordinator' && e.actor_type !== 'human';
    },
    (ev) => {
      const e = ev as E;
      return {
        ts: e.ts!,
        event: e.event ?? '',
        source: e.payload?.source ?? e.event ?? '',
      };
    },
  );
}

/**
 * Build a map of run_id -> latest phase name from phase_started events.
 * Returns null for runs with no phase events.
 */
export function latestRunPhaseMap(events: OrcEvent[] | null | undefined): Map<string, string> {
  type E = { run_id?: string; ts?: string; event?: string; phase?: string; payload?: { phase?: string } };
  return buildRunMap<string>(
    events,
    (ev) => {
      const e = ev as E;
      const phase = e.phase ?? e.payload?.phase;
      return e.event === 'phase_started' && typeof phase === 'string' && phase.length > 0;
    },
    (ev) => {
      const e = ev as E;
      return (e.phase ?? e.payload?.phase) as string;
    },
  );
}

export interface RunPhaseEntry {
  phase: string;
  started_at: string; // ISO timestamp
}

/**
 * Build a map of run_id -> all phase_started events, sorted by timestamp.
 */
export function runPhaseHistory(events: OrcEvent[] | null | undefined): Map<string, RunPhaseEntry[]> {
  const result = new Map<string, RunPhaseEntry[]>();
  for (const ev of events ?? []) {
    const e = ev as { run_id?: string; ts?: string; event?: string; phase?: string; payload?: { phase?: string } };
    if (!e?.run_id || !e.ts) continue;
    const phase = e.phase ?? e.payload?.phase;
    if (e.event !== 'phase_started' || typeof phase !== 'string' || phase.length === 0) continue;
    let list = result.get(e.run_id);
    if (!list) { list = []; result.set(e.run_id, list); }
    list.push({ phase, started_at: e.ts });
  }
  for (const list of result.values()) {
    list.sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());
  }
  return result;
}

/**
 * Return idle milliseconds for a run claim using newest known activity point.
 */
export function runIdleMs(
  claim: {
    last_heartbeat_at?: string | null;
    started_at?: string | null;
    task_envelope_sent_at?: string | null;
    claimed_at?: string | null;
  } | null | undefined,
  latestActivityTs: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  const anchor = latestActivityTs
    ?? claim?.last_heartbeat_at
    ?? claim?.started_at
    ?? claimedRunStartupAnchor(claim)
    ?? null;
  if (!anchor) return null;
  const ts = new Date(anchor).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.max(0, nowMs - ts);
}
