# Task 67 — Add Coordinator Restart-Recovery E2E Tests (PTY)

Depends on Task 66. Blocks Task 68.

---

## Scope

**In scope:**
- Add e2e tests for stale-handle/dead-session recovery after coordinator restart conditions
- Validate session recreation and continued dispatch progress

**Out of scope:**
- Runtime behavior changes
- New retry/backoff policies
- Binary install workflow

---

## Context

With node-pty, in-memory session maps are process-local. After restart-like conditions, stored handles can be stale. Coordinator must detect dead sessions and recover by creating fresh ones when possible.

This reliability path should be explicitly covered with deterministic fixture binaries.

**Affected files:**
- `e2e/coordinatorPolicies.e2e.test.mjs`

---

## Goals

1. Must simulate restart-like state where worker has stale session metadata.
2. Must verify coordinator detects unreachable session.
3. Must verify coordinator re-establishes usable worker session when binary is available.
4. Must verify orchestration continues (task can be dispatched/completed after recovery).
5. Must verify no duplicate active-claim regression in this flow.

---

## Implementation

### Step 1 — Add stale-session fixture setup

**File:** `e2e/coordinatorPolicies.e2e.test.mjs`

Seed:
- worker with stale `session_handle` and dead/missing PID evidence,
- dispatchable task,
- PATH to fixture binaries.

### Step 2 — Add recovery assertions

Across ticks:
- stale session marked unreachable/offline path observed,
- fresh `pty:` session established when eligible,
- dispatch resumes.

### Step 3 — Add claim-integrity assertion

Assert there is at most one active claim for task during recovery.

Invariant:
- Keep existing policy tests unchanged except additive new test.

---

## Acceptance criteria

- [ ] Restart-recovery behavior is covered by automated e2e test.
- [ ] Test proves session recreation and resumed orchestration.
- [ ] No duplicate-claim regression appears.
- [ ] `npm run test:orc:e2e` passes.

---

## Tests

Add to `e2e/coordinatorPolicies.e2e.test.mjs`:

```js
it('recovers from stale PTY session metadata and resumes dispatch safely', async () => { ... });
```

---

## Verification

```bash
nvm use 24
npm run test:orc:e2e
```
