#!/usr/bin/env node
/**
 * cli/events-tail.mjs
 * Usage: node cli/events-tail.mjs [--n=40] [--event=<name>] [--json]
 */
import { readEvents } from '../lib/eventLog.mjs';
import { EVENTS_FILE } from '../lib/paths.mjs';
import { flag, intFlag } from '../lib/args.mjs';

const asJson = process.argv.includes('--json');
const n = intFlag('n', 40);
const eventName = flag('event');

let events;
try {
  events = readEvents(EVENTS_FILE);
} catch (error) {
  console.error(error.message);
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

for (const ev of tail) {
  const run = ev.run_id ? ` run=${ev.run_id}` : '';
  const task = ev.task_ref ? ` task=${ev.task_ref}` : '';
  const agent = ev.agent_id ? ` agent=${ev.agent_id}` : '';
  console.log(`${ev.seq} ${ev.ts} ${ev.event} actor=${ev.actor_type}:${ev.actor_id}${run}${task}${agent}`);
}
