import { queryEventPage, type EventPageFilter } from './eventLog.ts';

/** Shared by MCP `query_events` and `orc events`: same parameters, same `{ events, last_seq, has_more }` result. */
export const EVENT_QUERY_DEFAULT_LIMIT = 25;
export const EVENT_QUERY_MAX_LIMIT = 100;

export interface EventQueryArgs {
  run_id?: unknown;
  agent_id?: unknown;
  task_ref?: unknown;
  event_type?: unknown;
  notifications_only?: unknown;
  after_seq?: unknown;
  limit?: unknown;
  fts_query?: unknown;
  verbose?: unknown;
}

export interface EventQueryResult {
  events: Array<Record<string, unknown>>;
  last_seq: number;
  has_more: boolean;
}

const VERBOSE_ONLY_FIELDS = ['event_id', 'actor_type', 'actor_id'];

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value;
}

function optionalBoolean(name: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

/** Drop the fields a reader rarely needs; input_response loses the question it repeats (request_id stays). */
export function compactEvent(event: Record<string, unknown>): Record<string, unknown> {
  const compact = { ...event };
  for (const field of VERBOSE_ONLY_FIELDS) delete compact[field];
  if (compact.event === 'input_response' && compact.payload && typeof compact.payload === 'object') {
    const { question: _question, ...payload } = compact.payload as Record<string, unknown>;
    compact.payload = payload;
  }
  return compact;
}

export interface ParsedEventQuery {
  filter: EventPageFilter;
  afterSeq: number | null;
  limit: number;
  verbose: boolean;
}

/** Validate query arguments; throws a message naming the bad argument. */
export function parseEventQueryArgs(args: EventQueryArgs = {}): ParsedEventQuery {
  const limit = args.limit ?? EVENT_QUERY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > EVENT_QUERY_MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${EVENT_QUERY_MAX_LIMIT}; page with after_seq for more`);
  }
  const afterSeq = args.after_seq ?? null;
  if (afterSeq !== null && (!Number.isSafeInteger(afterSeq) || (afterSeq as number) < 0)) {
    throw new Error('after_seq must be a non-negative integer');
  }
  const filter: EventPageFilter = {};
  const run_id = optionalString('run_id', args.run_id);
  const agent_id = optionalString('agent_id', args.agent_id);
  const task_ref = optionalString('task_ref', args.task_ref);
  const event_type = optionalString('event_type', args.event_type);
  const fts_query = optionalString('fts_query', args.fts_query);
  if (run_id !== undefined) filter.run_id = run_id;
  if (agent_id !== undefined) filter.agent_id = agent_id;
  if (task_ref !== undefined) filter.task_ref = task_ref;
  if (event_type !== undefined) filter.event_type = event_type;
  if (fts_query !== undefined) filter.fts_query = fts_query;
  if (optionalBoolean('notifications_only', args.notifications_only)) filter.notifications_only = true;
  return { filter, afterSeq: afterSeq as number | null, limit: limit as number, verbose: optionalBoolean('verbose', args.verbose) };
}

export function queryEventsPage(stateDir: string, args: EventQueryArgs = {}): EventQueryResult {
  const { filter, afterSeq, limit, verbose } = parseEventQueryArgs(args);
  let page;
  try {
    page = queryEventPage(stateDir, filter, afterSeq, limit);
  } catch (error) {
    if (filter.fts_query === undefined) throw error;
    throw new Error(`invalid fts_query: ${error instanceof Error ? error.message : String(error)}`);
  }
  const events = page.events as unknown as Array<Record<string, unknown>>;
  return { events: verbose ? events : events.map(compactEvent), last_seq: page.last_seq, has_more: page.has_more };
}
