---
ref: craftsmanship-foundations/79-remove-persistent-dispatch-state
feature: craftsmanship-foundations
priority: low
status: todo
---

# Task 79 — Remove Persistent Round-Robin Dispatch State (YAGNI)

Independent.

## Scope

**In scope:**
- Replace file-persisted round-robin state in `lib/dispatchPlanner.ts` with in-memory state
- Remove `dispatch-state.json` file I/O

**Out of scope:**
- Changing the round-robin dispatch algorithm itself
- Removing the dispatch planner

---

## Context

### Current state

`lib/dispatchPlanner.ts` persists `last_assigned_agent_id` to `dispatch-state.json` on disk. With a small agent pool and tick-based dispatch, this persistence is unnecessary — process restarts can start fresh.

### Desired state

Module-level variable holds the round-robin state. No file I/O for dispatch state.

### Start here

- `lib/dispatchPlanner.ts` — lines 9-38

**Affected files:**
- `lib/dispatchPlanner.ts` — replace file I/O with module variable

---

## Goals

1. Must replace `readDispatchState`/`writeDispatchState` with a module-level variable
2. Must keep the round-robin selection logic unchanged
3. Must remove `dispatch-state.json` references

---

## Acceptance criteria

- [ ] No `dispatch-state.json` reads or writes in the codebase
- [ ] Round-robin dispatch still works correctly
- [ ] `npm test` passes

---

## Verification

```bash
npx vitest run lib/dispatchPlanner.test.ts
```

```bash
npm test
```
