---
ref: general/167-pr-strategy-tests
feature: general
priority: normal
status: todo
review_level: full
depends_on:
  - general/165-coordinator-pr-finalization
---

# Task 167 — Add PR Strategy Integration and E2E Tests

Depends on Task 165 (coordinator PR path).

## Scope

**In scope:**
- E2E test for full PR lifecycle: work_complete → PR created → reviewer spawned → reviewer completes → PR merged → task released
- Integration tests for PR finalization state transitions
- Verify direct path is unaffected by PR code

**Out of scope:**
- Unit tests for individual components (covered by Tasks 161-165)
- Real provider tests (require live GitHub)

---

## Context

Tasks 161-165 each have their own unit tests. This task adds integration and e2e
coverage for the full PR path — ensuring the components work together. The test
mocks the git host adapter and the PR reviewer agent to simulate the complete cycle
without a real GitHub instance.

**Start here:** `e2e/consumer-lifecycle.e2e.test.ts` (existing e2e pattern)

**Affected files:**
- `e2e/pr-lifecycle.e2e.test.ts` — new
- `coordinator.test.ts` — integration tests for PR state machine

---

## Goals

1. Must test the full PR lifecycle end-to-end with mocked git host adapter.
2. Must test PR failure paths (reviewer fails, PR closed without merge, CI fails).
3. Must verify direct finalization path is unaffected when PR code is present.
4. Must verify `merge_strategy` resolution (task override, config, default).
5. Must verify PR reviewer is spawned with correct bootstrap and envelope.

---

## Implementation

### Step 1 — E2E PR lifecycle test

**File:** `e2e/pr-lifecycle.e2e.test.ts`

```typescript
describe('PR merge strategy e2e', () => {
  it('completes full PR lifecycle: work_complete → PR → reviewer → merge → released', async () => {
    // Setup: seed state with merge_strategy=pr, pr_provider=github
    // Mock git host adapter: createPr returns 'https://github.com/test/1'
    // Mock adapter: checkPrStatus returns 'merged' after reviewer finishes
    // Tick 1: work_complete → PR created, reviewer spawned
    // Simulate reviewer run_finished event
    // Tick 2: pr_review_in_progress → reviewer work_complete → coordinator merges → pr_merged → task released
    // Assert: task status released, worktree cleaned up, no stale claims
  });

  it('handles reviewer failure: sets pr_failed and requeues', async () => {
    // Simulate reviewer run_failed event
    // Assert: pr_failed, task requeued, master notified
  });

  it('handles PR closed without merge: sets pr_failed', async () => {
    // Mock checkPrStatus returns 'closed'
    // Assert: pr_failed, task requeued
  });

  it('direct path unchanged when merge_strategy=direct', async () => {
    // Seed with merge_strategy=direct (or absent)
    // Assert: existing direct finalization flow works identically
  });
});
```

### Step 2 — Integration tests for state transitions

**File:** `coordinator.test.ts`

Add to existing coordinator test suite:

```typescript
describe('PR finalization state machine', () => {
  it('transitions pr_created → pr_review_in_progress when reviewer spawned', () => { ... });
  it('merges PR via adapter on reviewer work_complete', () => { ... });
  it('signals reviewer run-finish after merge', () => { ... });
  it('transitions to pr_failed on reviewer run_failed', () => { ... });
  it('uses pr_finalize_lease_ms for PR claim leases', () => { ... });
  it('cleans up reviewer agent after terminal event', () => { ... });
});
```

---

## Acceptance criteria

- [ ] E2E test covers full PR happy path (work_complete → merged → released).
- [ ] E2E test covers reviewer failure path.
- [ ] E2E test covers PR closed without merge path.
- [ ] E2E test verifies direct path is unaffected.
- [ ] Integration tests cover all PR finalization state transitions.
- [ ] Coordinator merges PR after reviewer work_complete.
- [ ] PR lease duration is verified.
- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

This task IS the tests. See Implementation section above.

---

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:e2e
```
