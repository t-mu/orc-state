import { join } from 'node:path';
import { readEventsForRuns, withEventDb } from './eventLog.ts';
import { claimedRunStartupAnchor, latestRunActivityDetailMap } from './runActivity.ts';
import { readClaims } from './stateReader.ts';
import type { RunActivityDetail } from './runActivity.ts';
import type { Claim } from '../types/claims.ts';

export interface ActiveRunRow {
  run_id: string;
  task_ref: string;
  agent_id: string;
  state: string;
  awaiting_run_started: boolean;
  age_seconds: number | null;
  idle_seconds: number | null;
  last_activity_at: string | null;
  last_activity_source: string | null;
  lease_expires_at: string | null;
}

export interface ControlSnapshot {
  /** Highest event seq visible to this snapshot; subscribe with `after=cursor`. */
  cursor: number;
  generated_at: string;
  runs: ActiveRunRow[];
  /**
   * Live provider sessions; a command's recipient is the run owner's session.
   * Only `running` sessions accept commands; `recoverable` and `unknown` carry a reason.
   */
  sessions: Array<{ session_id: string; agent_id: string; run_id: string | null; state: string; transport: string | null; state_reason: string | null }>;
}

function elapsedSeconds(anchor: string | null, now: number): number | null {
  const ms = anchor ? now - new Date(anchor).getTime() : null;
  return ms == null || Number.isNaN(ms) ? null : Math.round(ms / 1000);
}

/** Shared by the legacy `runs-active` path and the control API snapshot. */
export function projectActiveRuns(claims: Claim[], runActivity: Map<string, RunActivityDetail>, now = Date.now()): ActiveRunRow[] {
  return claims.filter((c) => ['claimed', 'in_progress'].includes(c.state)).map((c) => {
    const startupAnchor = claimedRunStartupAnchor(c);
    const ageAnchor = c.state === 'claimed' ? startupAnchor : (c.started_at ?? c.task_envelope_sent_at ?? c.claimed_at ?? null);
    const activity = runActivity.get(c.run_id) ?? null;
    const idleAnchor = activity?.ts
      ?? c.last_heartbeat_at
      ?? c.started_at
      ?? (c.state === 'claimed' ? startupAnchor : (c.task_envelope_sent_at ?? c.claimed_at ?? null));
    return {
      run_id: c.run_id,
      task_ref: c.task_ref,
      agent_id: c.agent_id,
      state: c.state,
      awaiting_run_started: c.state === 'claimed',
      age_seconds: elapsedSeconds(ageAnchor, now),
      idle_seconds: elapsedSeconds(idleAnchor, now),
      last_activity_at: activity?.ts ?? null,
      last_activity_source: activity?.source ?? null,
      lease_expires_at: c.lease_expires_at ?? null,
    };
  });
}

/**
 * Read runs and the event cursor in one SQLite read transaction so that every
 * event after `cursor` is newer than the returned run projection.
 */
export function readControlSnapshot(stateDir: string, now = Date.now()): ControlSnapshot {
  // A first read may import legacy claims; do that write outside the snapshot.
  readClaims(stateDir);
  return withEventDb(stateDir, (db) => db.transaction(() => {
    const { cursor } = db.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM events').get() as { cursor: number };
    const claims = readClaims(stateDir).claims;
    const activeIds = claims.filter((c) => ['claimed', 'in_progress'].includes(c.state)).map((c) => c.run_id);
    const activity = latestRunActivityDetailMap(readEventsForRuns(join(stateDir, 'events.db'), activeIds));
    const sessions = db.prepare(`SELECT session_id, agent_id, run_id, state, transport, state_reason FROM sessions
      WHERE state IN ('running', 'recoverable', 'unknown') ORDER BY rowid`)
      .all() as ControlSnapshot['sessions'];
    return { cursor, generated_at: new Date(now).toISOString(), runs: projectActiveRuns(claims, activity, now), sessions };
  })());
}
