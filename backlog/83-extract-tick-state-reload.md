---
ref: craftsmanship-structure/83-extract-tick-state-reload
feature: craftsmanship-structure
priority: normal
status: todo
depends_on:
  - craftsmanship-foundations/68-consolidate-constants-enums
  - craftsmanship-foundations/69-consolidate-timing-constants
---

# Task 83 — Extract reloadTickState() Helper from tick()

Depends on Tasks 68, 69.

## Scope

**In scope:**
- Extract the repeated state reload pattern in `tick()` into a `reloadTickState()` helper
- Replace all 7 inline reload sites

**Out of scope:**
- Decomposing other parts of tick()
- Changing the reload-after-mutation pattern

---

## Context

### Current state

The `tick()` function in `coordinator.ts` (lines 1150-1365) reloads agents, claims, and backlog from disk 7 times throughout execution. Each reload is a 4-line block: `readJson(STATE_DIR, 'claims.json')`, `listCoordinatorAgents(...)`, then reassigning local variables.

### Desired state

A `reloadTickState(workerPoolConfig)` helper returns `{ agents, claims, backlog }`. Each reload site is a single function call.

### Start here

- `coordinator.ts` — `tick()` function, search for `readJson(STATE_DIR, 'claims.json')`

**Affected files:**
- `coordinator.ts` — add helper, replace inline reload blocks

---

## Goals

1. Must extract `reloadTickState()` helper
2. Must replace all 7 inline reload blocks
3. Must not change tick behavior or reload timing

---

## Acceptance criteria

- [ ] `reloadTickState()` function exists in coordinator.ts
- [ ] No inline state reload blocks remain in tick()
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
