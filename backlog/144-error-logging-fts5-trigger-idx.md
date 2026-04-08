---
ref: memory-quality/144-error-logging-fts5-trigger-idx
feature: memory-quality
priority: normal
status: done
---

# Task 144 — Add Error Logging, FTS5 UPDATE Trigger, and Composite Index

Independent.

## Scope

**In scope:**
- Replace bare `catch { return 0/'' }` blocks with `console.error` logging in 3 functions
- Add column-specific FTS5 UPDATE trigger (`drawers_au`) for content, tags, wing, hall, room
- Remove stale "No UPDATE trigger" comment at lines 49–51
- Add composite index on `(wing, room)` for GROUP BY query performance

**Out of scope:**
- Changing prune or wake-up function signatures or return types
- Adding structured error objects or error propagation (keep catch-and-return pattern)
- Modifying `lib/eventLog.ts` or any other module

---

## Context

### Current state

Three functions in `lib/memoryStore.ts` silently swallow errors:
- `memoryWakeUp` (line 303): `catch { return ''; }`
- `pruneExpiredMemories` (line 340): `catch { return 0; }`
- `pruneByCapacity` (line 364): `catch { return 0; }`

DB permission errors, corrupt files, or locked databases look like "nothing to do" to
callers. The coordinator wraps pruning in its own try/catch (line 1774), but errors are
never logged anywhere.

The FTS5 virtual table has INSERT and DELETE triggers but no UPDATE trigger (lines 49–51
document this as intentional). If future code updates content or tags columns, the FTS
index silently goes stale. An explicit comment says to add the trigger later, but adding
it now is defensive and low-cost.

GROUP BY queries in `listWings`, `listRooms`, and `pruneByCapacity` scan the full table.
A composite index on `(wing, room)` would accelerate these at scale.

### Desired state

Errors are logged via `console.error('[memoryStore] ...')` before returning the default
value — callers still don't crash, but errors are visible in logs. A column-specific
UPDATE trigger keeps the FTS5 index consistent for any column change. A composite index
accelerates taxonomy queries.

### Start here

- `lib/memoryStore.ts` — lines 49–51 (comment), 303, 340, 364 (catch blocks), schema section

**Affected files:**
- `lib/memoryStore.ts` — catch block logging, UPDATE trigger, composite index
- `lib/memoryStore.test.ts` — tests for logging, trigger correctness, index existence

---

## Goals

1. Must log errors via `console.error` with `[memoryStore]` prefix in all three catch blocks.
2. Must still return the default value (0 or '') after logging — do not throw.
3. Must add a column-specific UPDATE trigger that fires only when FTS-indexed columns change.
4. Must remove the stale "No UPDATE trigger" comment.
5. Must add a composite index on `(wing, room)`.

---

## Implementation

### Step 1 — Add error logging to catch blocks

**File:** `lib/memoryStore.ts`

Replace bare catches in three functions:

```typescript
// memoryWakeUp (~line 303)
catch (err) {
  console.error(`[memoryStore] memoryWakeUp failed: ${(err as Error).message}`);
  return '';
}

// pruneExpiredMemories (~line 340)
catch (err) {
  console.error(`[memoryStore] pruneExpiredMemories failed: ${(err as Error).message}`);
  return 0;
}

// pruneByCapacity (~line 364)
catch (err) {
  console.error(`[memoryStore] pruneByCapacity failed: ${(err as Error).message}`);
  return 0;
}
```

### Step 2 — Add FTS5 UPDATE trigger

**File:** `lib/memoryStore.ts`

Delete the comment at lines 49–51 ("No UPDATE trigger…") and add:

```sql
CREATE TRIGGER IF NOT EXISTS drawers_au
  AFTER UPDATE OF content, tags, wing, hall, room ON drawers BEGIN
  INSERT INTO drawers_fts(drawers_fts, rowid, content, tags, wing, hall, room)
  VALUES ('delete', old.id, old.content, old.tags, old.wing, old.hall, old.room);
  INSERT INTO drawers_fts(rowid, content, tags, wing, hall, room)
  VALUES (new.id, new.content, new.tags, new.wing, new.hall, new.room);
END;
```

Using `AFTER UPDATE OF content, tags, wing, hall, room` avoids unnecessary FTS5 churn
on importance-only updates. The trigger only fires when an FTS-indexed column changes.

### Step 3 — Add composite index

**File:** `lib/memoryStore.ts`

Add after the existing unique index (after line 54), within the `db.exec()` block:

```sql
CREATE INDEX IF NOT EXISTS idx_drawers_wing_room ON drawers(wing, room);
```

### Step 4 — Add tests

**File:** `lib/memoryStore.test.ts`

Error logging tests (use `vi.spyOn(console, 'error')`):
- `"memoryWakeUp logs warning on failure"` — call with a nonexistent stateDir path (bypasses no existsSync guard in this function), verify `console.error` called with `[memoryStore]`
- `"pruneExpiredMemories logs warning on failure"` — init the DB, then create a stateDir with a corrupted (non-SQLite) `memory.db` file that passes `existsSync` but fails on `db.prepare()`. Alternatively, init the DB, close it via `closeAllDatabases()` so the cached handle is stale, then call `pruneExpiredMemories`. Note: `pruneExpiredMemories` and `pruneByCapacity` have an `existsSync` guard before the try-catch, so a nonexistent path returns 0 without reaching the catch block.
- `"pruneByCapacity logs warning on failure"` — same corrupt-file or stale-handle strategy as pruneExpiredMemories

FTS5 UPDATE trigger test:
- `"FTS index stays consistent after content column update"` — store drawer with content "alpha keywords", directly UPDATE content to "beta keywords" via `db.prepare().run()`, search for "beta" → found, search for "alpha" → not found

Index existence test:
- `"creates wing_room composite index"` — init DB, query `PRAGMA index_list('drawers')`, verify `idx_drawers_wing_room` present

---

## Acceptance criteria

- [ ] `console.error` is called with `[memoryStore]` prefix when `memoryWakeUp` fails.
- [ ] `console.error` is called with `[memoryStore]` prefix when `pruneExpiredMemories` fails.
- [ ] `console.error` is called with `[memoryStore]` prefix when `pruneByCapacity` fails.
- [ ] All three functions still return their default value (not throw) after logging.
- [ ] FTS5 index reflects content changes made via UPDATE statement.
- [ ] FTS5 UPDATE trigger does NOT fire on importance-only updates (column-specific).
- [ ] `idx_drawers_wing_room` index exists after `initMemoryDb`.
- [ ] Stale "No UPDATE trigger" comment is removed.
- [ ] All existing tests pass unchanged.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/memoryStore.test.ts`:

```typescript
it('memoryWakeUp logs warning on failure', () => { ... });
it('pruneExpiredMemories logs warning on failure', () => { ... });
it('pruneByCapacity logs warning on failure', () => { ... });
it('FTS index stays consistent after content column update', () => { ... });
it('creates wing_room composite index', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: exits 0, FTS5 integrity check passes with new UPDATE trigger
```
