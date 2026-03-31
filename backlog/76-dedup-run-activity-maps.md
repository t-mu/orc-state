---
ref: craftsmanship-foundations/76-dedup-run-activity-maps
feature: craftsmanship-foundations
priority: normal
status: done
---

# Task 76 — Deduplicate runActivity Map Building with Generic Helper

Independent.

## Scope

**In scope:**
- Extract shared iteration pattern from `latestRunActivityMap`, `latestRunActivityDetailMap`, `latestRunPhaseMap`
- Replace with a generic `buildRunMap()` helper

**Out of scope:**
- Changing the public API or return types of the three functions

---

## Context

### Current state

Three functions in `lib/runActivity.ts` (lines 33-89) follow the same pattern: iterate events, filter relevant ones, update a Map with latest values. The loop structure is nearly identical.

### Desired state

A private `buildRunMap<T>(events, filter, extract)` helper that the three public functions delegate to.

### Start here

- `lib/runActivity.ts` — the three functions

**Affected files:**
- `lib/runActivity.ts` — add helper, refactor public functions

---

## Goals

1. Must extract a generic `buildRunMap` helper
2. Must rewrite the three public functions as thin wrappers
3. Must not change public API or behavior

---

## Acceptance criteria

- [ ] No duplicated loop patterns in runActivity.ts
- [ ] All three public functions still return the same types
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run lib/runActivity.test.ts
```

```bash
npm test
```

---

## Tests

Pure refactoring — no new tests. Existing tests must continue to pass.
