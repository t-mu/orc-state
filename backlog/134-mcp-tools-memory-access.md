---
ref: memory-access/134-mcp-tools-memory-access
feature: memory-access
priority: normal
status: todo
depends_on:
  - memory-foundation/131-fts5-search-spatial-filtering
  - memory-foundation/132-spatial-taxonomy-queries
  - memory-access/133-memory-wake-up-essential-recall
---

# Task 134 — Add MCP Tools for Memory Access

Depends on Tasks 131, 132, and 133. Blocks Task 136.

## Scope

**In scope:**
- 5 new MCP tools: `memory_wake_up`, `memory_recall`, `memory_search`, `memory_store`, `memory_status`
- AJV schemas in `mcp/tools-list.ts`
- Handler implementations in `mcp/handlers.ts`
- Dispatch wiring in `mcp/server.ts`

**Out of scope:**
- Knowledge graph MCP tools (deferred)
- CLI commands (Task 135)
- Bootstrap integration (Task 136)

---

## Context

### Current state

The MCP server exposes orchestrator tools (list_tasks, get_task, delegate_task, etc.) via
`mcp/tools-list.ts` + `mcp/handlers.ts` + `mcp/server.ts`. All tools follow a consistent
pattern: schema in tools-list, handler function in handlers.ts, dispatch in server.ts.
There are no memory-related tools.

### Desired state

Five memory MCP tools are registered following the existing naming convention (`memory_` prefix)
and dispatch pattern. The master agent and workers can query and store memories via MCP.

### Start here

- `mcp/tools-list.ts` — tool schema definitions
- `mcp/handlers.ts` — handler implementations
- `mcp/server.ts` — `invokeTool()` dispatch

**Affected files:**
- `mcp/tools-list.ts` — add 5 tool schemas
- `mcp/handlers.ts` — add 5 handler functions
- `mcp/server.ts` — add dispatch cases for memory tools

---

## Goals

1. Must register `memory_wake_up`, `memory_recall`, `memory_search`, `memory_store`, `memory_status` in the MCP tool list.
2. Must validate inputs via AJV schemas consistent with existing tools.
3. Must implement handlers that delegate to `lib/memoryStore.ts` functions.
4. Must follow existing naming convention (snake_case, descriptive tool names).
5. Must handle missing memory.db gracefully (return empty results, not errors).

---

## Implementation

### Step 1 — Add tool schemas to tools-list.ts

**File:** `mcp/tools-list.ts`

Add 5 entries to the TOOLS array:

- `memory_wake_up`: optional `wing` (string), optional `tokenBudget` (number)
- `memory_recall`: required `wing` (string), optional `room` (string), optional `limit` (number)
- `memory_search`: required `query` (string), optional `wing`/`room`/`limit`
- `memory_store`: required `content` (string), optional `wing`/`hall`/`room`/`importance`/`sourceType`/`sourceRef`
- `memory_status`: no parameters

### Step 2 — Implement handlers in handlers.ts

**File:** `mcp/handlers.ts`

```ts
export function handleMemoryWakeUp(stateDir: string, args: Record<string, unknown>) { ... }
export function handleMemoryRecall(stateDir: string, args: Record<string, unknown>) { ... }
export function handleMemorySearch(stateDir: string, args: Record<string, unknown>) { ... }
export function handleMemoryStore(stateDir: string, args: Record<string, unknown>) { ... }
export function handleMemoryStatus(stateDir: string, _args: Record<string, unknown>) { ... }
```

Handler → function mapping:
- `handleMemoryWakeUp` → `memoryWakeUp()` (Task 133)
- `handleMemoryRecall` → `listDrawers()` with wing/room/limit filters (Task 129)
- `handleMemorySearch` → `searchMemory()` (Task 131)
- `handleMemoryStore` → `storeDrawer()` (Task 129)
- `handleMemoryStatus` → `getMemoryStats()` (Task 132)

Each handler wraps its function with try/catch that returns `{ error: "memory system not initialized" }` when memory.db doesn't exist.

### Step 3 — Wire dispatch in server.ts

**File:** `mcp/server.ts`

Add cases to `invokeTool()` for each memory tool name.

---

## Acceptance criteria

- [ ] All 5 tools appear in MCP tool listing
- [ ] `memory_wake_up` returns formatted wake-up text
- [ ] `memory_recall` returns spatially-filtered drawers
- [ ] `memory_search` returns FTS5 search results
- [ ] `memory_store` creates a drawer and returns the ID
- [ ] `memory_status` returns stats object
- [ ] All tools return graceful error when memory.db not initialized
- [ ] AJV validation rejects invalid inputs
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `mcp/handlers.test.ts`:

```ts
it('handleMemoryStore creates a drawer and returns ID', () => { ... });
it('handleMemorySearch returns FTS5 results', () => { ... });
it('handleMemoryRecall returns spatially-filtered drawers', () => { ... });
it('handleMemoryWakeUp returns formatted text', () => { ... });
it('handleMemoryStatus returns stats', () => { ... });
it('memory tools return graceful error when DB not initialized', () => { ... });
```

---

## Verification

```bash
npx vitest run mcp/handlers.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
orc status
```
