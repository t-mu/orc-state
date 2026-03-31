---
ref: craftsmanship-decomposition/89-extract-nudge-pattern
feature: craftsmanship-decomposition
priority: normal
status: todo
depends_on:
  - craftsmanship-decomposition/88-extract-tick-dispatch-block
---

# Task 89 — Extract Nudge Work Pattern into Reusable Helper

Depends on Task 88.

## Scope

**In scope:**
- Extract the duplicated nudge work pattern from 3 coordinator functions into a shared helper
- Deduplicate result aggregation logic

**Out of scope:**
- Changing nudge semantics or concurrency limits

---

## Context

### Current state

The pattern of building nudge thunks, running them with bounded concurrency, and aggregating results appears in `processClaimedSessionReadiness`, `enforceRunStartLifecycle`, and `enforceInProgressLifecycle` with nearly identical code.

### Desired state

A shared `executeNudgeBatch(nudgeThunks)` helper that runs bounded concurrency, logs failures, and returns the set of nudged agent IDs.

### Start here

- `coordinator.ts` — search for `nudgeWork` variable usage

**Affected files:**
- `coordinator.ts` — add helper, refactor 3 functions

---

## Goals

1. Must extract `executeNudgeBatch()` helper
2. Must refactor all 3 nudge sites to use the helper
3. Must not change nudge behavior

---

## Acceptance criteria

- [ ] Single `executeNudgeBatch` helper exists
- [ ] No duplicated nudge result aggregation
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
