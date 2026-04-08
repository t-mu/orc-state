---
ref: memory-quality/139-memory-expiry-and-pruning
feature: memory-quality
priority: normal
status: todo
depends_on:
  - memory-foundation/129-drawer-crud-spatial-coordinates
  - memory-foundation/132-spatial-taxonomy-queries
---

# Task 139 — Add Memory Expiry and Pruning

Depends on Tasks 129 and 132.

## Scope

**In scope:**
- `pruneExpiredMemories()` — delete drawers past their `expires_at` timestamp
- `pruneByCapacity()` — keep top-N drawers per room by importance, delete excess
- Wire pruning into coordinator startup (once, not every tick)

**Out of scope:**
- Archive mechanism (delete only, no archiving)
- MCP tool for pruning (manual CLI or coordinator-only)

---

## Context

### Current state

Drawers have an optional `expires_at` column (Task 128 schema) but nothing reads or enforces it.
Without pruning, the memory store grows unbounded as events, reviews, and manual records accumulate.

### Desired state

Two pruning functions keep the memory store bounded:
- Expired memories are deleted when their `expires_at` has passed.
- Per-room capacity is enforced at 200 drawers (configurable), keeping highest-importance entries.
Pruning runs once at coordinator startup.

### Start here

- `lib/memoryStore.ts` — add pruning functions
- `coordinator.ts` — `initializeTickState()` for startup hook

**Affected files:**
- `lib/memoryStore.ts` — add `pruneExpiredMemories()` and `pruneByCapacity()`
- `coordinator.ts` — call pruning at startup

---

## Goals

1. Must delete drawers where `expires_at < NOW`.
2. Must keep top-N drawers per room by importance (default N=200), deleting the rest.
3. Must run pruning once at coordinator startup (in `initializeTickState` or similar).
4. Must be a no-op on empty DB or when memory.db doesn't exist.
5. Must also delete corresponding FTS5 entries (via the existing DELETE trigger from Task 128).

---

## Implementation

### Step 1 — Add pruning functions

**File:** `lib/memoryStore.ts`

```ts
export function pruneExpiredMemories(stateDir: string): number {
  try {
    const db = getMemoryDb(stateDir);
    const result = db.prepare(`DELETE FROM drawers WHERE expires_at IS NOT NULL AND expires_at < ?`)
      .run(new Date().toISOString());
    return result.changes;
  } catch { return 0; }
}

export function pruneByCapacity(stateDir: string, maxPerRoom = 200): number {
  try {
    const db = getMemoryDb(stateDir);
    // Find rooms over capacity and delete lowest-importance drawers
    const overCapacity = db.prepare(`
      SELECT wing, room, COUNT(*) as cnt FROM drawers
      GROUP BY wing, room HAVING cnt > ?
    `).all(maxPerRoom) as Array<{ wing: string; room: string; cnt: number }>;

    let totalDeleted = 0;
    for (const { wing, room } of overCapacity) {
      const result = db.prepare(`
        DELETE FROM drawers WHERE id IN (
          SELECT id FROM drawers WHERE wing = ? AND room = ?
          ORDER BY importance DESC, created_at DESC
          LIMIT -1 OFFSET ?
        )
      `).run(wing, room, maxPerRoom);
      totalDeleted += result.changes;
    }
    return totalDeleted;
  } catch { return 0; }
}
```

### Step 2 — Wire into coordinator startup

**File:** `coordinator.ts`

In the initialization path (near `initializeTickState` or the startup log):

```ts
try {
  const expired = pruneExpiredMemories(STATE_DIR);
  const capped = pruneByCapacity(STATE_DIR);
  if (expired + capped > 0) log(`memory pruning: removed ${expired} expired, ${capped} over-capacity`);
} catch { /* memory system not initialized */ }
```

---

## Acceptance criteria

- [ ] `pruneExpiredMemories()` deletes drawers past their `expires_at`
- [ ] `pruneExpiredMemories()` returns count of deleted drawers
- [ ] `pruneByCapacity()` keeps top-200 (default) drawers per room
- [ ] `pruneByCapacity()` preserves highest-importance drawers
- [ ] FTS5 entries are cleaned up via DELETE trigger
- [ ] Pruning runs once at coordinator startup
- [ ] Pruning is a no-op when memory.db doesn't exist
- [ ] Pruning is a no-op on empty DB
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('pruneExpiredMemories deletes past-due drawers', () => { ... });
it('pruneExpiredMemories leaves non-expired drawers intact', () => { ... });
it('pruneByCapacity keeps top-N by importance per room', () => { ... });
it('pruneByCapacity is a no-op when all rooms under limit', () => { ... });
it('pruning functions return 0 on empty DB', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```
