---
ref: craftsmanship-polish/92-flatten-finalization-conditionals
feature: craftsmanship-polish
priority: normal
status: done
depends_on:
  - craftsmanship-decomposition/88-extract-tick-dispatch-block
  - craftsmanship-decomposition/89-extract-nudge-pattern
---

# Task 92 — Flatten Deeply Nested Finalization Conditionals

Depends on Tasks 88, 89.

## Scope

**In scope:**
- Flatten nested if-chains in finalization state handling in coordinator.ts
- Flatten nested state checks in `lib/workerLifecycleReducer.ts`
- Use guard clause / early-return pattern

**Out of scope:**
- Changing finalization state machine logic
- Adding new finalization states

---

## Context

### Current state

`enforceInProgressLifecycle` in coordinator.ts (lines 949-997) has deeply nested if statements checking finalization state with multiple levels of nesting. `reduceLifecycleEvent` in the lifecycle reducer similarly nests finalization state checks.

### Desired state

Guard clause pattern flattens the conditionals. Consider extracting a `handleFinalizationProgress(claim, idleMs, ...)` helper.

### Start here

- `coordinator.ts` — `enforceInProgressLifecycle` function
- `lib/workerLifecycleReducer.ts` — `reduceLifecycleEvent` function

**Affected files:**
- `coordinator.ts` — flatten conditionals, possibly extract helper
- `lib/workerLifecycleReducer.ts` — flatten conditionals

---

## Goals

1. Must reduce nesting depth by at least 2 levels in affected functions
2. Must use guard clause pattern (early returns/continues)
3. Must not change any finalization behavior

---

## Acceptance criteria

- [ ] No conditionals nested deeper than 3 levels in affected functions
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run coordinator.test.ts lib/workerLifecycleReducer.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
