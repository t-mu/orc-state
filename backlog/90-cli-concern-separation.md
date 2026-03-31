---
ref: craftsmanship-decomposition/90-cli-concern-separation
feature: craftsmanship-decomposition
priority: normal
status: done
depends_on:
  - craftsmanship-foundations/70-extract-cli-shared-utils
  - craftsmanship-foundations/73-extract-claim-reset-helpers
  - craftsmanship-structure/86-standardize-argv-parsing
---

# Task 90 — Separate CLI Handler Concerns (Business Logic to lib/)

Depends on Tasks 70, 73, 86.

## Scope

**In scope:**
- Extract business logic from run lifecycle CLI handlers into testable `lib/runCommands.ts`
- CLI files become thin shells: parse args → call function → format output → exit

**Out of scope:**
- Non-run CLI commands (task-create, delegate, etc.)
- Adding new CLI capabilities

---

## Context

### Current state

CLI handlers in `cli/run-start.ts`, `cli/run-fail.ts`, `cli/run-finish.ts`, `cli/run-work-complete.ts`, `cli/run-input-request.ts` each mix argument parsing, validation, business logic (claim updates, event emission), file I/O, and lock management.

### Desired state

Business logic extracted into `lib/runCommands.ts` functions like `executeRunStart(runId, agentId)`, enabling unit testing without spawning processes.

### Start here

- `cli/run-start.ts` — representative handler to extract first
- `cli/run-fail.ts` — another handler

**Affected files:**
- `lib/runCommands.ts` — new file with business logic
- `cli/run-start.ts`, `cli/run-fail.ts`, `cli/run-finish.ts`, `cli/run-work-complete.ts`, `cli/run-input-request.ts` — thin wrappers

---

## Goals

1. Must extract core business logic into `lib/runCommands.ts`
2. Must make CLI handlers into thin arg-parsing shells
3. Must not change any CLI behavior or exit codes

---

## Acceptance criteria

- [ ] `lib/runCommands.ts` exists with exported functions for each run command
- [ ] CLI handlers are < 30 lines each (parse + call + exit)
- [ ] `npm test` passes

---

## Verification

```bash
npx vitest run cli/ lib/runCommands.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
