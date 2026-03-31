---
ref: craftsmanship-structure/82-migrate-coordinator-tests-shared-utils
feature: craftsmanship-structure
priority: normal
status: done
depends_on:
  - craftsmanship-foundations/74-create-shared-test-utilities
---

# Task 82 — Migrate coordinator.test.ts to Shared Test Utilities

Depends on Task 74.

## Scope

**In scope:**
- Extract adapter mock factory and runWorktree mock factory as shared test helpers
- Replace 27+ duplicated adapter mock blocks and 10+ runWorktree mock blocks
- Replace 16+ seedState and 20+ readJson assertion patterns

**Out of scope:**
- Changing test logic or assertions
- Adding new tests

---

## Context

### Current state

`coordinator.test.ts` has massive boilerplate duplication: adapter mock setup (27+ copies), runWorktree mock (10+ copies), seedState patterns (16+), and readJson assertion patterns (20+).

### Desired state

Shared mock factories (`mockAdapter()`, `mockRunWorktree()`) and assertion helpers reduce each test to its unique setup and assertions only.

### Start here

- `coordinator.test.ts` — lines 102-110 (first adapter mock), lines 112-120 (first runWorktree mock)
- `test-fixtures/stateHelpers.ts` — extend with coordinator-specific helpers

**Affected files:**
- `test-fixtures/stateHelpers.ts` — add mock factory helpers
- `coordinator.test.ts` — replace all duplicated mocks with shared helpers

---

## Goals

1. Must extract `mockAdapter()` and `mockRunWorktree()` factories
2. Must replace all duplicated mock blocks in coordinator.test.ts
3. Must not change any test behavior or assertions

---

## Acceptance criteria

- [ ] No duplicated adapter mock blocks in coordinator.test.ts
- [ ] No duplicated runWorktree mock blocks
- [ ] All coordinator tests still pass
- [ ] `npm test` passes

---

## Verification

```bash
npx vitest run coordinator.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
