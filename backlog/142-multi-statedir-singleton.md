---
ref: memory-quality/142-multi-statedir-singleton
feature: memory-quality
priority: normal
status: todo
---

# Task 142 — Support Multiple stateDirs in memoryStore

Independent.

## Scope

**In scope:**
- Replace module-level `_memDb` singleton with `Map<string, Database>` keyed by stateDir
- Scope `registerDb` key from `'memory'` to `'memory:' + stateDir`
- Make `closeMemoryDb(stateDir?)` accept optional stateDir (no-arg closes all for backward compat)
- Add `db.open` guard in both `initMemoryDb` and `getMemoryDb` to handle stale handles after `closeAllDatabases()`
- Guard against double-close in `closeMemoryDb` (check `db.open` before calling `db.close()`)

**Out of scope:**
- Changing any CLI command signatures or MCP handler signatures
- Modifying `lib/eventLog.ts` (the `registerDb`/`unregisterDb` contract is unchanged)
- Adding multi-process or worker_threads concurrency support

---

## Context

### Current state

`lib/memoryStore.ts` uses a single module-level `_memDb` variable (line 8). If two
different stateDirs call `initMemoryDb()`, the second is silently ignored — it returns
the first DB handle pointing at the wrong file. Additionally, `registerDb('memory', db)`
uses a hardcoded key (line 57), so a second registration overwrites the first in the
eventLog `_dbs` Map, orphaning the first DB handle.

A separate pre-existing issue: when `closeAllDatabases()` runs (from `eventLog.ts`), it
closes the DB handle via the `_dbs` Map but has no way to null out `_memDb`. Subsequent
`getMemoryDb()` returns a closed handle, causing "database is not open" errors.

### Desired state

`_memDbs` is a `Map<string, Database>` keyed by stateDir. Each stateDir gets its own
connection. `registerDb` uses a scoped key (`'memory:' + stateDir`). `getMemoryDb` checks
`db.open` before returning a cached connection and re-initializes if the handle is stale.
`closeMemoryDb()` with no args closes all connections (backward compat); with a stateDir
arg closes only that one.

### Start here

- `lib/memoryStore.ts` — lines 8, 10–60, 62–64, 66–72
- `lib/eventLog.ts` — `registerDb`/`unregisterDb`/`closeAllDatabases` for the Map pattern to mirror

**Affected files:**
- `lib/memoryStore.ts` — singleton → Map, scoped keys, open guard, closeMemoryDb signature
- `lib/memoryStore.test.ts` — new tests for multi-stateDir and stale handle recovery

---

## Goals

1. Must support multiple simultaneous stateDir connections without cross-contamination.
2. Must scope `registerDb` keys by stateDir to avoid collisions in the eventLog `_dbs` Map.
3. Must recover from stale closed handles (e.g. after `closeAllDatabases()`) by re-initializing.
4. Must preserve backward compatibility: `closeMemoryDb()` with no args closes all connections.
5. Must not break any existing callers (CLI commands, MCP handlers, coordinator, tests all call `closeMemoryDb()` with no args).

---

## Implementation

### Step 1 — Replace singleton with Map

**File:** `lib/memoryStore.ts`

Replace line 8:
```typescript
// BEFORE
let _memDb: Database.Database | null = null;

// AFTER
const _memDbs = new Map<string, Database.Database>();
```

### Step 2 — Rewrite initMemoryDb

**File:** `lib/memoryStore.ts`

Update the function (lines 10–60) to check `_memDbs.get(stateDir)` instead of `_memDb`:
```typescript
export function initMemoryDb(stateDir: string): Database.Database {
  const existing = _memDbs.get(stateDir);
  if (existing?.open) return existing;
  if (existing) _memDbs.delete(stateDir); // stale closed handle
  const dbPath = join(stateDir, MEMORY_DB_FILE);
  const db = new Database(dbPath);
  // ... WAL, busy_timeout, schema (unchanged) ...
  registerDb('memory:' + stateDir, db);
  _memDbs.set(stateDir, db);
  return db;
}
```

### Step 3 — Rewrite getMemoryDb with open guard

**File:** `lib/memoryStore.ts`

```typescript
export function getMemoryDb(stateDir: string): Database.Database {
  const existing = _memDbs.get(stateDir);
  if (existing?.open) return existing;
  if (existing) _memDbs.delete(stateDir); // stale closed handle
  return initMemoryDb(stateDir);
}
```

### Step 4 — Rewrite closeMemoryDb with optional stateDir

**File:** `lib/memoryStore.ts`

```typescript
export function closeMemoryDb(stateDir?: string): void {
  if (stateDir) {
    const db = _memDbs.get(stateDir);
    if (db) {
      unregisterDb('memory:' + stateDir);
      if (db.open) db.close();
      _memDbs.delete(stateDir);
    }
    return;
  }
  // No-arg: close all (backward compat)
  for (const [key, db] of _memDbs) {
    unregisterDb('memory:' + key);
    if (db.open) db.close();
  }
  _memDbs.clear();
}
```

### Step 5 — Add tests

**File:** `lib/memoryStore.test.ts`

Add a new `describe('multi-stateDir')` block with these tests:
- `"initMemoryDb supports multiple stateDirs simultaneously"` — init two temp dirs, verify different DB objects, insert in one, query other returns empty.
- `"closeMemoryDb(stateDir) closes only that stateDir"` — init two dirs, close one, verify other still works.
- `"getMemoryDb returns distinct DBs for different stateDirs"` — call getMemoryDb with two dirs, verify `!==`.
- `"getMemoryDb re-initializes after closeAllDatabases()"` — init, call `closeAllDatabases()`, call `getMemoryDb()`, verify it returns a working open handle.

---

## Acceptance criteria

- [ ] `_memDb` singleton is replaced with `_memDbs` Map.
- [ ] `registerDb` and `unregisterDb` use `'memory:' + stateDir` key consistently.
- [ ] `getMemoryDb` returns a working handle even after `closeAllDatabases()` has run.
- [ ] `closeMemoryDb()` with no args closes all open connections.
- [ ] `closeMemoryDb(stateDir)` closes only that specific connection.
- [ ] `closeMemoryDb()` does not throw after `closeAllDatabases()` has already closed the handles (double-close safe).
- [ ] `initMemoryDb` re-initializes if the cached handle is stale (closed by `closeAllDatabases()`).
- [ ] All existing tests pass without modification (backward compat).
- [ ] New multi-stateDir tests pass.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/memoryStore.test.ts`:

```typescript
describe('multi-stateDir', () => {
  it('initMemoryDb supports multiple stateDirs simultaneously', () => { ... });
  it('closeMemoryDb(stateDir) closes only that stateDir', () => { ... });
  it('getMemoryDb returns distinct DBs for different stateDirs', () => { ... });
  it('getMemoryDb re-initializes after closeAllDatabases()', () => { ... });
});
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts lib/memoryStore.integration.test.ts
```

```bash
nvm use 24 && npm test
```
