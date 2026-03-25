---
ref: general/40-fix-get-recent-events-ordering
title: "40 Fix Get Recent Events Ordering"
status: done
feature: general
task_type: fix
priority: high
---

## Context

In task 35 (`handleGetRecentEvents` in `mcp/handlers.ts`) was updated to use
`queryEvents` instead of `readRecentEvents`. This introduced a regression:
`queryEvents` uses `ORDER BY seq ASC LIMIT ?`, which returns the **oldest** N
events instead of the **most recent** N events.

The previous implementation used `readRecentEvents`, which used
`ORDER BY seq DESC LIMIT ?` then reversed the result to return the most recent
N events in chronological order.

## Problem

`handleGetRecentEvents` in `mcp/handlers.ts` calls:

```typescript
let events = queryEvents(stateDir, { ...(run_id !== undefined ? { run_id } : {}), limit: cap });
```

`queryEvents` in `lib/eventLog.ts` runs:

```sql
SELECT payload FROM events WHERE ... ORDER BY seq LIMIT ?
```

This returns the oldest `cap` events, not the newest.

## Acceptance Criteria

1. `handleGetRecentEvents` returns the most recent N events (by seq), in
   ascending chronological order (oldest first within the result window).
2. All existing tests pass.
3. A new unit test verifies that when there are more than `limit` events,
   `handleGetRecentEvents` returns the ones with the highest seq values.

## Implementation Plan

### Option A (preferred): Add `order` parameter to `queryEvents`

1. In `lib/eventLog.ts`, add an optional `order?: 'asc' | 'desc'` parameter to
   `queryEvents`. When `order === 'desc'`, emit `ORDER BY seq DESC`; otherwise
   keep the existing `ORDER BY seq ASC` default.

2. In `mcp/handlers.ts`, update the `handleGetRecentEvents` call to pass
   `order: 'desc'` and then reverse the returned array so the final result is
   in ascending chronological order (matching the previous behaviour of
   `readRecentEvents`):

```typescript
let events = queryEvents(stateDir, {
  ...(run_id !== undefined ? { run_id } : {}),
  limit: cap,
  order: 'desc',
}).reverse();
```

### Option B (alternative): Reuse `readRecentEvents`

Replace the `queryEvents` call in `handleGetRecentEvents` with a call to
`readRecentEvents`, then apply the `run_id` and `agent_id` filters manually
(as post-query filters).

Option A is preferred because it keeps the filtering inside the SQL query
(efficient) and makes `queryEvents` more general.

## Files to Change

- `lib/eventLog.ts` — add `order` parameter to `queryEvents`
- `mcp/handlers.ts` — pass `order: 'desc'` and reverse in `handleGetRecentEvents`
- `tests/` — add unit test covering the ordering behaviour

## Verification

```bash
npm test
orc doctor
```
