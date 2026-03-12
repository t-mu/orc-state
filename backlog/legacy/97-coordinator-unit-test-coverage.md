# Task 97 — Coordinator Unit Tests: Untested Critical Paths

Independent. Can run in parallel with Tasks 94–96.

## Scope

**In scope:**
- `orchestrator/coordinator.test.mjs` — extend with tests for: `processTerminalRunEvents`, `doShutdown` double-lock-release fix, `acquireCoordinatorLock` duplicate-instance guard, `main()` startup validation

**Out of scope:**
- `coordinator.mjs` logic changes — fix only the `doShutdown` double-release bug; all other paths are test-only additions
- Integration/e2e tests — this task adds unit-level tests only
- Worker PTY lifecycle tests (covered separately)

---

## Context

`coordinator.test.mjs` has only 2 tests covering `ensureSessionReady`. The following paths
have **no test coverage** (found by code review):

1. **`processTerminalRunEvents`** — appends to `masterNotifyQueue` on `run_finished`/`run_failed`.
   No test verifies that a notification is deposited when a run completes.

2. **`doShutdown` double-release** — `main()` registers `releaseCoordinatorLock` via
   `process.on('exit', ...)` (line 541) AND `doShutdown` also calls `releaseCoordinatorLock`
   (line 605). When `doShutdown` runs `process.exit(0)`, the exit handler fires again and
   attempts a second `unlinkSync` on the already-deleted PID file. This is a silent correctness
   issue; the fix is to track whether the lock has been released and skip the duplicate.

3. **`acquireCoordinatorLock`** — the duplicate-coordinator guard is never tested. A second
   coordinator pointed at the same state dir should detect the existing PID file and exit.

4. **`main()` startup validation** — missing required state files → `process.exit(1)` path is
   never tested.

**Affected files:**
- `coordinator.mjs` — fix `doShutdown` double-release
- `orchestrator/coordinator.test.mjs` — extend with new tests

---

## Goals

1. Must fix the `doShutdown` double `releaseCoordinatorLock` call so the lock is only released once.
2. Must add a test that verifies `processTerminalRunEvents` deposits a notification into `master-notify-queue.jsonl` for `run_finished`.
3. Must add a test that verifies `processTerminalRunEvents` deposits a notification with `success: false` for `run_failed`.
4. Must add a test that verifies `doShutdown` does not attempt a second lock release when already released.
5. Must add a test that `main()` exits with code 1 when a required state file is missing.
6. Must not break the 2 existing coordinator tests.

---

## Implementation

### Step 1 — Fix `doShutdown` double lock release

**File:** `coordinator.mjs`

Add a module-level flag:

```js
let coordinatorLockReleased = false;
```

In `releaseCoordinatorLock` (or in the call sites), guard with the flag:

```js
function releaseCoordinatorLock() {
  if (coordinatorLockReleased) return;
  coordinatorLockReleased = true;
  try { unlinkSync(COORDINATOR_PID_FILE); } catch { /* already gone */ }
}
```

This makes both the `process.on('exit')` handler and `doShutdown` safe to call in any order.

### Step 2 — Export `processTerminalRunEvents` for testing (if not already exported)

**File:** `coordinator.mjs`

If `processTerminalRunEvents` is not exported, add a named export or expose it through the
existing test-surface export pattern used for `ensureSessionReady`. If the function is private,
extract its notification-deposit logic into a small testable helper.

### Step 3 — Add tests to `coordinator.test.mjs`

**File:** `orchestrator/coordinator.test.mjs`

```js
import { readPendingNotifications } from '../lib/masterNotifyQueue.mjs';

describe('processTerminalRunEvents — notification deposit', () => {
  it('deposits TASK_COMPLETE with success:true on run_finished event', async () => {
    // Set up state dir with a completed claim and a run_finished event
    const stateDir = mkdtempSync(...);
    // Write minimal backlog, agents, claims, events with run_finished
    // Call processTerminalRunEvents(stateDir, events, lastSeq)
    const notifications = readPendingNotifications(stateDir);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].success).toBe(true);
    expect(notifications[0].task_ref).toBe('orch/test-task');
  });

  it('deposits TASK_COMPLETE with success:false on run_failed event', async () => {
    // Similar setup with run_failed event
    const notifications = readPendingNotifications(stateDir);
    expect(notifications[0].success).toBe(false);
  });
});

describe('doShutdown — no double lock release', () => {
  it('calling doShutdown twice does not throw on second lock release attempt', async () => {
    // Write a fake coordinator.pid to the temp state dir
    // Call doShutdown() twice
    await expect(doShutdown()).resolves.not.toThrow();
    await expect(doShutdown()).resolves.not.toThrow();
    // PID file is gone after first call
    expect(existsSync(pidPath)).toBe(false);
  });
});

describe('main() startup validation', () => {
  it('exits with code 1 when backlog.json is missing', async () => {
    // State dir with no backlog.json
    const result = spawnSync(process.execPath, [COORDINATOR_PATH], {
      env: { ...process.env, ORCH_STATE_DIR: emptyDir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('backlog.json');
  });
});
```

Adapt the scaffolding to match the existing test helpers in `coordinator.test.mjs`.

---

## Acceptance criteria

- [ ] `doShutdown` / `releaseCoordinatorLock` is guarded to only execute once; second call is a no-op.
- [ ] New test confirms double-call does not throw.
- [ ] New tests confirm `run_finished` deposits `success: true` notification.
- [ ] New tests confirm `run_failed` deposits `success: false` notification.
- [ ] New test confirms `main()` exits 1 with descriptive stderr when `backlog.json` is absent.
- [ ] All 2 existing coordinator tests still pass.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside `coordinator.mjs` and `coordinator.test.mjs`.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs orchestrator/coordinator.test.mjs
```

---

## Verification

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Guarding `releaseCoordinatorLock` with a boolean flag is stateful. If `coordinator.mjs` is imported in tests that spin up multiple in-process coordinator instances, the flag persists across tests. Mitigate by resetting the flag in `acquireCoordinatorLock` on each fresh startup.

**Rollback:** `git restore coordinator.mjs orchestrator/coordinator.test.mjs`
