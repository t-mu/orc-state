---
ref: memory-quality/140-integration-tests-documentation
feature: memory-quality
priority: normal
status: todo
depends_on:
  - memory-foundation/128-memory-db-schema-and-init
  - memory-foundation/129-drawer-crud-spatial-coordinates
  - memory-foundation/130-duplicate-detection-keyword-tags
  - memory-foundation/131-fts5-search-spatial-filtering
  - memory-foundation/132-spatial-taxonomy-queries
  - memory-access/133-memory-wake-up-essential-recall
  - memory-access/134-mcp-tools-memory-access
  - memory-access/135-cli-commands-memory
  - memory-access/136-bootstrap-wake-up-integration
  - memory-access/137-event-driven-memory-ingestion
  - memory-quality/138-memory-health-orc-doctor
  - memory-quality/139-memory-expiry-and-pruning
---

# Task 140 — Add Integration Tests and Memory System Documentation

Depends on Tasks 128–139.

## Scope

**In scope:**
- End-to-end integration tests for the complete memory lifecycle
- `docs/memory.md` documenting architecture, CLI usage, MCP tools, spatial organization
- Verify all memory components work together

**Out of scope:**
- Unit tests for individual functions (covered in their respective tasks)
- Changes to memory implementation code

---

## Context

### Current state

Tasks 128-139 implement the memory system in layers: schema, CRUD, search, wake-up, MCP,
CLI, bootstrap, ingestion, doctor, pruning. Each task includes its own unit tests. There is
no integration test that verifies the full lifecycle and no user-facing documentation.

### Desired state

A dedicated integration test file exercises the complete memory pipeline: store → search →
wake-up → prune. A `docs/memory.md` file documents how the memory system works, how to use
the CLI and MCP tools, and how spatial organization maps to the feature/task hierarchy.

### Start here

- `lib/memoryStore.ts` — all memory functions
- `mcp/handlers.ts` — MCP tool handlers
- `docs/` — documentation directory

**Affected files:**
- `lib/memoryStore.integration.test.ts` — new: end-to-end tests
- `docs/memory.md` — new: memory system documentation

---

## Goals

1. Must test the full store → search → retrieve round-trip with spatial filtering.
2. Must test duplicate detection prevents re-insertion across the pipeline.
3. Must test FTS5 ranking respects importance weighting.
4. Must test wake-up with empty DB returns gracefully.
5. Must test event-driven ingestion creates memories from mock events.
6. Must test pruning removes expired and over-capacity drawers.
7. Must create `docs/memory.md` with architecture, CLI reference, MCP tool reference, and spatial organization guide.

---

## Implementation

### Step 1 — Create integration test file

**File:** `lib/memoryStore.integration.test.ts`

```ts
describe('memory system integration', () => {
  it('store → search round-trip with spatial filtering', () => {
    // Store drawers in different wings/rooms, search with filters, verify results
  });

  it('duplicate detection across full pipeline', () => {
    // Store same content twice, verify single drawer, search finds one result
  });

  it('importance-weighted FTS5 ranking', () => {
    // Store two drawers with same content but different importance, verify ordering
  });

  it('wake-up returns empty string on fresh DB', () => {
    // Init DB, call memoryWakeUp, verify empty string
  });

  it('wake-up returns highest-importance memories within budget', () => {
    // Store 20 drawers, call wake-up with small budget, verify truncation
  });

  it('event-driven ingestion creates searchable memories', () => {
    // Call wingFromTaskRef, storeDrawer with event params, search for result
  });

  it('pruning removes expired and over-capacity drawers', () => {
    // Store drawers with expires_at in the past, prune, verify deletion
    // Store 250 drawers in one room, prune with max=200, verify 200 remain
  });

  it('full lifecycle: ingest → search → wake-up → prune', () => {
    // End-to-end: store via event pattern, search, wake-up, expire, prune
  });
});
```

### Step 2 — Create docs/memory.md

**File:** `docs/memory.md`

Sections:
1. **Overview** — what the memory system does, why it exists
2. **Architecture** — memory.db schema, FTS5, spatial organization (wing/hall/room)
3. **Spatial Organization** — how wing maps to feature, hall to category, room to topic
4. **CLI Reference** — `orc memory-status`, `orc memory-search`, `orc memory-wake-up`, `orc memory-record`
5. **MCP Tools** — `memory_wake_up`, `memory_recall`, `memory_search`, `memory_store`, `memory_status`
6. **Worker Integration** — bootstrap wake-up, memory-record during implementation
7. **Automatic Ingestion** — what events create memories automatically
8. **Maintenance** — pruning, expiry, doctor checks

---

## Acceptance criteria

- [ ] Integration tests pass: store → search round-trip
- [ ] Integration tests pass: duplicate detection
- [ ] Integration tests pass: importance-weighted ranking
- [ ] Integration tests pass: wake-up with empty DB
- [ ] Integration tests pass: pruning removes expired drawers
- [ ] `docs/memory.md` exists with all 8 sections
- [ ] Documentation accurately describes the implemented CLI commands and MCP tools
- [ ] No changes to files outside the stated scope

---

## Tests

All tests for this task are defined in Step 1 above. Test file path: `lib/memoryStore.integration.test.ts`.

---

## Verification

```bash
npx vitest run lib/memoryStore.integration.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: memory section reports healthy
```
