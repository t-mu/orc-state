---
ref: memory-foundation/131-fts5-search-spatial-filtering
feature: memory-foundation
priority: normal
status: done
depends_on:
  - memory-foundation/128-memory-db-schema-and-init
  - memory-foundation/129-drawer-crud-spatial-coordinates
---

# Task 131 — Add FTS5 Search with Spatial Filtering

Depends on Tasks 128 and 129. Blocks Tasks 133, 134, 135.

## Scope

**In scope:**
- `searchMemory()` function in `lib/memoryStore.ts` with FTS5 MATCH, spatial pre-filtering, and importance-weighted ranking
- Snippet generation (first 200 chars of matching content)

**Out of scope:**
- Duplicate detection or tagging (Task 130)
- MCP tool wrappers (Task 134)
- CLI wrappers (Task 135)

---

## Context

### Current state

Task 128 creates the `drawers_fts` FTS5 virtual table. Task 129 provides CRUD to insert and list drawers. There is no search function that combines FTS5 text matching with spatial pre-filtering and importance weighting.

### Desired state

A `searchMemory()` function that performs FTS5 MATCH queries with optional wing/hall/room WHERE clauses, ranks results by `bm25 * (importance / 10)`, and returns structured results with content snippets.

### Start here

- `lib/memoryStore.ts` — add search function alongside existing CRUD
- `lib/eventLog.ts` — reference for `queryEvents()` FTS5 usage pattern

**Affected files:**
- `lib/memoryStore.ts` — add `searchMemory()` function

---

## Goals

1. Must perform FTS5 MATCH queries against `drawers_fts`.
2. Must support optional wing, hall, room pre-filters as WHERE clauses.
3. Must rank results by `bm25(drawers_fts) * (importance / 10.0)`.
4. Must return id, content snippet (first 200 chars), wing, hall, room, importance, created_at, rank score.
5. Must support a `limit` parameter (default 10).

---

## Implementation

### Step 1 — Add searchMemory function

**File:** `lib/memoryStore.ts`

```ts
export interface MemorySearchResult {
  id: number;
  snippet: string;
  wing: string;
  hall: string;
  room: string;
  importance: number;
  created_at: string;
  rank: number;
}

export function searchMemory(stateDir: string, opts: {
  query: string;
  wing?: string;
  hall?: string;
  room?: string;
  limit?: number;
}): MemorySearchResult[] {
  const db = getMemoryDb(stateDir);
  const conditions = ['drawers_fts MATCH ?'];
  const params: unknown[] = [opts.query];

  if (opts.wing) { conditions.push('d.wing = ?'); params.push(opts.wing); }
  if (opts.hall) { conditions.push('d.hall = ?'); params.push(opts.hall); }
  if (opts.room) { conditions.push('d.room = ?'); params.push(opts.room); }

  const sql = `
    SELECT d.id, d.content, d.wing, d.hall, d.room, d.importance, d.created_at,
           (bm25(drawers_fts) * (d.importance / 10.0)) AS rank
    FROM drawers d
    JOIN drawers_fts ON drawers_fts.rowid = d.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank
    LIMIT ?
  `;
  params.push(opts.limit ?? 10);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    id: r.id as number,
    snippet: (r.content as string).slice(0, 200),
    wing: r.wing as string,
    hall: r.hall as string,
    room: r.room as string,
    importance: r.importance as number,
    created_at: r.created_at as string,
    rank: r.rank as number,
  }));
}
```

Note: `bm25()` returns negative values (lower = better match). Multiplying by
`(importance / 10.0)` makes high-importance results more negative (lower rank value =
better), so `ORDER BY rank ASC` is correct. Example: bm25=-2.0 with importance=8 →
rank=-1.6; bm25=-2.0 with importance=3 → rank=-0.6. The importance=8 drawer ranks first.

---

## Acceptance criteria

- [ ] `searchMemory()` returns matching drawers ranked by relevance × importance
- [ ] Spatial pre-filters (wing, hall, room) restrict the search subset
- [ ] Snippets are capped at 200 characters
- [ ] Default limit is 10 results
- [ ] Returns empty array for queries with no matches
- [ ] Returns empty array when the database has no drawers
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `lib/memoryStore.test.ts`:

```ts
it('searchMemory finds drawers by FTS5 text match', () => { ... });
it('searchMemory filters by wing when provided', () => { ... });
it('searchMemory returns empty array for no matches', () => { ... });
it('searchMemory ranks higher-importance drawers above lower', () => { ... });
it('searchMemory respects limit parameter', () => { ... });
it('searchMemory returns snippets capped at 200 chars', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/memoryStore.test.ts
```

```bash
nvm use 24 && npm test
```
