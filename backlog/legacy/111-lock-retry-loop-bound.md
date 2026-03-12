---
ref: orch/task-111-lock-retry-loop-bound
epic: orch
status: done
---

# Task 111 — Fix Lock Retry Loop Bound (2 → 3 Attempts)

Independent. Blocks none.

## Scope

**In scope:**
- `lib/lock.mjs` — `acquireLock`: change `attempt < 2` to `attempt < 3`
- `lib/lock.test.mjs` — add a test confirming the stale-break + retry path succeeds

**Out of scope:**
- Changes to `withLock`, `withLockAsync`, or `releaseLock`
- Changes to STALE_MS or MALFORMED_STALE_BREAK_MS constants
- Changes to callers of `acquireLock`

## Context

`acquireLock` in `lock.mjs` uses a retry loop bounded to 2 attempts:

```js
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    const fd = openSync(lockPath, lockFlags);  // attempt to create
    ...
    return;
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
  }
  // ... check stale, maybe unlink ...
}
throw new Error('Failed to acquire lock due to concurrent updates');
```

The loop has two iterations (attempt 0 and attempt 1). Iteration 0 fails with EEXIST, the stale check runs and may `unlink` the file, then iteration 1 runs. If iteration 1 also fails (e.g. extremely tight race where another process re-created the file), the loop exits and throws — there is no third attempt to retry after the race resolves.

In the common stale-break path: attempt-0 fails → unlink → attempt-1 succeeds. This works. But if a concurrent process re-locks between unlink and attempt-1, the caller sees a spurious failure. Three attempts (0, 1, 2) provide one extra retry after a stale-break without meaningfully increasing hold-attempt time.

The same 2-attempt bound already bit the coordinator PID lock (Task 107 fixes that separately). This task fixes the general `acquireLock`.

**Affected files:**
- `lib/lock.mjs` — loop bound
- `lib/lock.test.mjs` — new test

## Goals

1. Must change `attempt < 2` to `attempt < 3` in `acquireLock`.
2. Must preserve all existing stale-detection and liveness-check logic unchanged.
3. Must add a test that simulates: attempt-0 EEXIST with stale dead-process lock → unlink → attempt-1 EEXIST (concurrent re-lock) → unlink → attempt-2 succeeds.

## Implementation

### Step 1 — Change loop bound

**File:** `lib/lock.mjs`

```js
// Before:
for (let attempt = 0; attempt < 2; attempt += 1) {

// After:
for (let attempt = 0; attempt < 3; attempt += 1) {
```

No other changes in the function.

## Acceptance criteria

- [ ] `acquireLock` loop runs up to 3 attempts (`attempt < 3`).
- [ ] All existing `lock.test.mjs` tests pass unchanged.
- [ ] New test covering the double-stale-break scenario is added and passes.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `lib/lock.test.mjs`

```js
it('acquireLock succeeds after two consecutive stale-lock removals', () => {
  // Simulate openSync failing EEXIST twice (stale dead-process file recreated by racer),
  // then succeeding on the third attempt.
  // Confirm lock is acquired and function returns without throwing.
});
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```
