---
ref: craftsmanship-foundations/72-extract-is-managed-slot
feature: craftsmanship-foundations
priority: normal
status: todo
---

# Task 72 — Extract isManagedSlot() into lib/workerSlots.ts

Independent.

## Scope

**In scope:**
- Create `lib/workerSlots.ts` with shared `isManagedSlot()` function
- Replace local definitions in `coordinator.ts` and `lib/statusView.ts`

**Out of scope:**
- Refactoring the slot classification logic
- Changing managed slot semantics

---

## Context

### Current state

`isManagedSlot()` is defined locally in both `coordinator.ts` (line ~189) and `lib/statusView.ts` (line ~14) with nearly identical logic.

### Desired state

Single shared function in `lib/workerSlots.ts` imported by both files.

### Start here

- `coordinator.ts` — search for `isManagedSlot`
- `lib/statusView.ts` — search for `isManagedSlot`

**Affected files:**
- `lib/workerSlots.ts` — new file
- `coordinator.ts` — replace local definition with import
- `lib/statusView.ts` — replace local definition with import

---

## Goals

1. Must create `lib/workerSlots.ts` with `isManagedSlot()` export
2. Must handle both call signatures (WorkerPoolConfig and raw number)
3. Must remove both local definitions
4. Must not change any behavior

---

## Acceptance criteria

- [ ] `lib/workerSlots.ts` exists with `isManagedSlot` export
- [ ] No local `isManagedSlot` in coordinator.ts or statusView.ts
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run coordinator.test.ts lib/statusView.test.ts
```

```bash
npm test
```
