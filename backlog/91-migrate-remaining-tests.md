---
ref: craftsmanship-decomposition/91-migrate-remaining-tests
feature: craftsmanship-decomposition
priority: normal
status: todo
depends_on:
  - craftsmanship-foundations/74-create-shared-test-utilities
  - craftsmanship-structure/82-migrate-coordinator-tests-shared-utils
---

# Task 91 — Migrate Remaining Test Files to Shared Test Utilities

Depends on Tasks 74, 82.

## Scope

**In scope:**
- Migrate remaining test files (cli/, lib/, mcp/) to use `test-fixtures/stateHelpers.ts`
- Work in batches by directory

**Out of scope:**
- Changing test logic or assertions
- Adding new tests

---

## Context

### Current state

After Tasks 74 and 82, the pattern is established and coordinator tests are migrated. ~25 remaining test files still use inline temp dir creation and state file setup.

### Desired state

All test files use shared helpers from `test-fixtures/stateHelpers.ts`.

### Start here

- `test-fixtures/stateHelpers.ts` — existing shared helpers
- `lib/*.test.ts` — first batch to migrate

**Affected files:**
- All remaining `*.test.ts` files with inline `mkdtempSync` / state file setup

---

## Goals

1. Must migrate all remaining test files to shared helpers
2. Must not change any test behavior
3. Must maintain test isolation (each test gets its own temp dir)

---

## Acceptance criteria

- [ ] No inline `mkdtempSync` in test files (all use shared helper)
- [ ] `npm test` passes
- [ ] No changes to non-test files

---

## Verification

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
