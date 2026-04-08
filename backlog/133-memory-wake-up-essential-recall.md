---
ref: memory-access/133-memory-wake-up-essential-recall
feature: memory-access
priority: normal
status: todo
depends_on:
  - memory-foundation/128-memory-db-schema-and-init
  - memory-foundation/129-drawer-crud-spatial-coordinates
  - memory-foundation/131-fts5-search-spatial-filtering
  - memory-foundation/132-spatial-taxonomy-queries
---

# Task 133 — Add Memory Wake-Up Essential Recall

Depends on Tasks 128, 129, 131, and 132. Blocks Tasks 134, 135, 136.

## Scope

**In scope:**
- `memoryWakeUp()` function in `lib/memoryStore.ts` that returns a formatted text block of highest-importance memories
- Token budget enforcement via chars/4 heuristic
- Optional wing filtering for spatial-scoped wake-up
- Graceful degradation when DB is empty or not initialized

**Out of scope:**
- Identity file / identity preamble (deferred — YAGNI)
- MCP tool wrapper (Task 134)
- CLI command wrapper (Task 135)

---

## Context

### Current state

Tasks 128-132 provide the storage, CRUD, search, and taxonomy foundation. There is no function that produces a ready-to-inject context block of the most important memories for a worker starting a new session.

### Desired state

`memoryWakeUp()` queries the top-N drawers by importance (optionally filtered by wing), formats them as a structured text block with wing/room headers, and caps the output at a configurable token budget (~3200 chars = ~800 tokens at chars/4).

### Start here

- `lib/memoryStore.ts` — add `memoryWakeUp()` alongside existing functions

**Affected files:**
- `lib/memoryStore.ts` — add `memoryWakeUp()` function

---

## Goals

1. Must return a formatted text block of highest-importance memories.
2. Must support optional `wing` filter for spatial-scoped recall.
3. Must enforce a token budget (default ~3200 chars ≈ 800 tokens at chars/4 heuristic).
4. Must format output with wing/room headers suitable for context injection.
5. Must return empty string when no memories exist or DB not initialized.

---

## Implementation

### Step 1 — Add memoryWakeUp function

**File:** `lib/memoryStore.ts`

```ts
export function memoryWakeUp(stateDir: string, opts: {
  wing?: string;
  tokenBudget?: number;
} = {}): string {
  const charBudget = (opts.tokenBudget ?? 800) * 4;
  let db: Database;
  try { db = getMemoryDb(stateDir); } catch { return ''; }

  const conditions = opts.wing ? ['wing = ?'] : [];
  const params: unknown[] = opts.wing ? [opts.wing] : [];

  const sql = `SELECT wing, hall, room, content, importance FROM drawers
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY importance DESC, created_at DESC`;
  const rows = db.prepare(sql).all(...params) as Drawer[];

  let output = '';
  let charCount = 0;
  let currentWing = '';
  let currentRoom = '';

  for (const row of rows) {
    const header = (row.wing !== currentWing || row.room !== currentRoom)
      ? `\n## ${row.wing} / ${row.room}\n\n` : '';
    const entry = `- ${row.content}\n`;
    const addition = header + entry;
    if (charCount + addition.length > charBudget) break;
    output += addition;
    charCount += addition.length;
    currentWing = row.wing;
    currentRoom = row.room;
  }

  return output.trim();
}
```

---

## Acceptance criteria

- [ ] Returns formatted text with wing/room headers
- [ ] Respects token budget — output does not exceed `tokenBudget * 4` characters
- [ ] Filters by wing when provided
- [ ] Returns highest-importance memories first
- [ ] Returns empty string when no memories exist
- [ ] Returns empty string when memory.db does not exist (graceful degradation)
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('memoryWakeUp returns formatted text with wing/room headers', () => { ... });
it('memoryWakeUp respects token budget', () => { ... });
it('memoryWakeUp filters by wing', () => { ... });
it('memoryWakeUp returns empty string on empty DB', () => { ... });
it('memoryWakeUp returns highest-importance memories first', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```
