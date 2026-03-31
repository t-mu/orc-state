---
ref: craftsmanship-structure/84-split-claim-manager
feature: craftsmanship-structure
priority: normal
status: todo
depends_on:
  - craftsmanship-foundations/73-extract-claim-reset-helpers
---

# Task 84 — Split claimManager into Lease and State Sub-Modules

Depends on Task 73.

## Scope

**In scope:**
- Extract lease management into `lib/claimLeaseManager.ts`
- Extract state transition helpers into `lib/claimStateManager.ts`
- Re-export from `lib/claimManager.ts` for backward compatibility

**Out of scope:**
- Changing any claim lifecycle behavior
- Updating callers beyond import changes

---

## Context

### Current state

`lib/claimManager.ts` handles claim CRUD, task status, event emission, lease expiration, finalization state, input state, and session retry state — too many responsibilities.

### Desired state

Core claim CRUD (claimTask, startRun, finishRun, heartbeat) stays in `claimManager.ts`. Lease expiration moves to `claimLeaseManager.ts`. State transitions (finalization, input, session retry) move to `claimStateManager.ts`. Re-exports maintain backward compatibility.

### Start here

- `lib/claimManager.ts` — identify function groupings
- `coordinator.ts` — main consumer of claim manager functions

**Affected files:**
- `lib/claimLeaseManager.ts` — new file
- `lib/claimStateManager.ts` — new file
- `lib/claimManager.ts` — remove extracted functions, add re-exports

---

## Goals

1. Must extract `expireStaleLeasesDetailed` and `expireStaleLeases` into `claimLeaseManager.ts`
2. Must extract `setRunFinalizationState`, `setRunInputState`, `setRunSessionStartRetryState`, `setEscalationNotified`, `markTaskEnvelopeSent` into `claimStateManager.ts`
3. Must re-export all extracted functions from `claimManager.ts`
4. Must not change any behavior

---

## Acceptance criteria

- [ ] `lib/claimLeaseManager.ts` and `lib/claimStateManager.ts` exist
- [ ] All existing imports from `lib/claimManager.ts` still work
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope

---

## Verification

```bash
npx vitest run lib/claimManager.test.ts
```

```bash
npm test
```
