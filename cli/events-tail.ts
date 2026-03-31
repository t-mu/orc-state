#!/usr/bin/env node
/**
 * cli/events-tail.ts
 * Usage: node cli/events-tail.ts [--n=40] [--event=<name>] [--json]
 */
import { readEvents } from '../lib/eventLog.ts';
import { EVENTS_FILE } from '../lib/paths.ts';
import { boolFlag, flag, intFlag } from '../lib/args.ts';
import { isRunEvent, isTaskEvent, isAgentEvent } from '../types/events.ts';

const asJson = boolFlag('json');
const n = intFlag('n', 40);
const eventName = flag('event');

let events: ReturnType<typeof readEvents>;
try {
  events = readEvents(EVENTS_FILE);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

if (eventName) {
  events = events.filter((e) => e.event === eventName);
}

const tail = events.slice(-Math.max(1, n));

if (asJson) {
  console.log(JSON.stringify({ total: tail.length, events: tail }, null, 2));
  process.exit(0);
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
