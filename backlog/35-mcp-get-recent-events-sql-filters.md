---
ref: general/35-mcp-get-recent-events-sql-filters
feature: general
priority: normal
status: todo
---

# Task 35 — Push agent_id/run_id filters to SQL in get_recent_events handler

Independent.

## Scope

**In scope:**
- Refactor `handleGetRecentEvents` in `mcp/handlers.ts` to call `queryEvents()` instead of `readRecentEvents()` + JS `.filter()`
- Fix the `actor_id` filter logic so it is a separate JS pass, not confused with the SQL `agent_id` filter
- Update the `get_recent_events` tool description in `mcp/tools-list.ts` to reflect both the SQLite backend and the corrected filter semantics

**Out of scope:**
- `handleQueryEvents` or any other handler
- `lib/eventLog.ts` or `lib/statusView.ts`
- Adding `actor_id` as a SQL column (it lives in the JSON payload and is not indexed)
- CLI commands

---

## Context

`handleGetRecentEvents` (handlers.ts:146-169) currently:
1. Fetches up to `cap` (200 max) recent events via `readRecentEvents()`
2. Post-filters the result in JS by `agent_id` and `run_id`

This means a caller asking for the last 50 events by `run_id=X` gets the most-recent 200 events loaded into memory, then filtered — returning at most 50 but potentially far fewer. Worse, the JS filter ORs `agent_id === agent_id || actor_id === agent_id`, conflating two different fields.

With `queryEvents()` the filters are pushed to SQL: the DB returns the last `cap` events *matching* the filter, which is both more efficient and semantically correct.

### Current state

```typescript
// handlers.ts:161-167
let events = readRecentEvents(join(stateDir, 'events.db'), cap);
if (agent_id) {
  events = events.filter(
    (e) => (e as unknown as Record<string, unknown>).agent_id === agent_id || e.actor_id === agent_id
  );
}
if (run_id) {
  events = events.filter((e) => (e as unknown as Record<string, unknown>).run_id === run_id);
}
return events;
```

### Desired state

```typescript
// SQL handles agent_id and run_id; one JS pass for actor_id only
let events = queryEvents(stateDir, { agent_id, run_id, limit: cap });
// actor_id lives in the JSON payload — keep as JS post-filter
if (agent_id) {
  events = [...events, ...queryEvents(stateDir, { limit: cap })
    .filter(e => e.actor_id === agent_id && !events.some(x => x.event_id === e.event_id))];
}
return events;
```

Wait — simpler and correct:

```typescript
let events = queryEvents(stateDir, { agent_id, run_id, limit: cap });
// Also include events where the agent appears only as actor_id (payload field, not indexed)
if (agent_id) {
  const byActorId = queryEvents(stateDir, { run_id, limit: cap })
    .filter(e => e.actor_id === agent_id);
  const seen = new Set(events.map(e => e.event_id));
  events = [...events, ...byActorId.filter(e => !seen.has(e.event_id))];
}
return events;
```

Actually, read the current usage carefully first. The actor_id match is intended as a fallback — if an event doesn't have agent_id but has actor_id matching the caller's agent_id filter, include it. A single post-filter pass is the right approach:

```typescript
// Fetch by agent_id SQL filter + run_id SQL filter
let events = queryEvents(stateDir, { agent_id, run_id, limit: cap });
// If filtering by agent_id, also retain any events matched only by actor_id
if (agent_id) {
  events = events.filter(e => e.actor_id === agent_id || (e as any).agent_id === agent_id);
}
```

No — this is wrong too. The right intent: `queryEvents` with `agent_id` already returns events where the DB `agent_id` column matches. The JS pass should add events where `actor_id` (payload field) matches the filter but `agent_id` column doesn't. This requires a second query or accepting that actor_id coverage is best-effort post-filter on the already-filtered set.

**Correct implementation:** The simplest correct approach:
1. Call `queryEvents(stateDir, { run_id, limit: cap })` (SQL filter for run_id only, if provided)
2. JS post-filter: keep events where `agent_id === param || actor_id === param`

This preserves the original semantics while still pushing `run_id` to SQL.

### Start here

- `mcp/handlers.ts:146-169` — `handleGetRecentEvents` implementation
- `mcp/tools-list.ts:80-102` — `get_recent_events` tool schema and description
- `lib/eventLog.ts:332-385` — `queryEvents()` signature and filter behaviour

**Affected files:**
- `mcp/handlers.ts` — `handleGetRecentEvents` only
- `mcp/tools-list.ts` — description at line 81 only

---

## Goals

1. Must push `run_id` filtering to SQL via `queryEvents()`.
2. Must preserve the original `agent_id || actor_id` matching semantics via a JS post-filter (since `actor_id` is not a SQL column).
3. Must not regress the existing handler tests in `mcp/handlers.test.ts` that cover `agent_id` and `run_id` filtering.
4. Must update the `get_recent_events` tool description to say "SQLite events database" and note that `run_id` is filtered server-side.
5. Must pass `npm test`.

---

## Implementation

### Step 1 — Refactor handleGetRecentEvents

**File:** `mcp/handlers.ts:161-167`

Replace the current fetch + JS filter with:

```typescript
// Push run_id to SQL; keep agent_id as JS post-filter (actor_id is a payload field, not indexed)
let events = queryEvents(stateDir, { run_id: run_id as string | undefined, limit: cap });
if (agent_id) {
  events = events.filter(
    (e) =>
      (e as unknown as Record<string, unknown>).agent_id === agent_id ||
      e.actor_id === agent_id,
  );
}
return events;
```

`readRecentEvents` is no longer called here. Verify whether it is called anywhere else in `handlers.ts` before removing the import.

### Step 2 — Update tool description

**File:** `mcp/tools-list.ts:81`

```typescript
// Before
'Return the most recent events from events.jsonl. Use agent_id or run_id to narrow results...'

// After
'Return the most recent events from the SQLite events database. run_id is filtered server-side; agent_id matches both the agent_id column and the actor_id payload field.'
```

---

## Acceptance criteria

- [ ] `handleGetRecentEvents` calls `queryEvents()` instead of `readRecentEvents()`.
- [ ] `run_id` filter is passed to `queryEvents()` as a SQL predicate.
- [ ] `agent_id` filter is applied as a JS post-filter covering both `agent_id` column and `actor_id` payload field.
- [ ] Existing handler tests for `get_recent_events` filtering pass without modification (or are updated to reflect the new semantics with a comment explaining the change).
- [ ] `get_recent_events` tool description no longer references `events.jsonl`.
- [ ] `npm test` passes.
- [ ] No changes outside `mcp/handlers.ts` and `mcp/tools-list.ts`.

---

## Tests

Existing tests in `mcp/handlers.test.ts` cover `agent_id` and `run_id` filtering. Run them first; if any fail due to the semantics change (SQL-first vs JS-first changes result ordering or count), update the test fixtures and add a comment explaining the new behaviour.

No new test file required, but add one case:

```typescript
it('get_recent_events: actor_id match is included when agent_id filter is set', () => {
  // Append an event with no agent_id but actor_id = 'orc-1'
  // Call handleGetRecentEvents({ agent_id: 'orc-1' })
  // Assert the event is present in the result
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
