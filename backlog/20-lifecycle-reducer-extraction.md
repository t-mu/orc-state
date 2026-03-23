---
ref: general/20-lifecycle-reducer-extraction
feature: general
priority: normal
status: done
---

# Task 20 — Extract Coordinator Lifecycle Handling Behind a Reducer

Depends on Task 19.

## Scope

**In scope:**
- Define a narrow reducer boundary for worker run lifecycle handling
- Move coordinator handling of lifecycle events behind a reducer-style state transition layer
- Preserve the existing command surface while refactoring internal transition logic
- Keep the first extraction focused on lifecycle events already covered by the hardening suite

**Out of scope:**
- Rewriting the entire orchestrator as a generic event-sourced system
- Changing the operator-facing command surface or workflow docs beyond any minimal internal references
- Refactoring unrelated backlog, worker registration, or session bootstrap flows

---

## Context

After event identity, spec authority, invariant checks, and hardening coverage are in place, the next architectural step is to make lifecycle transitions easier to reason about as a coherent state machine. The goal is not a system-wide rewrite, but a narrower reducer boundary around the most event-driven part of the coordinator.

### Current state

Coordinator lifecycle handling is spread across event processing branches and helper calls. The behavior is testable, but the transition rules are still encoded procedurally rather than in one clearly replayable transition layer.

### Desired state

Lifecycle events should be routed through a reducer-style boundary that makes valid transitions, ignored duplicates, and replay behavior explicit. The coordinator command surface should remain stable while the internal model becomes easier to audit and extend.

### Start here

- `coordinator.ts` — current lifecycle event handling branches
- `coordinator.test.ts` — hardening coverage that should define the reducer contract
- `lib/claimManager.ts` — current transition helpers to reuse or wrap

**Affected files:**
- `coordinator.ts` — handoff from event processing into the reducer boundary
- `lib/*` new reducer module(s) — lifecycle transition logic
- `coordinator.test.ts` — reducer-driven lifecycle expectations

---

## Goals

1. Must introduce a reducer-style boundary for lifecycle event handling without changing the public command surface.
2. Must keep the first extraction scoped to run lifecycle events already hardened by tests.
3. Must make duplicate, replayed, and ignored transitions explicit in the reducer contract.
4. Must preserve current user-visible behavior unless the hardening suite already defines a required correction.
5. Must avoid turning this task into a full-system rewrite.

---

## Implementation

### Step 1 — Define the reducer boundary

**File:** `coordinator.ts`

Identify the run lifecycle event branches to extract first and define the input/output contract for the reducer layer.

### Step 2 — Extract transition logic

**File:** `lib/workerLifecycleReducer.ts`

Move lifecycle transition decisions into a dedicated reducer-style module while reusing existing mutation helpers where appropriate.

### Step 3 — Rewire coordinator integration

**File:** `coordinator.ts`

Route lifecycle event handling through the reducer and preserve existing side effects, idempotence rules, and checkpoint updates.

---

## Acceptance criteria

- [ ] Run lifecycle event handling is routed through a dedicated reducer-style boundary.
- [ ] The extracted reducer makes duplicate, ignored, and replay-safe transitions explicit.
- [ ] Existing operator-facing commands and workflows remain unchanged.
- [ ] The hardening suite from Task 19 still passes without broad behavioral drift.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `coordinator.test.ts` and a dedicated reducer test file if created:

```ts
it('applies lifecycle transitions through the reducer boundary', () => { ... });
it('treats duplicate and replayed events as explicit reducer outcomes', () => { ... });
it('preserves coordinator-visible behavior after reducer extraction', () => { ... });
```

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run coordinator.test.ts lib/workerLifecycleReducer.test.ts
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
orc doctor
orc status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** A reducer extraction can accidentally duplicate or drop side effects if the boundary between transition logic and state mutation is not kept explicit.
**Rollback:** Revert the reducer module and coordinator integration together, restore the prior direct handling path, and rerun the hardening suite from Task 19.
