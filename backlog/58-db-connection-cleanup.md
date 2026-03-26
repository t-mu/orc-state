---
ref: runtime-robustness/58-db-connection-cleanup
title: "Add closeAllDatabases() and call during coordinator shutdown"
status: done
feature: runtime-robustness
task_type: implementation
priority: normal
depends_on: []
---

# Task 58 — Add closeAllDatabases() and Call During Coordinator Shutdown

Independent.

## Scope

**In scope:**
- Export a `closeAllDatabases()` function from `lib/eventLog.ts`.
- Call it in coordinator `doShutdown()` after the `coordinator_stopped` event.

**Out of scope:**
- Changing the singleton caching pattern in `_dbs`.
- Adding per-database close APIs.
- Session cleanup (separate task).

---

## Context

### Current state

The module-level `_dbs` Map in `lib/eventLog.ts` caches `better-sqlite3` Database connections for the lifetime of the process. There is no exported function to close them. During coordinator shutdown, connections are left open — WAL checkpointing is deferred to OS process teardown.

### Desired state

A `closeAllDatabases()` export exists and is called during `doShutdown()`, ensuring explicit WAL checkpoint and file handle release before process exit.

### Start here

- `lib/eventLog.ts` — `_dbs` Map (line 9), `initEventsDb()` function
- `coordinator.ts` — `doShutdown()` function

**Affected files:**
- `lib/eventLog.ts` — add `closeAllDatabases()` export
- `coordinator.ts` — import and call in `doShutdown()`

---

## Goals

1. Must export `closeAllDatabases()` from `lib/eventLog.ts`.
2. Must close all cached connections and clear the `_dbs` Map.
3. Must be best-effort — individual close failures must not throw.
4. Must be called in `doShutdown()` after `coordinator_stopped` event emission and before `process.exit(0)`.
5. Must not break event writes that happen before shutdown.

---

## Implementation

### Step 1 — Add closeAllDatabases() export

**File:** `lib/eventLog.ts`

Add after `initEventsDb()`:
```typescript
export function closeAllDatabases(): void {
  for (const [key, db] of _dbs) {
    try { db.close(); } catch { /* best-effort */ }
    _dbs.delete(key);
  }
}
```

### Step 2 — Call in coordinator shutdown

**File:** `coordinator.ts`

Import `closeAllDatabases` from `./lib/eventLog.ts`. In `doShutdown()`, after the `coordinator_stopped` event emission and before `process.exit(0)`:
```typescript
try { closeAllDatabases(); } catch { /* best-effort */ }
```

---

## Acceptance criteria

- [ ] `closeAllDatabases()` is exported and closes all cached connections.
- [ ] Calling `closeAllDatabases()` twice does not throw.
- [ ] Coordinator shutdown calls `closeAllDatabases()` before exit.
- [ ] `npm test` passes.
- [ ] No changes outside `lib/eventLog.ts` and `coordinator.ts`.

---

## Tests

Add to `lib/eventLog.test.ts`:

```typescript
it('closeAllDatabases() closes connections and clears cache', () => { ... });
it('closeAllDatabases() is idempotent', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/eventLog.test.ts
```

```bash
nvm use 24 && npm test
```
