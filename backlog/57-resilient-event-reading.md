---
ref: runtime-robustness/57-resilient-event-reading
title: "Skip corrupted event rows instead of failing entire read"
status: done
feature: runtime-robustness
task_type: implementation
priority: high
depends_on: []
---

# Task 57 — Skip Corrupted Event Rows Instead of Failing Entire Read

Independent.

## Scope

**In scope:**
- Make `readEvents()` skip malformed rows with a warning instead of throwing.
- Align `readEvents()` error handling with `readEventsSince()` which already skips silently.

**Out of scope:**
- Automated event repair or backfill.
- Changes to `appendSequencedEvent()` write path.
- Changes to the SQLite schema.

---

## Context

### Current state

`readEvents()` in `lib/eventLog.ts` throws on the first malformed event payload or validation failure. A single corrupted row (bit flip, partial write) kills the entire event read, blocking the coordinator from processing any events past the bad row.

### Desired state

`readEvents()` logs a `console.error` warning for each corrupted/invalid row and continues processing the remaining events. The coordinator can operate even with individual event corruption.

### Start here

- `lib/eventLog.ts` — `readEvents()` function (lines 251-273), compare with `readEventsSince()` (lines 279-293) which already has skip behavior.

**Affected files:**
- `lib/eventLog.ts` — modify error handling in `readEvents()`

---

## Goals

1. Must not throw when a single event row has unparseable JSON payload.
2. Must not throw when a single event row fails validation.
3. Must log a `console.error` with row index and error message for each skipped event.
4. Must continue processing all remaining events after a corrupted row.
5. Must not change behavior for valid event stores (no regressions).

---

## Implementation

### Step 1 — Replace throw with skip-and-warn in readEvents()

**File:** `lib/eventLog.ts`

In the `readEvents()` loop, replace the throw in the validation error block with:
```typescript
if (validationErrors.length > 0) {
  console.error(
    `[eventLog] skipping invalid event at row ${i + 1}: ${validationErrors.join('; ')}`
  );
  continue;
}
```

Replace the catch block with:
```typescript
} catch (error) {
  console.error(
    `[eventLog] skipping corrupted event at row ${i + 1}: ${(error as Error).message}`
  );
  continue;
}
```

Invariant: do not modify `readEventsSince()`, `appendSequencedEvent()`, or the SQLite schema.

---

## Acceptance criteria

- [ ] `readEvents()` returns all valid events when one row has corrupted JSON payload.
- [ ] `readEvents()` returns all valid events when one row fails validation.
- [ ] A `console.error` line is emitted for each skipped row.
- [ ] Existing tests pass unchanged (valid event stores unaffected).
- [ ] No changes to files outside `lib/eventLog.ts`.

---

## Tests

Add to `lib/eventLog.test.ts`:

```typescript
it('skips rows with unparseable JSON and returns remaining events', () => { ... });
it('skips rows that fail validation and returns remaining events', () => { ... });
it('logs console.error for each skipped row', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/eventLog.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Silently dropping events could mask data loss. The console.error log preserves observability.
**Rollback:** Revert `lib/eventLog.ts` to previous version.
