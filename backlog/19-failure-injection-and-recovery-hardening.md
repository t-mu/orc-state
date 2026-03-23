---
ref: general/19-failure-injection-and-recovery-hardening
feature: general
priority: high
status: done
---

# Task 19 — Add Failure-Injection and Recovery Hardening Coverage

Depends on Task 17. Blocks Task 20.

## Scope

**In scope:**
- Add targeted tests for delayed, duplicated, stale, and replayed lifecycle events
- Add restart and recovery coverage for coordinator resume behavior
- Exercise failure modes around finalization, worker timeout, and input-wait recovery where they intersect with the current runtime model
- Keep this task focused on exposing and hardening concrete failure cases rather than redesigning the architecture

**Out of scope:**
- New operator workflows or major docs rewrites
- Large event-model refactors beyond the minimal fixes required by the new tests
- Full reducer extraction

---

## Context

The orchestration runtime is usable, but its confidence under stress still depends too much on happy-path coverage. Before deeper internal refactors, the codebase needs explicit tests for the failure and replay scenarios most likely to expose lifecycle bugs.

### Current state

The suite covers many nominal flows, but restart, duplicate-event, stale-event, and partial-recovery scenarios remain underrepresented. That makes it harder to distinguish between a genuinely solid lifecycle model and one that merely passes happy-path tests.

### Desired state

The repository should have a focused hardening suite that exercises delayed events, duplicates, stale terminal signals, coordinator restarts, and recovery boundaries. The result should be a clearer map of remaining runtime risks before deeper refactors begin.

### Start here

- `coordinator.test.ts` — existing lifecycle and recovery coverage
- `cli/run-reporting.test.ts` — worker lifecycle event coverage
- `cli/run-input-request.ts` and related tests — current input-wait timeout/recovery behavior

**Affected files:**
- `coordinator.test.ts` — restart, replay, and stale-event coverage
- `cli/run-reporting.test.ts` — duplicate and delayed event expectations
- `cli/*` tests around input/recovery behavior — targeted failure-mode coverage only

---

## Goals

1. Must add targeted coverage for duplicate, delayed, stale, and replayed lifecycle events.
2. Must exercise coordinator restart and recovery behavior explicitly.
3. Must clarify the remaining runtime failure boundaries before reducer extraction.
4. Must keep fixes driven by concrete failing cases rather than speculative redesign.
5. Must preserve the current public command surface.

---

## Implementation

### Step 1 — Add failure-injection scenarios

**File:** `coordinator.test.ts`

Introduce targeted cases for duplicate events, delayed delivery, stale terminal events, and replay of already processed lifecycle signals.

### Step 2 — Add restart and recovery coverage

**File:** `coordinator.test.ts`

Add cases for coordinator restart with pending events and in-flight lifecycle state.

### Step 3 — Fix only the concrete failures the new tests expose

**File:** `coordinator.ts`

Apply narrowly scoped runtime fixes that are directly justified by the hardening suite. Avoid broad architecture churn in this task.

---

## Acceptance criteria

- [ ] The suite includes explicit coverage for duplicate, delayed, stale, and replayed lifecycle events.
- [ ] Coordinator restart and recovery paths are exercised by tests.
- [ ] Any runtime changes made in this task are tied to concrete failing scenarios introduced by the new tests.
- [ ] Public CLI behavior remains stable unless a tested bug fix requires a documented adjustment.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `coordinator.test.ts` and related CLI lifecycle tests:

```ts
it('ignores stale terminal events for an older run after a newer claim exists', () => { ... });
it('replays pending events safely after coordinator restart', () => { ... });
it('handles duplicate lifecycle events without double-applying state transitions', () => { ... });
```

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run coordinator.test.ts cli/run-reporting.test.ts
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

**Risk:** Hardening fixes can subtly change lifecycle timing or event handling in ways that only show up under coordinator load.
**Rollback:** Revert the hardening changes together with the new failing scenarios, then reintroduce the tests incrementally once the narrower bug boundary is understood.
