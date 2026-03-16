---
ref: general/4-co-development-type-safety
feature: general
priority: high
status: todo
---

# Task 4 — Enforce Full Type Safety Gate for Co-Development

Independent.

## Scope

**In scope:**
- Resolve all TypeScript errors in test files (estimated 310 errors per HANDOFF.md, concentrated in `coordinator.test.ts`, `mcp/handlers.test.ts`, and e2e fixtures)
- Enforce `tsconfig.test.json` in the `pretest` npm script so test-file type errors block CI
- Verify `tsconfig.test.json` is correctly wired to vitest via `test.typecheck.tsconfig`

**Out of scope:**
- Changing any production source files beyond what is required to satisfy test types
- Adding npm workspaces or monorepo tooling
- Changing test logic or test coverage
- Refactoring test structure

---

## Context

All production `.ts` source files are type-clean under `tsconfig.check.json`. However, `tsconfig.check.json` excludes test files, so test-file type errors are silently ignored by the current `pretest` script. HANDOFF.md documents ~310 errors across three test files. Until these are fixed and the gate is enforced, the type safety guarantee is incomplete — a co-developer can introduce type errors in tests without any CI feedback.

### Current state
- `pretest`: runs `tsc --project tsconfig.check.json` (excludes `**/*.test.ts`) + `tsc --project tsconfig.test.json` (already added)
- `tsconfig.test.json` exists with `{ "extends": "./tsconfig.json", "compilerOptions": { "types": ["vitest/globals", "node"] }, "include": ["**/*.test.ts", "test-fixtures/**/*.ts"] }`
- 310 TypeScript errors in test files per HANDOFF.md (primarily `coordinator.test.ts`, `mcp/handlers.test.ts`)
- `vitest.config.mjs` already has `typecheck.tsconfig` wired

### Desired state
- `npm test` (including pretest) passes with zero TypeScript errors across all files including tests
- `tsconfig.test.json` is the enforced gate for test-file types
- A co-developer writing a test file gets accurate type feedback in their editor and in CI

### Start here
- `HANDOFF.md` — detailed list of remaining error locations and root causes
- `coordinator.test.ts` — largest error concentration
- `mcp/handlers.test.ts` — second error concentration
- `tsconfig.test.json` — current test type config

**Affected files:**
- `coordinator.test.ts` — fix type annotations
- `mcp/handlers.test.ts` — fix type annotations
- `test-fixtures/` — any fixture files with type errors
- `tsconfig.test.json` — confirm correct (likely no changes needed)
- `package.json` `pretest` — confirm `tsconfig.test.json` is included (already done)

---

## Goals

1. Must: `npx tsc --project tsconfig.test.json --noEmit` exits 0 with no output.
2. Must: `npm test` exits 0 end-to-end (pretest + tests).
3. Must: No test logic is altered — only type annotations, explicit casts, and missing variable declarations.
4. Must: No production source files are modified unless strictly required to export a type used in tests.
5. Must: Editor (VS Code) shows no red squiggles in test files when `tsconfig.test.json` is active.

---

## Implementation

### Step 1 — Read HANDOFF.md and categorize errors

**File:** `HANDOFF.md`

Read the full error list. Group errors by root cause:
- Missing `let` type annotations (TS7005/TS7034) — fix with explicit `: string`, `: number`, etc.
- `any` implicit (TS7006) — annotate callback parameters
- Property does not exist errors — add type assertions or narrow types
- Type mismatch in mock objects — align mock shape to actual interface

### Step 2 — Fix `coordinator.test.ts` errors

**File:** `coordinator.test.ts`

Primary root causes per HANDOFF.md:
- `let dir` in `beforeEach` needs `: string` annotation
- Cascading TS7005/TS7034 from untyped `let` declarations
- Work through each error block top-to-bottom; cascading errors often resolve from one fix

### Step 3 — Fix `mcp/handlers.test.ts` errors

**File:** `mcp/handlers.test.ts`

Apply same approach: explicit type annotations on `let` declarations, type-narrow mock objects to match `Task`, `Agent`, `Claim` interfaces from `types/`.

### Step 4 — Fix remaining test-fixture errors

**Files:** `test-fixtures/**/*.ts`

Any remaining errors in fixtures — apply minimal type annotations.

### Step 5 — Confirm `pretest` enforces test tsconfig

**File:** `package.json`

Confirm `pretest` includes:
```json
"pretest": "tsc --project tsconfig.check.json --noEmit && tsc --project tsconfig.test.json --noEmit && eslint ."
```
(Already present — verify, do not change if correct.)

---

## Acceptance criteria

- [ ] `npx tsc --project tsconfig.test.json --noEmit` exits 0 with no output.
- [ ] `npx tsc --project tsconfig.check.json --noEmit` still exits 0 (no regression).
- [ ] `npm test` exits 0 including the pretest phase.
- [ ] All 717 existing tests still pass (no test logic changed).
- [ ] No production source files modified (or if modified, only to export a type, not change logic).
- [ ] No changes to files outside the stated scope.

---

## Tests

No new tests. This task restores type correctness without changing test logic.

Verify by running:
```bash
npx tsc --project tsconfig.test.json --noEmit 2>&1 | wc -l
# Expected: 0
```

---

## Verification

```bash
# Targeted — test types only
npx tsc --project tsconfig.test.json --noEmit

# Confirm no production regressions
npx tsc --project tsconfig.check.json --noEmit

# Full suite (pretest + tests)
nvm use 24 && npm test
```
