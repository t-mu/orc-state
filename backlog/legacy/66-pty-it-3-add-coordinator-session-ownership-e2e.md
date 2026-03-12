# Task 66 — Add Coordinator Session-Ownership E2E Coverage

Depends on Task 65. Blocks Task 67.

---

## Scope

**In scope:**
- Extend orchestration e2e tests to prove coordinator-owned worker PTY creation
- Validate dispatch proceeds through coordinator-created PTY sessions
- Keep worker CLI command semantics register/rebind-only

**Out of scope:**
- Adapter internals
- Binary install logic
- Restart recovery policy (Task 67)

---

## Context

Architecture invariant: only coordinator owns worker PTY sessions. A worker can be registered with `session_handle: null`; coordinator must create session on tick and dispatch work through it.

This must be covered with real fixture binaries, not fully mocked adapters.

**Affected files:**
- `e2e/orchestrationLifecycle.e2e.test.mjs`
- `cli/start-worker-session.test.mjs` (only if assertion gap remains)

---

## Goals

1. Must prove `session_handle: null` -> `session_handle: pty:<agent>` transition by coordinator tick.
2. Must prove dispatch and lifecycle state transitions on that recreated session.
3. Must maintain assertion that worker CLI start command does not spawn PTY directly.
4. Must execute with fixture binaries via PATH override.
5. Must keep tests deterministic via isolated temp state.

---

## Implementation

### Step 1 — Add real-adapter e2e scenario

**File:** `e2e/orchestrationLifecycle.e2e.test.mjs`

Scenario requirements:
- seed worker with `status: running`, `session_handle: null`, provider `claude`
- seed one `todo` dispatchable task
- PATH includes fixture bin
- run `coordinator.tick()`
- assert worker runtime has `session_handle` prefixed `pty:`

### Step 2 — Assert orchestration outcomes

After one or two ticks:
- assert claim created for task
- assert task status leaves `todo` (expected transition per current contract)
- assert event log includes dispatch/lifecycle evidence

### Step 3 — Preserve worker-CLI non-ownership check

If needed, add/adjust one test in `start-worker-session.test.mjs` that `adapter.start` is never called.

Invariant:
- Do not modify coordinator runtime behavior; tests only.

---

## Acceptance criteria

- [ ] E2E test shows coordinator-created PTY session for null-handle worker.
- [ ] E2E test shows successful dispatch path on that session.
- [ ] Worker CLI path remains PTY-non-owning.
- [ ] `npm run test:orc:e2e` passes reliably.

---

## Tests

Add to `e2e/orchestrationLifecycle.e2e.test.mjs`:

```js
it('coordinator owns worker PTY creation and dispatches from null handle', async () => { ... });
```

---

## Verification

```bash
nvm use 24
npm run test:orc:e2e
npm run test:orc:unit
```
