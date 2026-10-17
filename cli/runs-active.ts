#!/usr/bin/env node
/**
 * cli/runs-active.ts
 * Usage: node cli/runs-active.ts [--json] [--via-control]
 *
 * --via-control reads the snapshot from the local daemon control API instead
 * of the state files. The direct path remains the default during migration.
 */
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.ts';
import { readEvents } from '../lib/eventLog.ts';
import { latestRunActivityDetailMap } from '../lib/runActivity.ts';
import { boolFlag } from '../lib/args.ts';
import { cliError, formatErrorMessage } from './shared.ts';
import { readClaims } from '../lib/stateReader.ts';
import { ControlClient } from '../lib/controlClient.ts';
import { projectActiveRuns, type ActiveRunRow } from '../lib/statusProjection.ts';
import type { RunActivityDetail } from '../lib/runActivity.ts';

const asJson = boolFlag('json');

let rows: ActiveRunRow[];
let eventReadError = '';
if (boolFlag('via-control')) {
  try {
    rows = (await new ControlClient(STATE_DIR).snapshot()).runs;
  } catch (error) {
    cliError(error);
  }
} else {
  const activity = readRunActivity();
  eventReadError = activity.eventReadError;
  rows = projectActiveRuns(readClaims(STATE_DIR).claims, activity.runActivity);
}

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
      eventReadError: formatErrorMessage(error),
    };
  }
}
