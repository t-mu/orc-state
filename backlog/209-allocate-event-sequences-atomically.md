---
ref: vnext-control-plane/209-allocate-event-sequences-atomically
feature: vnext-control-plane
review_level: full
priority: high
status: done
depends_on:
  - vnext-control-plane/194-sync-markdown-task-dependencies
---

# Task 209 — Allocate event sequences atomically

Depends on Task 194. First SQLite reliability slice.

## Scope

**In scope:** Replace the `MAX(seq)+1` race in `appendSequencedEvent` and prove multi-process concurrency.

**Out of scope:** Operational table migration, command delivery, and coordinator refactoring.

---

## Context

### Current state

`lib/eventLog.ts` has an autoincrement primary key but computes the next sequence in a separate read. Concurrent processes can choose the same value. Existing tests cover only sequential calls.

### Desired state

Every successful append gets a unique, increasing SQLite-assigned sequence; the returned sequence and JSON payload agree. Failed validation leaves no row.

### Start here

- `lib/eventLog.ts` — append and schema.
- `lib/eventLog.test.ts` — existing event behavior.

**Affected files:** `lib/eventLog.ts`, `lib/eventLog.test.ts`.

---

## Goals

1. Must allocate sequence and store its matching payload within one write transaction.
2. Must preserve explicit-sequence import and existing query/FTS behavior.
3. Must avoid duplicate or lost events from concurrent processes.

## Implementation

1. In `lib/eventLog.ts`, use an insert plus rowid/`RETURNING` within one SQLite transaction, then update the row payload with the assigned sequence before commit. Keep event validation before commit and the FTS trigger behavior intact.
2. Add a child-process concurrency test in `lib/eventLog.test.ts` using one temporary database and unique event IDs; assert all processes succeed and payload sequences match rows.

## Acceptance criteria

- [ ] Concurrent appenders produce one row per input and unique ascending sequences.
- [ ] Returned `seq` equals the parsed payload `seq` for every row.
- [ ] Invalid events and duplicate event IDs leave no partial row or FTS entry.
- [ ] Existing event query and JSONL migration tests pass.

## Tests

Add the concurrent process case and rollback cases to `lib/eventLog.test.ts`.

## Verification

`npx vitest run lib/eventLog.test.ts`; `npm test`; `orc doctor` when run against a test state directory.

## Risk / Rollback

**Risk:** A partial insert could leave a payload/sequence mismatch. **Rollback:** Revert the code; no schema change is needed. Retain the test database for diagnosis if the new concurrency case fails.
