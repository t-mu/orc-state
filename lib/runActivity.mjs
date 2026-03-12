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

/**
 * Build a map of run_id -> latest activity timestamp from event list.
 */
export function latestRunActivityMap(events) {
  const latestByRun = new Map();
  for (const ev of events ?? []) {
    if (!ev?.run_id || !RUN_ACTIVITY_EVENTS.has(ev.event) || !ev.ts) continue;
    const prev = latestByRun.get(ev.run_id);
    if (!prev || new Date(ev.ts).getTime() > new Date(prev).getTime()) {
      latestByRun.set(ev.run_id, ev.ts);
    }
  }
  return latestByRun;
}

/**
 * Build a map of run_id -> latest activity detail ({ ts, event, source }).
 */
export function latestRunActivityDetailMap(events) {
  const latestByRun = new Map();
  for (const ev of events ?? []) {
    if (!ev?.run_id || !RUN_ACTIVITY_EVENTS.has(ev.event) || !ev.ts) continue;
    const prev = latestByRun.get(ev.run_id);
    if (!prev || new Date(ev.ts).getTime() > new Date(prev.ts).getTime()) {
      latestByRun.set(ev.run_id, {
        ts: ev.ts,
        event: ev.event,
        source: ev.payload?.source ?? ev.event,
      });
    }
  }
  return latestByRun;
}

/**
 * Return idle milliseconds for a run claim using newest known activity point.
 */
export function runIdleMs(claim, latestActivityTs, nowMs = Date.now()) {
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
