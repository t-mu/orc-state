---
ref: craftsmanship-foundations/78-simplify-event-identity
feature: craftsmanship-foundations
priority: low
status: done
---

# Task 78 — Simplify Over-Engineered Event Identity Fallback

Independent.

## Scope

**In scope:**
- Simplify `eventIdentity()` and `ensureEventIdentity()` in `lib/eventLog.ts`
- Document that the fallback path is for legacy data only

**Out of scope:**
- Changing the event storage schema
- Removing event identity entirely

---

## Context

### Current state

`eventIdentity()` builds a complex 6-field fallback string from seq+event+run_id+ts for events without `event_id`. Since SQLite now assigns `event_id` via `randomUUID()` on insert, this fallback only applies to legacy pre-migration events.

### Desired state

Simplified fallback using just `seq` for legacy events, with a comment explaining the context.

### Start here

- `lib/eventLog.ts` — lines 107-145

**Affected files:**
- `lib/eventLog.ts` — simplify fallback functions

---

## Goals

1. Must simplify the fallback identity to use `seq` for legacy events
2. Must add clarifying comment about when the fallback applies
3. Must not change behavior for events with `event_id` already set

---

## Acceptance criteria

- [ ] `eventIdentity()` is simplified
- [ ] Comment explains the legacy context
- [ ] `npm test` passes

---

## Verification

```bash
npx vitest run lib/eventLog.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
