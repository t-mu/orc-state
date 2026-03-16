#!/usr/bin/env node
/**
 * cli/events-filter.ts
 * Usage: orc events-filter [--run-id=<id>] [--agent-id=<id>] [--event=<type>] [--last=<N>] [--json]
 *
 * Filter events.jsonl with AND-combined filters.
 */
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { flag, flagAll, intFlag } from '../lib/args.ts';
import { STATE_DIR } from '../lib/paths.ts';

const asJson = process.argv.includes('--json');
const runIdFilter = flag('run-id');
const agentIdFilter = flag('agent-id');
const eventTypeRaw = flagAll('event');
// Also support comma-separated values
const eventTypeFilter = new Set(
  eventTypeRaw.flatMap((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
);
const last = intFlag('last', 0); // 0 means all

const eventsPath = join(STATE_DIR, 'events.jsonl');
if (!existsSync(eventsPath)) {
  if (asJson) {
    console.log(JSON.stringify([]));
  } else {
    console.log('(no events file)');
  }
  process.exit(0);
}

const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);

const matched: unknown[] = [];
for (const line of lines) {
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(line) as Record<string, unknown>;
  } catch {
    continue;
  }

  if (runIdFilter && ev.run_id !== runIdFilter) continue;
  if (agentIdFilter && ev.agent_id !== agentIdFilter) continue;
  if (eventTypeFilter.size > 0 && !eventTypeFilter.has(ev.event as string)) continue;

  matched.push(ev);
}

// Apply --last=N after filtering so N refers to matched results, not raw lines
const output = last > 0 ? matched.slice(-last) : matched;

if (asJson) {
  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
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
