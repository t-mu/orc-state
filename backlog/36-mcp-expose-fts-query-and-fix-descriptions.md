---
ref: general/36-mcp-expose-fts-query-and-fix-descriptions
feature: general
priority: normal
status: done
---

# Task 36 — Expose fts_query in query_events MCP tool and fix stale descriptions

Independent.

## Scope

**In scope:**
- Add `fts_query` parameter to the `query_events` tool schema in `mcp/tools-list.ts`
- Pass `fts_query` through to `queryEvents()` in `handleQueryEvents` in `mcp/handlers.ts`
- Wrap the `queryEvents()` call in `handleQueryEvents` with error handling for malformed FTS5 syntax
- Update stale tool descriptions in `mcp/tools-list.ts` for both `get_recent_events` and `query_events`

**Out of scope:**
- `lib/eventLog.ts` — `queryEvents()` already supports `fts_query`; no changes needed there
- `handleGetRecentEvents` — covered by Task 35
- CLI commands or E2E tests
- Adding FTS5 support to any tool other than `query_events`

---

## Context

`lib/eventLog.ts` has supported `fts_query` (FTS5 full-text search over `event`, `agent_id`, `run_id`, `task_ref`, and `payload`) since Task 24. However, the `query_events` MCP tool never exposes this parameter — it is absent from the input schema and never forwarded by the handler. The feature is effectively dead code from the MCP perspective.

Additionally, both `get_recent_events` and `query_events` tool descriptions still reference `events.jsonl`, misleading any MCP client or agent reading the schema.

A separate risk: if `fts_query` is exposed, an MCP client could pass malformed FTS5 syntax (e.g. unclosed parentheses, bare operators). `better-sqlite3` throws synchronously in that case, and the handler has no try/catch — the error would propagate as an unhandled MCP response. A narrow catch around the `queryEvents()` call is sufficient.

### Current state

- `query_events` input schema: `run_id`, `agent_id`, `event_type`, `after_seq`, `limit` — no `fts_query`
- `handleQueryEvents` builds `opts` from those five fields and calls `queryEvents(stateDir, opts)` — `fts_query` never set
- Both tool descriptions say "events.jsonl"
- Malformed FTS5 syntax throws an uncaught error

### Desired state

- `query_events` input schema includes `fts_query?: string`
- `handleQueryEvents` passes `fts_query` to `queryEvents()` when present
- Malformed FTS5 syntax returns a descriptive error string, not an unhandled exception
- Both tool descriptions say "SQLite events database"

### Start here

- `mcp/tools-list.ts:80-102` — `get_recent_events` schema and description
- `mcp/tools-list.ts:304-335` — `query_events` schema and description
- `mcp/handlers.ts:816-828` — `handleQueryEvents` implementation
- `lib/eventLog.ts:332-385` — `queryEvents()` signature, confirming `fts_query` is already supported

**Affected files:**
- `mcp/tools-list.ts` — add `fts_query` property; update two descriptions
- `mcp/handlers.ts` — forward `fts_query`; add try/catch in `handleQueryEvents`

---

## Goals

1. Must add `fts_query` as an optional string property to the `query_events` input schema.
2. Must forward `fts_query` from `handleQueryEvents` to `queryEvents()`.
3. Must catch FTS5 syntax errors from `queryEvents()` and return a descriptive error message to the MCP caller instead of throwing.
4. Must update `get_recent_events` description to remove "events.jsonl" reference.
5. Must update `query_events` description to remove "events.jsonl" reference and mention FTS5 search.
6. Must pass `npm test`.

---

## Implementation

### Step 1 — Add fts_query to query_events tool schema

**File:** `mcp/tools-list.ts` — inside `query_events` `inputSchema.properties`

```typescript
fts_query: {
  type: 'string',
  description:
    'Full-text search query (SQLite FTS5 MATCH syntax) over event type, agent_id, run_id, task_ref, and payload. Combined with other filters using AND.',
},
```

No change to `required` — `fts_query` is optional.

### Step 2 — Forward fts_query in handleQueryEvents

**File:** `mcp/handlers.ts:816-828`

Add `fts_query` to the destructured parameter and to the opts builder:

```typescript
export function handleQueryEvents(
  stateDir: string,
  { run_id, agent_id, event_type, after_seq, limit = 50, fts_query }: Record<string, unknown> = {},
) {
  const opts: Parameters<typeof queryEvents>[1] = {
    limit: Number.isInteger(limit) ? (limit as number) : 50,
  };
  if (typeof run_id === 'string') opts.run_id = run_id;
  if (typeof agent_id === 'string') opts.agent_id = agent_id;
  if (typeof event_type === 'string') opts.event_type = event_type;
  if (typeof after_seq === 'number') opts.after_seq = after_seq;
  if (typeof fts_query === 'string') opts.fts_query = fts_query;

  try {
    return queryEvents(stateDir, opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface FTS5 syntax errors as a descriptive failure rather than an unhandled exception
    if (fts_query && (msg.includes('fts5') || msg.includes('MATCH') || msg.includes('syntax error'))) {
      throw new Error(`Invalid fts_query — FTS5 syntax error: ${msg}`);
    }
    throw err;
  }
}
```

### Step 3 — Fix stale tool descriptions

**File:** `mcp/tools-list.ts`

`get_recent_events` (line ~81):
```typescript
// Before
'Return the most recent events from events.jsonl. Use agent_id or run_id to narrow results and reduce token usage.'

// After
'Return the most recent events from the SQLite events database. Use agent_id or run_id to narrow results and reduce token usage.'
```

`query_events` (line ~305):
```typescript
// Before
'Query events.jsonl with optional filters. Returns last `limit` matching events.'

// After
'Query the SQLite events database with optional filters. Supports run_id, agent_id, event_type, after_seq, and fts_query (FTS5 full-text search). Returns last `limit` matching events.'
```

---

## Acceptance criteria

- [ ] `query_events` tool schema includes `fts_query` as an optional string property.
- [ ] `handleQueryEvents` passes `fts_query` to `queryEvents()` when the parameter is a string.
- [ ] Calling `query_events` with a valid `fts_query` returns matching events (FTS5 path exercised).
- [ ] Calling `query_events` with malformed `fts_query` (e.g. `"AND OR"`) returns a descriptive error, not an unhandled exception.
- [ ] Neither `get_recent_events` nor `query_events` description contains "events.jsonl".
- [ ] `npm test` passes.
- [ ] No changes outside `mcp/tools-list.ts` and `mcp/handlers.ts`.

---

## Tests

Add to `mcp/handlers.test.ts`:

```typescript
it('query_events: fts_query is forwarded to queryEvents and returns matching events', () => {
  // Append events with known payload content
  // Call handleQueryEvents({ fts_query: '<known term>' })
  // Assert matching events are returned
});

it('query_events: malformed fts_query throws a descriptive error, not a raw DB error', () => {
  // Call handleQueryEvents({ fts_query: 'AND OR INVALID' })
  // Assert throws Error with message containing 'fts_query' or 'FTS5'
});
```

---

## Verification

```bash
npx vitest run mcp/handlers.test.ts
```

```bash
nvm use 24 && npm test
```
