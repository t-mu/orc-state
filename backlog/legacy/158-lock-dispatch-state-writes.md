---
ref: orch/task-158-lock-dispatch-state-writes
epic: orch
status: todo
---

# Task 158 — Wrap dispatch-state.json Reads and Writes in State Lock

Independent.

## Scope

**In scope:**
- Wrap the `readDispatchState` + `writeDispatchState` block in `selectAutoTarget` inside `withLock`
- Pass `stateDir` through so the lock path is derivable wherever `selectAutoTarget` is called
- Tests verifying the lock is held during the read-modify-write cycle

**Out of scope:**
- Any change to `readDispatchState` or `writeDispatchState` function signatures beyond adding the lock wrapper
- Any change to `buildDispatchPlan`, `selectDispatchableAgents`, or `describeAutoTargetFailure`
- Any schema or format change to `dispatch-state.json`
- Coordinator tick restructuring

---

## Context

`lib/dispatchPlanner.mjs` maintains a round-robin cursor in `.orc-state/dispatch-state.json`. The `selectAutoTarget` function reads the cursor, computes the next target, then writes the updated cursor — but it does so without holding the shared state lock. Two coordinator processes (or two concurrent MCP handler calls) could interleave reads and produce duplicate assignments to the same agent, defeating the round-robin intent.

All other state writes in the orchestrator use `withLock(join(stateDir, '.lock'), fn)`. The dispatch state file must follow the same pattern.

### Current state

```js
// dispatchPlanner.mjs — selectAutoTarget (simplified)
const state = readDispatchState(stateDir);           // ← unguarded read
const nextTarget = /* round-robin logic */;
writeDispatchState(stateDir, nextTarget);            // ← unguarded write
```

### Desired state

```js
// dispatchPlanner.mjs — selectAutoTarget (simplified)
return withLock(join(stateDir, '.lock'), () => {
  const state = readDispatchState(stateDir);
  const nextTarget = /* round-robin logic */;
  writeDispatchState(stateDir, nextTarget);
  return nextTarget;
});
```

### Start here

- `lib/dispatchPlanner.mjs` — `selectAutoTarget`, `readDispatchState`, `writeDispatchState`
- `lib/lock.mjs` — `withLock` usage pattern

**Affected files:**
- `lib/dispatchPlanner.mjs` — wrap read+write in `withLock`
- `lib/dispatchPlanner.test.mjs` — verify lock contention or at least that the write is guarded

---

## Goals

1. Must import and call `withLock` around the `readDispatchState` + `writeDispatchState` pair in `selectAutoTarget`.
2. Must use `join(stateDir, '.lock')` as the lock path (same lock used by all other state writes).
3. Must preserve the existing round-robin logic and return value of `selectAutoTarget` unchanged.
4. Must catch and swallow lock errors in the same `try/catch` that already wraps `writeDispatchState` (dispatch continues even if state persistence fails).
5. Must not deadlock: if `selectAutoTarget` is already called inside a `withLock` on the same lock path, nest the calls or extract the logic — verify by reading the coordinator call site.

---

## Implementation

### Step 1 — Import `withLock` in `dispatchPlanner.mjs`

**File:** `lib/dispatchPlanner.mjs`

Add to imports:

```js
import { withLock } from './lock.mjs';
import { join } from 'node:path';
```

### Step 2 — Wrap read-modify-write in `selectAutoTarget`

**File:** `lib/dispatchPlanner.mjs`

Replace the current try/catch block around `writeDispatchState`:

```js
// Before:
const state = readDispatchState(stateDir);
const lastAssignedAgentId = state?.last_assigned_agent_id ?? null;
const lastIndex = eligible.findIndex((agent) => agent.agent_id === lastAssignedAgentId);
const nextTarget = lastIndex === -1
  ? eligible[0].agent_id
  : eligible[(lastIndex + 1) % eligible.length].agent_id;

try {
  writeDispatchState(stateDir, nextTarget);
} catch {
  // Dispatch should continue even if round-robin state persistence fails.
}
return nextTarget;
```

```js
// After:
let nextTarget = eligible[0].agent_id; // fallback if lock/read fails
try {
  withLock(join(stateDir, '.lock'), () => {
    const state = readDispatchState(stateDir);
    const lastAssignedAgentId = state?.last_assigned_agent_id ?? null;
    const lastIndex = eligible.findIndex((agent) => agent.agent_id === lastAssignedAgentId);
    nextTarget = lastIndex === -1
      ? eligible[0].agent_id
      : eligible[(lastIndex + 1) % eligible.length].agent_id;
    writeDispatchState(stateDir, nextTarget);
  });
} catch {
  // Dispatch should continue even if round-robin state persistence fails.
}
return nextTarget;
```

Invariant: the round-robin logic must be identical to the existing logic — only the lock wrapper is new.

### Step 3 — Verify no double-lock at call site

**File:** `coordinator.mjs`

Confirm that `selectAutoTarget` is not called from inside an active `withLock` on `.lock`. If it is, extract the read-modify-write into a helper that accepts an already-held lock context, or use a separate per-file lock for `dispatch-state.json` (e.g. `dispatch-state.lock`).

If the coordinator call site is already under `.lock`, use a dedicated `dispatch-state.lock` instead of the shared `.lock` to avoid deadlock.

### Step 4 — Update tests

**File:** `lib/dispatchPlanner.test.mjs`

Add a test that stubs `withLock` (or uses real lock on a temp dir) and verifies the read-before-write happens inside a single lock acquisition:

```js
it('selectAutoTarget wraps dispatch state read-write in a lock', () => {
  // use a real temp stateDir
  // call selectAutoTarget twice concurrently (if possible) or verify
  // that the resulting dispatch-state.json reflects the correct cursor
});
```

---

## Acceptance criteria

- [ ] `selectAutoTarget` acquires the state lock before reading `dispatch-state.json` and releases it after writing.
- [ ] Dispatch continues (returns a valid agent) even when the lock or write fails (error is caught and logged).
- [ ] Round-robin selection logic is byte-for-byte identical to the current logic — only the lock wrapper is new.
- [ ] No deadlock introduced: if the coordinator already holds `.lock` when calling `selectAutoTarget`, either the lock is reentrant-safe or a separate `dispatch-state.lock` file is used.
- [ ] Existing `dispatchPlanner.test.mjs` tests continue to pass.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/dispatchPlanner.test.mjs`:

```js
it('selectAutoTarget reads and writes dispatch state under lock', () => { ... });
it('selectAutoTarget returns first eligible agent when lock write fails', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/dispatchPlanner.test.mjs
```

```bash
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
npm run orc:doctor && npm run orc:status
```

---

## Risk / Rollback

**Risk:** If `selectAutoTarget` is called inside an existing `withLock` on `.lock`, adding a second `withLock` on the same path will deadlock (the lock is not reentrant). The implementation step explicitly requires checking the call site first.
**Rollback:** `git restore lib/dispatchPlanner.mjs` and re-run `npm test`.
