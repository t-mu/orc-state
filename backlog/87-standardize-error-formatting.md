---
ref: craftsmanship-structure/87-standardize-error-formatting
feature: craftsmanship-structure
priority: low
status: todo
depends_on:
  - craftsmanship-foundations/70-extract-cli-shared-utils
---

# Task 87 — Standardize Error Message Formatting Across CLI

Depends on Task 70.

## Scope

**In scope:**
- Add `formatErrorMessage(error: unknown): string` to `cli/shared.ts`
- Audit and standardize error formatting in CLI catch blocks

**Out of scope:**
- Coordinator or lib/ error formatting
- Adding structured error types

---

## Context

### Current state

CLI files format errors inconsistently: some use `Error:` prefix, some don't. Some include stack traces, some minimal context. `Usage:` messages mix `orc-command` and `node cli/command.ts` styles.

### Desired state

Consistent error formatting via shared `formatErrorMessage()` utility across all CLI handlers.

### Start here

- `cli/shared.ts` — add the utility (created in Task 70)

**Affected files:**
- `cli/shared.ts` — add `formatErrorMessage`
- CLI files with inconsistent error formatting

---

## Goals

1. Must add `formatErrorMessage(error: unknown): string` to `cli/shared.ts`
2. Must standardize error output across CLI files
3. Must not change exit codes or error semantics

---

## Acceptance criteria

- [ ] `formatErrorMessage` exported from `cli/shared.ts`
- [ ] Consistent error output format across CLI files
- [ ] `npm test` passes

---

## Verification

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
