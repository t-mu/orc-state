#!/usr/bin/env node
/**
 * cli/events-filter.ts
 * Usage: orc events-filter [--run-id=<id>] [--agent-id=<id>] [--event=<type>] [--last=<N>] [--json]
 *
 * Filter events.db with AND-combined filters.
 */
import { join } from 'node:path';
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { readEvents } from '../lib/eventLog.ts';
import { STATE_DIR } from '../lib/paths.ts';
import { eventLogMissing, exitAfterFlush, printJson, requireProjectScope } from './shared.ts';
import { USAGE } from './usage.ts';

const { values } = parseCommandArgsOrExit(USAGE['events-filter'], {
  json: { type: 'boolean' },
  'run-id': { type: 'string' },
  'agent-id': { type: 'string' },
  event: { type: 'string', multiple: true },
  last: { type: 'string' },
  after: { type: 'string' },
});
requireProjectScope();
const asJson = values.json === true;
const runIdFilter = values['run-id'];
const agentIdFilter = values['agent-id'];
const eventTypeRaw = values.event ?? [];
const nonNegativeInt = (name: string, raw: string | undefined): number => {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) {
    console.error(`Error: --${name} must be a non-negative integer\nUsage: ${USAGE['events-filter']}`);
    process.exit(1);
  }
  return Number(raw);
};
const afterSeq = nonNegativeInt('after', values.after);
// Also support comma-separated values
const eventTypeFilter = new Set(
  eventTypeRaw.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
);
const last = nonNegativeInt('last', values.last); // 0 means all

const eventsPath = join(STATE_DIR, 'events.db');
if (eventLogMissing(eventsPath)) {
  if (asJson) {
    console.log(JSON.stringify([]));
  } else {
    console.log('(no events file)');
  }
  process.exit(0);
}

const allEvents = readEvents(eventsPath);

const matched: unknown[] = [];
for (const ev of allEvents) {
  const e = ev as unknown as Record<string, unknown>;
  if (afterSeq > 0 && !(typeof e.seq === 'number' && e.seq > afterSeq)) continue;
  if (runIdFilter && e.run_id !== runIdFilter) continue;
  if (agentIdFilter && e.agent_id !== agentIdFilter) continue;
  if (eventTypeFilter.size > 0 && !eventTypeFilter.has(e.event as string)) continue;

  matched.push(ev);
}

// Apply --last=N after filtering so N refers to matched results, not raw lines
const output = last > 0 ? matched.slice(-last) : matched;

if (asJson) {
  printJson(output);
  await exitAfterFlush(0);
}

if (output.length === 0) {
  console.log('(no matching events)');
  process.exit(0);
}

for (const ev of output) {
  const e = ev as Record<string, unknown>;
  const type = typeof e.event === 'string' ? e.event : '';
  const ts = typeof e.ts === 'string' ? e.ts : '';
  const runId = typeof e.run_id === 'string' ? e.run_id : '';
  const agentId = typeof e.agent_id === 'string' ? e.agent_id : '';
  console.log(`${type.padEnd(28)} | ${ts} | ${runId} | ${agentId}`);
}
