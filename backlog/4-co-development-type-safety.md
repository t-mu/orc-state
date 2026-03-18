---
ref: general/4-co-development-type-safety
feature: general
priority: high
status: todo
---

# Task 4 — Preserve Full Type Safety Gate for Co-Development

Independent.

## Scope

**In scope:**
- Verify the existing test-file type-safety gate remains active and accurately documented
- Remove stale assumptions in docs/specs about missing test type enforcement
- Add or adjust focused regression coverage only if a gap is discovered while verifying the gate

**Out of scope:**
- Changing any production source files beyond what is required to satisfy test types
- Adding npm workspaces or monorepo tooling
- Changing test logic or test coverage
- Refactoring test structure

---

## Context

The repository already enforces test-file typechecking separately from production-only typechecking. `tsconfig.check.json` excludes tests by design, while `tsconfig.test.json` covers `**/*.test.ts` and `test-fixtures/**/*.ts`, and `pretest` runs both configs before Vitest. This task exists to verify that arrangement stays intact and that no stale documentation or hidden gaps remain.

### Current state
- `pretest` already runs both `tsc --project tsconfig.check.json --noEmit` and `tsc --project tsconfig.test.json --noEmit` before `eslint .`
- `tsconfig.test.json` already exists and includes `**/*.test.ts` plus `test-fixtures/**/*.ts`
- `vitest.config.mjs` already points `test.typecheck.tsconfig` at `./tsconfig.test.json`
- The known stale reference is the task description itself: it still talks about `HANDOFF.md` and unresolved test-file errors that are no longer present

### Desired state
- `npm test` continues to pass with zero TypeScript errors across production and test files
- The backlog/spec documentation reflects that the gate is already implemented
- A co-developer writing or editing a test file continues to get accurate type feedback in the editor and in CI

### Start here
- `package.json` — confirm `pretest` still runs both typecheck configs
- `tsconfig.test.json` — current test type config
- `vitest.config.mjs` — current Vitest typecheck wiring
- Task/spec docs that still imply test-file typechecking is not enforced

**Affected files:**
- `package.json` — verify `pretest` remains correct
- `tsconfig.test.json` — verify current include set remains correct
- `vitest.config.mjs` — verify current typecheck wiring remains correct
- Backlog/docs files that still describe this gate as missing

---

## Goals

1. Must: `npx tsc --project tsconfig.test.json --noEmit` exits 0 with no output.
2. Must: `npx tsc --project tsconfig.check.json --noEmit` exits 0 with no output.
3. Must: `npm test` exits 0 end-to-end (pretest + tests).
4. Must: No changes alter runtime behavior; this task is verification/documentation unless a real gate regression is found.
5. Must: Any updated docs/specs describe the current gate accurately and do not reference nonexistent handoff files.

---

## Implementation

### Step 1 — Verify the existing gate end-to-end

**Files:** `package.json`, `tsconfig.test.json`, `vitest.config.mjs`

Confirm all three layers agree:
- `pretest` runs both typecheck configs before tests
- `tsconfig.test.json` includes test and fixture files
- Vitest `test.typecheck.tsconfig` points at `./tsconfig.test.json`

### Step 2 — Run the targeted verification commands

**Commands:**
- `npx tsc --project tsconfig.test.json --noEmit`
- `npx tsc --project tsconfig.check.json --noEmit`
- `nvm use 24 && npm test`

If any command fails, then and only then identify the actual failing files and fix that concrete regression.

### Step 3 — Remove stale task/spec guidance

**Files:** this task file and any nearby docs/specs that still describe the gate as missing

Delete references to:
- `HANDOFF.md`
- unresolved "310 errors"
- specific stale hotspot claims unless they are reproduced on current `main`

### Step 4 — Add regression coverage only if needed

If the verification work uncovers an actual enforcement gap, add the smallest possible test or config assertion to prevent that regression from silently returning.

---

## Acceptance criteria

- [ ] `npx tsc --project tsconfig.test.json --noEmit` exits 0 with no output.
- [ ] `npx tsc --project tsconfig.check.json --noEmit` still exits 0 (no regression).
- [ ] `npm test` exits 0 including the pretest phase.
- [ ] Updated task/docs text no longer references `HANDOFF.md` or unresolved bulk test-type errors unless reproduced on current `main`.
- [ ] No production runtime logic changes are made unless a real regression is discovered during verification.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new tests are required if the current gate is already intact. Add regression coverage only if the verification work exposes a real gap.

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
