---
ref: craftsmanship-foundations/70-extract-cli-shared-utils
feature: craftsmanship-foundations
priority: normal
status: todo
---

# Task 70 — Extract loadClaim() and CLI Error Handler into cli/shared.ts

Independent.

## Scope

**In scope:**
- Create `cli/shared.ts` with shared `loadClaim()` and `cliErrorExit()` functions
- Replace all 7 duplicated `loadClaim()` implementations
- Replace all 8 duplicated error handling catch blocks

**Out of scope:**
- Argv parsing standardization (separate task)
- Business logic extraction from CLI handlers (separate task)

---

## Context

### Current state

`loadClaim()` is copy-pasted identically in 7 CLI files: `run-start.ts`, `run-heartbeat.ts`, `run-fail.ts`, `run-finish.ts`, `run-work-complete.ts`, `run-input-request.ts`, `progress.ts`. The error handling pattern `catch (error) { const message = error instanceof Error ? error.message : String(error); console.error(...); process.exit(1); }` is repeated in 8 CLI files.

### Desired state

Both patterns extracted into `cli/shared.ts`. Each CLI file imports and uses the shared versions.

### Start here

- `cli/run-start.ts` — representative file with both patterns
- `cli/progress.ts` — another file with `loadClaim`

**Affected files:**
- `cli/shared.ts` — new file
- `cli/run-start.ts`, `cli/run-heartbeat.ts`, `cli/run-fail.ts`, `cli/run-finish.ts`, `cli/run-work-complete.ts`, `cli/run-input-request.ts`, `cli/progress.ts` — remove local `loadClaim`
- `cli/report-for-duty.ts`, `cli/review-submit.ts` — remove duplicated error handling

---

## Goals

1. Must create `cli/shared.ts` exporting `loadClaim(runId: string): Claim | null` and `cliErrorExit(error: unknown): never`
2. Must remove all local `loadClaim` definitions from CLI files
3. Must replace duplicated error handling patterns with `cliErrorExit`
4. Must not change any CLI behavior

---

## Acceptance criteria

- [ ] `cli/shared.ts` exists with both exports
- [ ] No local `loadClaim` function in any CLI file
- [ ] Grep for `process.exit(1)` in CLI run-* files returns only the shared module
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run cli/
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
