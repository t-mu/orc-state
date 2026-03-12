---
ref: orch/task-107-coordinator-pid-lock-atomic
epic: orch
status: done
---

# Task 107 — Make Coordinator PID Lock Atomic (TOCTOU Fix)

Independent. Blocks none.

## Scope

**In scope:**
- `coordinator.mjs` — `acquireCoordinatorLock()` — replace read-then-write with `O_EXCL` atomic create

**Out of scope:**
- Changes to `lock.mjs` (the general lock library already uses O_EXCL correctly)
- Changes to `start-session.mjs` or any CLI file
- Changes to coordinator logic beyond the lock acquisition

## Context

`acquireCoordinatorLock()` in `coordinator.mjs` has a TOCTOU (time-of-check to time-of-use) race:

```js
// Current code (lines 525-538):
if (existsSync(COORDINATOR_PID_FILE)) {        // CHECK
  let other;
  try { other = JSON.parse(readFileSync(...)); } catch {}
  if (other?.pid && isCoordinatorPidAlive(other.pid)) {
    console.error('...'); process.exit(1);
  }
}
writeFileSync(COORDINATOR_PID_FILE, JSON.stringify({ pid: ... }));  // USE
```

Between `existsSync` and `writeFileSync`, a second coordinator process could write its own PID. Both processes then believe they are the sole coordinator and proceed to modify shared state concurrently.

The fix mirrors `lock.mjs`: use `openSync` with `O_EXCL | O_CREAT | O_WRONLY` for an atomic create. If the file already exists, `openSync` throws `EEXIST`. Only then do we read the existing PID and check liveness.

**Affected files:**
- `coordinator.mjs` — `acquireCoordinatorLock()` function

## Goals

1. Must use `openSync` with `O_EXCL | O_CREAT | O_WRONLY` as the primary create attempt.
2. Must handle `EEXIST` by reading the existing PID file and checking liveness.
3. Must exit with error if the existing PID belongs to a live coordinator process.
4. Must delete a stale (dead-process) PID file and retry the atomic create once.
5. Must import `openSync`, `closeSync`, `constants` from `node:fs` (they may already be imported).

## Implementation

### Step 1 — Rewrite acquireCoordinatorLock

**File:** `coordinator.mjs`

```js
// Before:
function acquireCoordinatorLock() {
  if (existsSync(COORDINATOR_PID_FILE)) {
    let other;
    try { other = JSON.parse(readFileSync(COORDINATOR_PID_FILE, 'utf8')); } catch {}
    if (other?.pid) {
      if (isCoordinatorPidAlive(other.pid)) {
        console.error(`...`); process.exit(1);
      }
      log(`stale coordinator.pid removed (PID ${other.pid} is dead)`);
    }
  }
  writeFileSync(COORDINATOR_PID_FILE, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
  coordinatorLockReleased = false;
}

// After:
function acquireCoordinatorLock() {
  const payload = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });
  const flags = constants.O_EXCL | constants.O_CREAT | constants.O_WRONLY;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(COORDINATOR_PID_FILE, flags);
      try { writeSync(fd, payload); } finally { closeSync(fd); }
      coordinatorLockReleased = false;
      return;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    // File already exists — check if owner is alive
    let other;
    try { other = JSON.parse(readFileSync(COORDINATOR_PID_FILE, 'utf8')); } catch {}
    if (other?.pid && isCoordinatorPidAlive(other.pid)) {
      console.error(`[coordinator] ERROR: another coordinator is already running (PID ${other.pid}). Aborting.`);
      process.exit(1);
    }
    // Stale — remove and retry
    log(`stale coordinator.pid removed (PID ${other?.pid ?? 'unknown'} is dead)`);
    try { unlinkSync(COORDINATOR_PID_FILE); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  }
  throw new Error('Failed to acquire coordinator lock after retry');
}
```

Add `openSync`, `closeSync`, `writeSync`, `constants` to the existing `node:fs` import if not already present.

## Acceptance criteria

- [ ] `acquireCoordinatorLock` uses `openSync` with `O_EXCL | O_CREAT | O_WRONLY` as the primary create attempt.
- [ ] `EEXIST` is handled by reading the existing file and checking process liveness.
- [ ] A live-process conflict causes `process.exit(1)` with an informative message.
- [ ] A dead-process stale file is removed and the create is retried once.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `orchestrator/coordinator.test.mjs`

```js
it('acquireCoordinatorLock exits if another live coordinator holds the pid file');
it('acquireCoordinatorLock removes a stale pid file and acquires successfully');
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

## Risk / Rollback

**Risk:** The new `openSync` path may fail if `COORDINATOR_PID_FILE` directory doesn't exist. However `acquireCoordinatorLock` is called after `reconcileState` which ensures the state dir is present.

**Rollback:** `git restore coordinator.mjs && npm test`
