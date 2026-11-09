#!/usr/bin/env node
/**
 * cli/events-tail.ts
 * Usage: node cli/events-tail.ts [--n=40] [--event=<name>] [--json]
 */
import { readEvents } from '../lib/eventLog.ts';
import { EVENTS_FILE } from '../lib/paths.ts';
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { isRunEvent, isTaskEvent, isAgentEvent } from '../types/events.ts';
import { cliError, eventLogMissing, exitAfterFlush, printJson, requireProjectScope } from './shared.ts';
import { USAGE } from './usage.ts';

const { values } = parseCommandArgsOrExit(USAGE['events-tail'], { json: { type: 'boolean' }, n: { type: 'string' }, event: { type: 'string' } });
requireProjectScope();
const asJson = values.json === true;
if (values.n !== undefined && !/^[1-9]\d*$/.test(values.n)) {
  console.error(`Error: --n must be a positive integer\nUsage: ${USAGE['events-tail']}`);
  process.exit(1);
}
const n = values.n === undefined ? 40 : Number(values.n);
const eventName = values.event;

let events: ReturnType<typeof readEvents>;
try {
  // A missing database is an empty log, as in events-filter; reading must not create it.
  events = eventLogMissing(EVENTS_FILE) ? [] : readEvents(EVENTS_FILE);
} catch (error) {
  cliError(error);
}

if (eventName) {
  events = events.filter((e) => e.event === eventName);
}

const tail = events.slice(-Math.max(1, n));

if (asJson) {
  printJson({ total: tail.length, events: tail });
  await exitAfterFlush(0);
}

if (tail.length === 0) {
  console.log('(no events)');
  process.exit(0);
}

for (const e of tail) {
  const run = isRunEvent(e) ? ` run=${e.run_id}` : '';
  const task = isTaskEvent(e) ? ` task=${e.task_ref}` : '';
  const agent = isAgentEvent(e) ? ` agent=${e.agent_id}` : '';
  console.log(`${String(e.seq)} ${e.ts} ${e.event} actor=${e.actor_type}:${e.actor_id}${run}${task}${agent}`);
}
