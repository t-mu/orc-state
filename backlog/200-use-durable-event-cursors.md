---
ref: vnext-control-plane/200-use-durable-event-cursors
feature: vnext-control-plane
review_level: full
priority: high
status: done
depends_on:
  - vnext-control-plane/197-add-versioned-runtime-schema
---

# Task 200 — Use durable incremental event cursors

Depends on Task 197.

## Scope

**In scope:** Consumer offsets, bounded event batches and coordinator replay after restart.

**Out of scope:** Changing event types or scheduling policy.

---

## Context

### Current state

`coordinator.ts` scans all events each tick and persists `event-checkpoint.json` with processed IDs.

### Desired state

Each consumer resumes from a SQLite cursor and applies events incrementally; FTS history remains available.

### Start here

- `coordinator.ts` — `processEventCheckpoint`.
- `lib/eventCheckpoint.ts` — legacy checkpoint.

**Affected files:** coordinator event processing, offset store, tests.

---

## Goals

1. Must process `seq > last_seq` in bounded batches.
2. Must commit projection effects and cursor atomically or make replay idempotent.
3. Must seed the cursor from legacy checkpoint without dropping unprocessed events.

## Implementation

1. Add named offset read/advance operations and migration from the JSON checkpoint.
2. Change coordinator event loop to incremental batches; retain periodic wakeup.
3. Test restart, duplicate event, corrupt row and large history behavior.

## Acceptance criteria

- [ ] Restart replays no completed action and loses no pending event.
- [ ] Per-tick work depends on new events, not total history.
- [ ] Existing query and notification behavior remains available.

## Tests

Add restart and large-history integration tests with explicit cursor assertions.

## Verification

`npm test`; `orc doctor` against migrated test state.

## Risk / Rollback

**Risk:** Advancing a cursor before applying effects loses work. **Rollback:** Keep old checkpoint as backup until replay behavior passes and expose cursor reset for recovery.
