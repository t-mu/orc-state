---
ref: memory-quality/138-memory-health-orc-doctor
feature: memory-quality
priority: normal
status: done
depends_on:
  - memory-foundation/128-memory-db-schema-and-init
---

# Task 138 — Add Memory Health Checks to orc doctor

Depends on Task 128.

## Scope

**In scope:**
- Memory.db health checks in `cli/doctor.ts` and `lib/stateValidation.ts`
- Checks: DB opens, schema tables present, FTS5 integrity, WAL size
- Graceful handling when memory.db doesn't exist (info, not error)

**Out of scope:**
- Memory CRUD, search, or ingestion logic
- Memory CLI commands (Task 135)

---

## Context

### Current state

`orc doctor` validates events.db, state JSON files, and provider binaries. It has no
awareness of memory.db.

### Desired state

`orc doctor` includes memory.db health checks: schema validation, FTS5 integrity check,
and WAL file size. When memory.db doesn't exist, it reports "memory system not initialized"
as an informational note (not an error).

### Start here

- `cli/doctor.ts` — existing health check dispatch
- `lib/stateValidation.ts` — validation functions

**Affected files:**
- `cli/doctor.ts` — add memory health check section
- `lib/stateValidation.ts` — add `validateMemoryDb()` function

---

## Goals

1. Must check that memory.db opens and has the expected tables (drawers, drawers_fts).
2. Must run FTS5 integrity check (`INSERT INTO drawers_fts(drawers_fts) VALUES('integrity-check')`).
3. Must warn if WAL file exceeds 50MB.
4. Must report "memory system not initialized" as info when memory.db doesn't exist.
5. Must not fail `orc doctor` when memory.db is absent.

---

## Implementation

### Step 1 — Add validateMemoryDb to stateValidation.ts

**File:** `lib/stateValidation.ts`

```ts
export function validateMemoryDb(stateDir: string): { ok: boolean; messages: string[] } {
  const dbPath = join(stateDir, 'memory.db');
  if (!existsSync(dbPath)) {
    return { ok: true, messages: ['info: memory system not initialized (memory.db not found)'] };
  }
  // Open, check tables, run FTS5 integrity, check WAL size
  ...
}
```

### Step 2 — Wire into doctor.ts

**File:** `cli/doctor.ts`

Add a "Memory" section that calls `validateMemoryDb()` and prints results.

---

## Acceptance criteria

- [ ] `orc doctor` reports memory.db health when DB exists
- [ ] `orc doctor` reports "not initialized" info when memory.db absent
- [ ] FTS5 integrity check catches corrupted index
- [ ] WAL size warning triggers above 50MB threshold
- [ ] `orc doctor` exits 0 when memory.db is absent (info only)
- [ ] No changes to files outside the stated scope

---

## Tests

Add to `cli/doctor.test.ts`:

```ts
it('reports memory not initialized when memory.db missing', () => { ... });
it('validates memory.db schema when present', () => { ... });
it('detects FTS5 integrity issues', () => { ... });
```

---

## Verification

```bash
npx vitest run cli/doctor.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: exits 0, memory section shows info or health status
```
