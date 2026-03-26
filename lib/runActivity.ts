import type { OrcEvent } from '../types/events.ts';

const RUN_ACTIVITY_EVENTS = new Set([
  'run_started',
  'heartbeat',
  'work_complete',
  'phase_started',
  'phase_finished',
  'blocked',
  'need_input',
  'input_requested',
  'input_response',
  'input_provided',
  'unblocked',
]);

export interface RunActivityDetail {
  ts: string;
  event: string;
  source: string;
}

/**
 * Build a map of run_id -> latest activity timestamp from event list.
 */
export function latestRunActivityMap(events: OrcEvent[] | null | undefined): Map<string, string> {
  const latestByRun = new Map<string, string>();
  for (const ev of events ?? []) {
    const e = ev as { run_id?: string; event?: string; ts?: string };
    if (!e?.run_id || !RUN_ACTIVITY_EVENTS.has(e.event ?? '') || !e.ts) continue;
    const prev = latestByRun.get(e.run_id);
    if (!prev || new Date(e.ts).getTime() > new Date(prev).getTime()) {
      latestByRun.set(e.run_id, e.ts);
    }
  }
  return latestByRun;
}

/**
 * Build a map of run_id -> latest activity detail ({ ts, event, source }).
 */
export function latestRunActivityDetailMap(events: OrcEvent[] | null | undefined): Map<string, RunActivityDetail> {
  const latestByRun = new Map<string, RunActivityDetail>();
  for (const ev of events ?? []) {
    const e = ev as { run_id?: string; event?: string; ts?: string; payload?: { source?: string } };
    if (!e?.run_id || !RUN_ACTIVITY_EVENTS.has(e.event ?? '') || !e.ts) continue;
    const prev = latestByRun.get(e.run_id);
    if (!prev || new Date(e.ts).getTime() > new Date(prev.ts).getTime()) {
      latestByRun.set(e.run_id, {
        ts: e.ts,
        event: e.event ?? '',
        source: e.payload?.source ?? e.event ?? '',
      });
    }
  }
  return latestByRun;
}

/**
 * Build a map of run_id -> latest phase name from phase_started events.
 * Returns null for runs with no phase events.
 */
export function latestRunPhaseMap(events: OrcEvent[] | null | undefined): Map<string, string> {
  const phaseByRun = new Map<string, { phase: string; ts: string }>();
  for (const ev of events ?? []) {
    const e = ev as { run_id?: string; event?: string; ts?: string; phase?: string; payload?: { phase?: string } };
    if (!e?.run_id || e.event !== 'phase_started' || !e.ts) continue;
    const phase = e.phase ?? e.payload?.phase;
    if (typeof phase !== 'string' || phase.length === 0) continue;
    const prev = phaseByRun.get(e.run_id);
    if (!prev || new Date(e.ts).getTime() > new Date(prev.ts).getTime()) {
      phaseByRun.set(e.run_id, { phase, ts: e.ts });
    }
  }
  const result = new Map<string, string>();
  for (const [runId, { phase }] of phaseByRun) {
    result.set(runId, phase);
  }
  return result;
}

/**
 * Return idle milliseconds for a run claim using newest known activity point.
 */
export function runIdleMs(
  claim: { last_heartbeat_at?: string | null; started_at?: string | null; claimed_at?: string | null } | null | undefined,
  latestActivityTs: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  const anchor = latestActivityTs
    ?? claim?.last_heartbeat_at
    ?? claim?.started_at
    ?? claim?.claimed_at
    ?? null;
  if (!anchor) return null;
  const ts = new Date(anchor).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.max(0, nowMs - ts);
}
