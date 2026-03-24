---
ref: general/34-statusview-use-read-recent-events
feature: general
priority: normal
status: todo
---

# Task 34 — Replace readEvents + slice in statusView with readRecentEvents

Independent.

## Scope

**In scope:**
- Replace `allEvents.slice(-20)` on line 174 of `lib/statusView.ts` with a direct `readRecentEvents()` call

**Out of scope:**
- The `readEvents()` call on line 173 (feeds `latestRunActivityDetailMap` — must stay untouched)
- Any other file in `lib/`, `mcp/`, or `cli/`
- Changes to the `readRecentEvents` function itself

---

## Context

`lib/statusView.ts` builds the status display used by both `orc status` and the `get_status` MCP tool. It currently reads every event ever recorded into memory, then slices the last 20 for display. With the SQLite migration landed (Task 24), `readRecentEvents()` issues a `SELECT ... ORDER BY seq DESC LIMIT ?` query that never touches the rest of the table.

The `get_status` MCP tool is the most frequently called tool by the master agent. Loading the full event log on every call is an unnecessary cost.

### Current state

`lib/statusView.ts:168-174`:
```typescript
const eventsPath = join(stateDir, 'events.jsonl');
let allEvents: unknown[] = [];
let recentEvents: unknown[] = [];
try {
  allEvents = readEvents(eventsPath);          // loads ALL events
  recentEvents = allEvents.slice(-20);         // only needs last 20
}
```

### Desired state

Line 174 replaced so the display slice is fetched directly from the DB with a LIMIT:
```typescript
  allEvents = readEvents(eventsPath);
  recentEvents = readRecentEvents(eventsPath, 20);
```

### Start here

- `lib/statusView.ts` — one-line change at line 174
- `lib/eventLog.ts` — confirm `readRecentEvents(logPath, limit)` signature (line ~298)

**Affected files:**
- `lib/statusView.ts` — line 174 only

---

## Goals

1. Must replace `allEvents.slice(-20)` with `readRecentEvents(eventsPath, 20)`.
2. Must not modify line 173 (`allEvents = readEvents(eventsPath)`).
3. Must not change any other line in `statusView.ts`.
4. Must pass `npm test`.

---

## Implementation

### Step 1 — Replace the slice

**File:** `lib/statusView.ts:174`

```typescript
// Before
recentEvents = allEvents.slice(-20);

// After
recentEvents = readRecentEvents(eventsPath, 20);
```

Ensure `readRecentEvents` is imported at the top of the file. If it is not already imported from `../lib/eventLog.ts`, add it.

---

## Acceptance criteria

- [ ] `lib/statusView.ts` line 174 calls `readRecentEvents(eventsPath, 20)` instead of `allEvents.slice(-20)`.
- [ ] Line 173 is unchanged: `allEvents = readEvents(eventsPath)`.
- [ ] `npm test` passes.
- [ ] No changes to files outside `lib/statusView.ts`.

---

## Tests

No new tests required. Existing status-view tests cover the output contract. If a test explicitly asserts the slice behaviour, update the expected value to match `readRecentEvents` semantics (same result for any log with ≥ 20 events).

---

## Verification

```bash
npx vitest run lib/statusView.test.ts
```

```bash
nvm use 24 && npm test
```
