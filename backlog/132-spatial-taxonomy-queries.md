---
ref: memory-foundation/132-spatial-taxonomy-queries
feature: memory-foundation
priority: normal
status: todo
depends_on:
  - memory-foundation/128-memory-db-schema-and-init
  - memory-foundation/129-drawer-crud-spatial-coordinates
---

# Task 132 — Add Spatial Taxonomy Queries

Depends on Tasks 128 and 129. Blocks Tasks 133, 134, 135, 139.

## Scope

**In scope:**
- `listWings()`, `listRooms()`, `getMemoryStats()` functions in `lib/memoryStore.ts`

**Out of scope:**
- Modifying the drawers schema or CRUD operations
- MCP tool wrappers (Task 134)

---

## Context

### Current state

Tasks 128-129 provide the schema and CRUD for drawers with spatial coordinates (wing/hall/room), but there is no way to inspect the taxonomy — list which wings exist, which rooms are in a wing, or get aggregate stats.

### Desired state

Three query functions expose the spatial taxonomy for navigation, stats, and MCP/CLI consumers.

### Start here

- `lib/memoryStore.ts` — add taxonomy query functions

**Affected files:**
- `lib/memoryStore.ts` — add `listWings()`, `listRooms()`, `getMemoryStats()`

---

## Goals

1. Must provide `listWings()` returning distinct wings with drawer counts.
2. Must provide `listRooms(wing)` returning rooms within a wing with drawer counts.
3. Must provide `getMemoryStats()` returning total drawers, distinct wings, distinct rooms, oldest/newest memory, DB file size.
4. Must return empty results (not errors) on an empty database.

---

## Implementation

### Step 1 — Add taxonomy functions

**File:** `lib/memoryStore.ts`

```ts
export function listWings(stateDir: string): Array<{ wing: string; count: number }> {
  const db = getMemoryDb(stateDir);
  return db.prepare('SELECT wing, COUNT(*) as count FROM drawers GROUP BY wing ORDER BY count DESC').all() as any[];
}

export function listRooms(stateDir: string, wing: string): Array<{ room: string; hall: string; count: number }> {
  const db = getMemoryDb(stateDir);
  return db.prepare('SELECT room, hall, COUNT(*) as count FROM drawers WHERE wing = ? GROUP BY room, hall ORDER BY count DESC').all(wing) as any[];
}

export interface MemoryStats {
  totalDrawers: number;
  distinctWings: number;
  distinctRooms: number;
  oldestMemory: string | null;
  newestMemory: string | null;
  dbSizeBytes: number;
}

// Requires: import { statSync } from 'node:fs'; (add to memoryStore.ts imports)
export function getMemoryStats(stateDir: string): MemoryStats {
  const db = getMemoryDb(stateDir);
  const row = db.prepare(`
    SELECT COUNT(*) as total,
           COUNT(DISTINCT wing) as wings,
           COUNT(DISTINCT wing || '/' || room) as rooms,
           MIN(created_at) as oldest,
           MAX(created_at) as newest
    FROM drawers
  `).get() as any;
  const { size } = statSync(join(stateDir, 'memory.db'));
  return {
    totalDrawers: row.total, distinctWings: row.wings, distinctRooms: row.rooms,
    oldestMemory: row.oldest, newestMemory: row.newest, dbSizeBytes: size,
  };
}
```

---

## Acceptance criteria

- [ ] `listWings()` returns distinct wings with correct drawer counts
- [ ] `listWings()` returns empty array on empty DB
- [ ] `listRooms(wing)` returns rooms within the specified wing
- [ ] `listRooms(wing)` returns empty array for nonexistent wing
- [ ] `getMemoryStats()` returns correct aggregates including DB file size
- [ ] `getMemoryStats()` returns zeroes and nulls on empty DB
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('listWings returns distinct wings with counts', () => { ... });
it('listWings returns empty array on empty DB', () => { ... });
it('listRooms filters by wing', () => { ... });
it('getMemoryStats returns correct aggregates', () => { ... });
it('getMemoryStats returns zeroes on empty DB', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```
