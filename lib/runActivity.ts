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

/** Position of a `phase_started` event: its `seq` and its own `ts`. */
export interface PhaseEventOrder {
  seq?: number | null | undefined;
  ts?: string | null | undefined;
}

/**
 * True when phase event `next` comes after `prev`. Phases are ordered by `seq`,
 * the append order: a coordinator-inferred phase is appended after the evidence
 * it was inferred from (the evidence time is kept in `payload.evidence_ts`), so
 * its `ts` says nothing about its place among the run's phases. Only when either
 * side has no `seq` (an event not yet read back from the log) is `ts` compared.
 */
export function isLaterPhaseEvent(prev: PhaseEventOrder | null | undefined, next: PhaseEventOrder): boolean {
  if (!prev) return true;
  if (Number.isFinite(prev.seq) && Number.isFinite(next.seq)) return (next.seq as number) > (prev.seq as number);
  return Date.parse(next.ts ?? '') > Date.parse(prev.ts ?? '');
}

type PhaseEventLike = { run_id?: string; seq?: number; ts?: string; event?: string; phase?: string; payload?: { phase?: string } };

/** The phase name of a `phase_started` event, or null for any other event. */
function startedPhase(e: PhaseEventLike): string | null {
  if (e?.event !== 'phase_started') return null;
  const phase = e.phase ?? e.payload?.phase;
  return typeof phase === 'string' && phase.length > 0 ? phase : null;
}

/**
 * Build a map of run_id -> latest phase name from phase_started events, ordered
 * by seq (isLaterPhaseEvent). Runs with no phase events are absent.
 */
export function latestRunPhaseMap(events: OrcEvent[] | null | undefined): Map<string, string> {
  const latest = new Map<string, { phase: string; seq: number | undefined; ts: string }>();
  for (const ev of events ?? []) {
    const e = ev as PhaseEventLike;
    const phase = startedPhase(e);
    if (!e?.run_id || !e.ts || !phase) continue;
    if (isLaterPhaseEvent(latest.get(e.run_id), e)) latest.set(e.run_id, { phase, seq: e.seq, ts: e.ts });
  }
  return new Map([...latest].map(([runId, { phase }]) => [runId, phase]));
}

export interface RunPhaseEntry {
  phase: string;
  started_at: string; // ISO timestamp
}

/**
 * Build a map of run_id -> all phase_started events, in seq order (timestamp
 * order for events without a seq).
 */
export function runPhaseHistory(events: OrcEvent[] | null | undefined): Map<string, RunPhaseEntry[]> {
  const result = new Map<string, Array<RunPhaseEntry & { order: PhaseEventOrder }>>();
  for (const ev of events ?? []) {
    const e = ev as PhaseEventLike;
    const phase = startedPhase(e);
    if (!e?.run_id || !e.ts || !phase) continue;
    let list = result.get(e.run_id);
    if (!list) { list = []; result.set(e.run_id, list); }
    list.push({ phase, started_at: e.ts, order: { seq: e.seq, ts: e.ts } });
  }
  return new Map([...result].map(([runId, list]) => [
    runId,
    list
      .sort((a, b) => (isLaterPhaseEvent(b.order, a.order) ? 1 : isLaterPhaseEvent(a.order, b.order) ? -1 : 0))
      .map(({ phase, started_at }) => ({ phase, started_at })),
  ]));
}

/**
 * The newer of two activity timestamps (either may be missing). Run liveness
 * is the newest of the durable activity events and the hook activity snapshot
 * (latestHookActivityTs): the coordinator, `orc status`/`orc watch`,
 * `orc runs` / MCP `list_runs` all measure idle time from it.
 */
export function newestTimestamp(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
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

/**
 * Whether hook activity at `activityTs` should renew a run's heartbeat and
 * lease. Hook events arrive on almost every tick of a busy run, and each
 * renewal rewrites claims.json and agents.json, so a renewal happens only
 * when the activity is newer than the last heartbeat AND either the lease is
 * at least half used or the last heartbeat is at least half a lease old.
 * Idle detection does not depend on this: it reads hook activity from
 * run-activity.json.
 */
export function shouldRenewFromHookActivity(
  claim: { last_heartbeat_at?: string | null; lease_expires_at?: string | null } | null | undefined,
  activityTs: string | null | undefined,
  nowMs: number,
  leaseDurationMs: number,
): boolean {
  if (!claim || !activityTs) return false;
  const activityMs = Date.parse(activityTs);
  if (!Number.isFinite(activityMs)) return false;
  const heartbeatMs = Date.parse(claim.last_heartbeat_at ?? '');
  if (!Number.isFinite(heartbeatMs)) return true;
  if (heartbeatMs >= activityMs) return false;
  const halfLeaseMs = leaseDurationMs / 2;
  const leaseMs = Date.parse(claim.lease_expires_at ?? '');
  if (!Number.isFinite(leaseMs) || leaseMs - nowMs <= halfLeaseMs) return true;
  return nowMs - heartbeatMs >= halfLeaseMs;
}
