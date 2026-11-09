#!/usr/bin/env node
/**
 * cli/runs.ts
 * Usage: orc runs [--state=active|stalled|waiting-input] [--stale-after-ms=N] [--json] [--via-control]
 *
 * Lists live runs (claimed / in progress) through the same handler as MCP
 * list_runs and prints the same { runs } JSON with --json. --via-control reads
 * them from the coordinator's control API instead of the state files.
 */
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { ControlClient, controlSocketFromEnv } from '../lib/controlClient.ts';
import { listRuns, type RunListRow, type RunListState } from '../lib/runList.ts';
import { cliError, exitAfterFlush, printJson, requireProjectScope } from './shared.ts';
import { USAGE } from './usage.ts';

const { values } = parseCommandArgsOrExit(USAGE['runs'], {
  state: { type: 'string' },
  'stale-after-ms': { type: 'string' },
  json: { type: 'boolean' },
  'via-control': { type: 'boolean' },
});
requireProjectScope();

const STATES: Record<string, RunListState> = { active: 'active', stalled: 'stalled', 'waiting-input': 'waiting_input' };
const state = STATES[values.state ?? 'active'];
if (!state) usageError('--state must be active, stalled or waiting-input');
const staleRaw = values['stale-after-ms'];
if (staleRaw !== undefined && (!/^\d+$/.test(staleRaw) || !Number.isSafeInteger(Number(staleRaw)))) {
  usageError('--stale-after-ms must be a non-negative integer');
}
const staleAfterMs = staleRaw === undefined ? undefined : Number(staleRaw);

let rows: RunListRow[];
try {
  rows = values['via-control']
    ? (await new ControlClient(STATE_DIR, { socketPath: controlSocketFromEnv() }).runs({ state, stale_after_ms: staleAfterMs })).runs
    : listRuns(STATE_DIR, { state, stale_after_ms: staleAfterMs }).runs;
} catch (error) {
  cliError(error);
}

if (values.json === true) {
  printJson({ runs: rows });
  await exitAfterFlush(0);
}

console.log(`Runs (${values.state ?? 'active'}): ${rows.length}`);
if (rows.length === 0) console.log('(none)');
for (const r of rows) {
  const phase = r.phase ? ` phase=${r.phase}` : '';
  const stalled = r.stalled ? ' stalled' : '';
  console.log(`${r.run_id} ${r.task_ref} ${r.agent_id} state=${r.state}${phase} age=${r.age_seconds ?? '?'}s idle=${r.idle_seconds ?? '?'}s${stalled}`);
  if (r.request_id !== undefined) {
    console.log(`  waiting=${r.waiting_seconds ?? '?'}s question: ${r.question ?? '(unknown)'}`);
  }
}

function usageError(message: string): never {
  console.error(`Error: ${message}\nUsage: ${USAGE['runs']}`);
  process.exit(1);
}
