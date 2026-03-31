---
ref: craftsmanship-decomposition/88-extract-tick-dispatch-block
feature: craftsmanship-decomposition
priority: normal
status: done
depends_on:
  - craftsmanship-structure/83-extract-tick-state-reload
---

# Task 88 — Extract Dispatch Block from tick() into Named Function

Depends on Task 83.

## Scope

**In scope:**
- Extract the dispatch planning and execution block from `tick()` into `executeDispatchPlan()`
- Reduce tick() to a sequence of named function calls

**Out of scope:**
- Changing dispatch logic
- Further decomposing individual lifecycle enforcement functions

---

## Context

### Current state

After Step 83 extracts the reload helper, `tick()` still has a large inline dispatch block (lines ~1261-1365) that handles building dispatch plans, iterating over plan items, and executing dispatches.

### Desired state

`tick()` reads as a clean sequence: reload → reconcile → enforce lifecycles → plan & dispatch. The dispatch block is a named function.

### Start here

- `coordinator.ts` — `tick()` function, the dispatch section

**Affected files:**
- `coordinator.ts` — extract `executeDispatchPlan()`, update tick()

---

## Goals

1. Must extract the dispatch block into `executeDispatchPlan()`
2. Must keep `tick()` as the orchestrator
3. Must not change dispatch behavior

---

## Acceptance criteria

- [ ] `tick()` reads as a sequence of ~10 named function calls
- [ ] `executeDispatchPlan()` encapsulates all dispatch logic
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
