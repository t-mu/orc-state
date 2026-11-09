#!/usr/bin/env node
/**
 * cli/events.ts
 * Usage: orc events [--run-id=<id>] [--agent-id=<id>] [--task-ref=<ref>] [--event=<type>] [--notifications]
 *   [--after=<seq>] [--limit=<1-100>] [--fts=<query>] [--verbose] [--json] [--follow [--max-events=<n>]]
 *
 * Reads the event log through the same handler as MCP query_events and prints
 * the same { events, last_seq, has_more } JSON with --json. --follow keeps
 * polling after the first page and prints each new event as one JSON line
 * (--json) or one text line.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseCommandArgsOrExit } from '../lib/args.ts';
import { parseEventQueryArgs, queryEventsPage, type EventQueryArgs, type EventQueryResult } from '../lib/eventQuery.ts';
import { EVENTS_FILE, STATE_DIR } from '../lib/paths.ts';
import { cliError, eventLogMissing, exitAfterFlush, printJson, requireProjectScope } from './shared.ts';
import { USAGE } from './usage.ts';

const FOLLOW_POLL_MS = 1000;

const { values } = parseCommandArgsOrExit(USAGE['events'], {
  'run-id': { type: 'string' },
  'agent-id': { type: 'string' },
  'task-ref': { type: 'string' },
  event: { type: 'string' },
  notifications: { type: 'boolean' },
  after: { type: 'string' },
  limit: { type: 'string' },
  fts: { type: 'string' },
  verbose: { type: 'boolean' },
  json: { type: 'boolean' },
  follow: { type: 'boolean' },
  'max-events': { type: 'string' },
});
requireProjectScope();

function nonNegativeInt(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    console.error(`Error: --${name} must be a non-negative integer\nUsage: ${USAGE['events']}`);
    process.exit(1);
  }
  return Number(raw);
}

const asJson = values.json === true;
const after = nonNegativeInt('after', values.after);
const limit = nonNegativeInt('limit', values.limit);
const maxEvents = nonNegativeInt('max-events', values['max-events']) ?? 0;
const args: EventQueryArgs = {
  run_id: values['run-id'],
  agent_id: values['agent-id'],
  task_ref: values['task-ref'],
  event_type: values.event,
  notifications_only: values.notifications === true,
  after_seq: after,
  limit,
  fts_query: values.fts,
  verbose: values.verbose === true,
};

function query(afterSeq: number | undefined): EventQueryResult {
  // A missing database is an empty log; reading must not create it.
  if (eventLogMissing(EVENTS_FILE)) return { events: [], last_seq: afterSeq ?? 0, has_more: false };
  return queryEventsPage(STATE_DIR, { ...args, after_seq: afterSeq });
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatLine(event: Record<string, unknown>): string {
  const parts = [String(event.seq), str(event.ts), str(event.event)];
  if (event.run_id) parts.push(`run=${str(event.run_id)}`);
  if (event.task_ref) parts.push(`task=${str(event.task_ref)}`);
  if (event.agent_id) parts.push(`agent=${str(event.agent_id)}`);
  if (event.phase) parts.push(`phase=${str(event.phase)}`);
  if (event.actor_id) parts.push(`actor=${str(event.actor_type)}:${str(event.actor_id)}`);
  return parts.join(' ');
}

let first: EventQueryResult;
try {
  parseEventQueryArgs(args);
  first = query(after);
} catch (error) {
  cliError(error);
}

if (values.follow !== true) {
  if (asJson) {
    printJson(first);
    await exitAfterFlush(0);
  }
  if (first.events.length === 0) console.log('(no matching events)');
  for (const event of first.events) console.log(formatLine(event));
  if (first.has_more) {
    console.log(after === undefined
      ? `(older events exist; page forward with --after=<seq>)`
      : `(more events follow; next page: --after=${first.last_seq})`);
  }
  await exitAfterFlush(0);
}

let printed = 0;
let page = first;
for (;;) {
  for (const event of page.events) {
    console.log(asJson ? JSON.stringify(event) : formatLine(event));
    if (maxEvents > 0 && ++printed >= maxEvents) await exitAfterFlush(0);
  }
  const cursor = page.last_seq;
  // A first page read without --after has has_more for older events, not newer ones.
  const newerWaiting = page.has_more && (page !== first || after !== undefined);
  if (!newerWaiting) await sleep(FOLLOW_POLL_MS);
  try {
    page = query(cursor);
  } catch (error) {
    cliError(error);
  }
}
