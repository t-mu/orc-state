#!/usr/bin/env node
/**
 * cli/runs-active.ts
 * Usage: node cli/runs-active.ts [--json]
 */
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.ts';
import { readEvents } from '../lib/eventLog.ts';
import { claimedRunStartupAnchor, latestRunActivityDetailMap } from '../lib/runActivity.ts';
import { flag } from '../lib/args.ts';
import { readClaims } from '../lib/stateReader.ts';
import type { RunActivityDetail } from '../lib/runActivity.ts';
import type { Claim } from '../types/claims.ts';

const asJson = process.argv.includes('--json') || (flag('json') ?? '') === 'true';
const now = Date.now();

const claimsState = readClaims(STATE_DIR);
const claims: Claim[] = claimsState.claims;
const { runActivity, eventReadError } = readRunActivity();
const active = claims.filter((c) => ['claimed', 'in_progress'].includes(c.state));

const rows = active.map((c) => {
  const startupAnchor = claimedRunStartupAnchor(c);
  const ageAnchor = c.state === 'claimed' ? startupAnchor : (c.started_at ?? c.task_envelope_sent_at ?? c.claimed_at ?? null);
  const ageMs = ageAnchor ? now - new Date(ageAnchor).getTime() : null;
  const activity = runActivity.get(c.run_id) ?? null;
  const idleAnchor = activity?.ts
    ?? c.last_heartbeat_at
    ?? c.started_at
    ?? (c.state === 'claimed' ? startupAnchor : (c.task_envelope_sent_at ?? c.claimed_at ?? null));
  const idleMs = idleAnchor ? now - new Date(idleAnchor).getTime() : null;
  return {
    run_id: c.run_id,
    task_ref: c.task_ref,
    agent_id: c.agent_id,
    state: c.state,
    awaiting_run_started: c.state === 'claimed',
    age_seconds: ageMs == null || Number.isNaN(ageMs) ? null : Math.round(ageMs / 1000),
    idle_seconds: idleMs == null || Number.isNaN(idleMs) ? null : Math.round(idleMs / 1000),
    last_activity_at: activity?.ts ?? null,
    last_activity_source: activity?.source ?? null,
    lease_expires_at: c.lease_expires_at ?? null,
  };
});

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, runs: rows, event_read_error: eventReadError || null }, null, 2));
  process.exit(0);
}

console.log(`Active runs: ${rows.length}`);
if (rows.length === 0) {
  console.log('(none)');
  process.exit(0);
}

for (const r of rows) {
  console.log(
    `${r.run_id} ${r.task_ref} ${r.agent_id} state=${r.state} awaiting_start=${String(r.awaiting_run_started)} age=${r.age_seconds ?? '?'}s idle=${r.idle_seconds ?? '?'}s source=${r.last_activity_source ?? 'n/a'}`,
  );
}

if (eventReadError) {
  console.log(`event log warning: ${eventReadError}`);
}

function readRunActivity(): { runActivity: Map<string, RunActivityDetail>; eventReadError: string } {
  try {
    return {
      runActivity: latestRunActivityDetailMap(readEvents(join(STATE_DIR, 'events.db'))),
      eventReadError: '',
    };
  } catch (error) {
    return {
      runActivity: new Map<string, RunActivityDetail>(),
      eventReadError: (error as Error).message,
    };
  }
}
