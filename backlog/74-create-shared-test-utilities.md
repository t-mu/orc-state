---
ref: craftsmanship-foundations/74-create-shared-test-utilities
feature: craftsmanship-foundations
priority: normal
status: todo
---

# Task 74 — Create Shared Test Utilities in test-fixtures/

Independent.

## Scope

**In scope:**
- Create `test-fixtures/stateHelpers.ts` with common test setup/teardown helpers
- Migrate 3-5 representative test files as proof of concept

**Out of scope:**
- Migrating all 30+ test files (separate task)
- Coordinator test mock extraction (separate task)

---

## Context

### Current state

30+ test files each independently create temp directories with `mkdtempSync`, write empty state files (agents.json, backlog.json, claims.json), and clean up with `rmSync`. Each file has its own local `seedState` or equivalent helper.

### Desired state

Shared `test-fixtures/stateHelpers.ts` module with `createTempStateDir()`, `cleanupTempStateDir()`, `seedState()`, and `readStateFile()` helpers. A handful of test files migrated to demonstrate the pattern.

### Start here

- `lib/claimManager.test.ts` — has local `seed()` helper, representative pattern
- `lib/reconcile.test.ts` — another test with state setup

**Affected files:**
- `test-fixtures/stateHelpers.ts` — new file
- 3-5 test files in `lib/` — migrate to use shared helpers

---

## Goals

1. Must create `test-fixtures/stateHelpers.ts` with reusable test state helpers
2. Must migrate at least 3 existing test files to use the shared helpers
3. Must reduce boilerplate in migrated files
4. Must not change test behavior

---

## Acceptance criteria

- [ ] `test-fixtures/stateHelpers.ts` exists with exports: `createTempStateDir`, `cleanupTempStateDir`, `seedState`
- [ ] At least 3 test files import and use the shared helpers
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run lib/claimManager.test.ts lib/reconcile.test.ts
```

```bash
npm test
```

---

## Tests

New tests are part of the core deliverable for this task. See acceptance criteria.
