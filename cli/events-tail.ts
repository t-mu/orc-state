#!/usr/bin/env node
/**
 * cli/events-tail.ts
 * Usage: node cli/events-tail.ts [--n=40] [--event=<name>] [--json]
 */
import { readEvents } from '../lib/eventLog.ts';
import { EVENTS_FILE } from '../lib/paths.ts';
import { flag, intFlag } from '../lib/args.ts';
import type { OrcEvent } from '../types/events.ts';

const asJson = process.argv.includes('--json');
const n = intFlag('n', 40);
const eventName = flag('event');

let events: OrcEvent[];
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
  const ev = e as unknown as Record<string, unknown>;
  const run = typeof ev.run_id === 'string' ? ` run=${ev.run_id}` : '';
  const task = typeof ev.task_ref === 'string' ? ` task=${ev.task_ref}` : '';
  const agent = typeof ev.agent_id === 'string' ? ` agent=${ev.agent_id}` : '';
  console.log(`${String(e.seq)} ${e.ts} ${e.event} actor=${e.actor_type}:${e.actor_id}${run}${task}${agent}`);
}
