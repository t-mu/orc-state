#!/usr/bin/env node
/**
 * cli/runs-active.mjs
 * Usage: node cli/runs-active.mjs [--json]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.mjs';
import { readEvents } from '../lib/eventLog.mjs';
import { latestRunActivityDetailMap } from '../lib/runActivity.mjs';
import { flag } from '../lib/args.mjs';

const asJson = process.argv.includes('--json') || (flag('json') ?? '') === 'true';
const now = Date.now();

const claims = readClaims();
const { runActivity, eventReadError } = readRunActivity();
const active = claims.filter((c) => ['claimed', 'in_progress'].includes(c.state));

const rows = active.map((c) => {
  const ageMs = c.claimed_at ? now - new Date(c.claimed_at).getTime() : null;
  const activity = runActivity.get(c.run_id) ?? null;
  const idleAnchor = activity?.ts ?? c.last_heartbeat_at ?? c.started_at ?? c.claimed_at ?? null;
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
    `${r.run_id} ${r.task_ref} ${r.agent_id} state=${r.state} awaiting_start=${r.awaiting_run_started} age=${r.age_seconds ?? '?'}s idle=${r.idle_seconds ?? '?'}s source=${r.last_activity_source ?? 'n/a'}`,
  );
}

if (eventReadError) {
  console.log(`event log warning: ${eventReadError}`);
}

function readClaims() {
  const path = join(STATE_DIR, 'claims.json');
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    return json.claims ?? [];
  } catch {
    return [];
  }
}

function readRunActivity() {
  try {
    return {
      runActivity: latestRunActivityDetailMap(readEvents(join(STATE_DIR, 'events.jsonl'))),
      eventReadError: '',
    };
  } catch (error) {
    return {
      runActivity: new Map(),
      eventReadError: error.message,
    };
  }
}
