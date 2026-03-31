---
ref: craftsmanship-structure/85-decompose-build-status
feature: craftsmanship-structure
priority: normal
status: todo
depends_on:
  - craftsmanship-foundations/72-extract-is-managed-slot
---

# Task 85 — Decompose buildStatus() into Sub-Functions

Depends on Task 72.

## Scope

**In scope:**
- Extract named sub-functions from `buildStatus()` in `lib/statusView.ts`
- Keep `buildStatus()` as the orchestrator calling sub-functions

**Out of scope:**
- Changing the StatusSnapshot type or output format
- Moving functions to separate files

---

## Context

### Current state

`buildStatus()` in `lib/statusView.ts` is a god function that reads multiple state files, computes agent classifications, task counts, per-claim metrics, failure collection, slot classification, and finalization state — all inline.

### Desired state

`buildStatus()` calls named helpers: `buildActiveClaimMetrics()`, `buildSlotSummary()`, etc. Each helper is testable independently.

### Start here

- `lib/statusView.ts` — `buildStatus()` function

**Affected files:**
- `lib/statusView.ts` — extract internal helpers, refactor buildStatus

---

## Goals

1. Must extract at least `buildActiveClaimMetrics()` and `buildSlotSummary()` as named functions
2. Must keep `buildStatus()` as the public entry point
3. Must not change the return type or output

---

## Acceptance criteria

- [ ] `buildStatus()` reads as a sequence of named function calls
- [ ] Extracted helpers are testable
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run lib/statusView.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
