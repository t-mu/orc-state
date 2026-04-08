---
ref: memory-foundation/129-drawer-crud-spatial-coordinates
feature: memory-foundation
priority: normal
status: done
depends_on:
  - memory-foundation/128-memory-db-schema-and-init
---

# Task 129 — Add Drawer CRUD with Spatial Coordinates

Depends on Task 128. Blocks Tasks 130, 131, 132, 137.

## Scope

**In scope:**
- `storeDrawer()`, `getDrawer()`, `deleteDrawer()`, `updateDrawerImportance()`, `listDrawers()` functions in `lib/memoryStore.ts`
- Spatial coordinate fields (wing, hall, room) with `general` default for wing

**Out of scope:**
- Duplicate detection and auto-tagging (Task 130)
- FTS5 search logic (Task 131)
- MCP tools or CLI commands

---

## Context

### Current state

Task 128 creates the `drawers` table schema and FTS5 index but provides no API to read or write drawer records.

### Desired state

A complete CRUD API for memory drawers with spatial coordinate filtering. Callers pass wing/hall/room explicitly — the CRUD layer does not infer wing from task_ref (that is the caller's responsibility).

### Start here

- `lib/memoryStore.ts` — the module created in Task 128

**Affected files:**
- `lib/memoryStore.ts` — add CRUD functions

---

## Goals

1. Must provide `storeDrawer()` that inserts a drawer and returns the new ID.
2. Must provide `getDrawer()`, `deleteDrawer()`, `updateDrawerImportance()` for single-record operations.
3. Must provide `listDrawers()` with optional wing/hall/room/limit/offset filtering.
4. Must default wing to `general` when not provided.
5. Must set `created_at` to ISO timestamp automatically.

---

## Implementation

### Step 1 — Add CRUD functions to memoryStore.ts

**File:** `lib/memoryStore.ts`

```ts
export interface DrawerInput {
  wing?: string;
  hall: string;
  room: string;
  content: string;
  importance?: number;
  sourceType?: string;
  sourceRef?: string;
  agentId?: string;
  tags?: string;
  expiresAt?: string;
}

export interface Drawer {
  id: number;
  wing: string;
  hall: string;
  room: string;
  content: string;
  content_hash: string | null;
  importance: number;
  source_type: string | null;
  source_ref: string | null;
  agent_id: string | null;
  tags: string | null;
  created_at: string;
  expires_at: string | null;
}

export function storeDrawer(stateDir: string, input: DrawerInput): number {
  const db = getMemoryDb(stateDir);
  const stmt = db.prepare(`
    INSERT INTO drawers (wing, hall, room, content, importance, source_type, source_ref, agent_id, tags, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.wing ?? 'general', input.hall, input.room, input.content,
    input.importance ?? 5, input.sourceType ?? null, input.sourceRef ?? null,
    input.agentId ?? null, input.tags ?? null, new Date().toISOString(),
    input.expiresAt ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getDrawer(stateDir: string, id: number): Drawer | null { ... }
export function deleteDrawer(stateDir: string, id: number): boolean { ... }
export function updateDrawerImportance(stateDir: string, id: number, importance: number): boolean { ... }
export function listDrawers(stateDir: string, opts: { wing?: string; hall?: string; room?: string; limit?: number; offset?: number }): Drawer[] { ... }
```

Invariant: do not modify the schema or init logic from Task 128.

---

## Acceptance criteria

- [ ] `storeDrawer()` inserts a record and returns the integer ID
- [ ] `storeDrawer()` defaults wing to `general` when omitted
- [ ] `storeDrawer()` sets `created_at` to a valid ISO timestamp
- [ ] `getDrawer()` returns the drawer or null for missing IDs
- [ ] `deleteDrawer()` removes the record and returns true; returns false for missing IDs
- [ ] `updateDrawerImportance()` updates the importance field
- [ ] `listDrawers()` filters by wing, hall, room when provided
- [ ] `listDrawers()` respects limit and offset parameters
- [ ] `listDrawers()` returns empty array on empty DB
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('storeDrawer inserts and returns an integer ID', () => { ... });
it('storeDrawer defaults wing to general', () => { ... });
it('getDrawer returns null for missing ID', () => { ... });
it('deleteDrawer removes the record', () => { ... });
it('listDrawers filters by wing', () => { ... });
it('listDrawers returns empty array on empty DB', () => { ... });
it('listDrawers respects limit and offset', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```
