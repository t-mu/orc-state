# Task 32 — Startup Crash Reconciliation for Two-File Writes

High severity robustness fix. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Create `lib/reconcile.mjs` with a `reconcileState(stateDir)` function
- Call `reconcileState` at coordinator startup (before emitting `coordinator_started`)
- Write tests for all reconciliation scenarios
- Update `lib/reconcile.test.mjs`

**Out of scope:**
- Changing the two-file write pattern in `claimManager.mjs` (a larger architectural refactor)
- Running reconciliation on every tick (startup-only is sufficient)
- Changing any schema files

---

## Context

`claimManager.mjs` functions `claimTask`, `startRun`, and `finishRun` each write two files
in sequence inside a single lock:

1. Write `claims.json`
2. Write `backlog.json`

If the process crashes between writes (power loss, OOM kill, SIGKILL), the files end up
in an inconsistent state:

| Crash site | claims.json | backlog.json | Symptom |
|---|---|---|---|
| After `claimTask` write 1 | claim state=`claimed` | task status=`todo` | Task looks dispatchable but claim blocks it |
| After `startRun` write 1 | claim state=`in_progress` | task status=`claimed` | Dashboard shows wrong task status |
| After `finishRun` write 1 | claim state=`done`/`failed` | task status=`in_progress` | Task appears stuck forever — never requeued |

The worst case is the `finishRun` crash: a task shows `in_progress` in the backlog but its
claim is already closed. `expireStaleLeases` only looks at active claims; it will never
requeue this task. It appears stuck indefinitely.

Reconciliation at startup detects and repairs these inconsistencies without requiring schema
changes or a combined-file write refactor.

**Affected files:**
- `lib/reconcile.mjs` — new file
- `lib/reconcile.test.mjs` — new test file
- `coordinator.mjs` — call `reconcileState` at startup

---

## Goals

1. Must detect and repair all three crash-inconsistency scenarios described above
2. Must be idempotent — calling `reconcileState` on a consistent state changes nothing
3. Must log each repair it makes (use `console.log` with a `[reconcile]` prefix)
4. Must write repaired files atomically (using `atomicWriteJson`)
5. Must run under the coordinator lock to prevent concurrent writes during repair
6. Must not emit events (reconcile is a maintenance operation, not a business event)
7. Must have tests for each repair scenario and for the idempotent (no-repair) case

---

## Implementation

### Step 1 — Create `lib/reconcile.mjs`

```js
import { join } from 'node:path';
import { withLock } from './lock.mjs';
import { atomicWriteJson } from './atomicWrite.mjs';
import { readJson, findTask } from './stateReader.mjs';

const ACTIVE_CLAIM_STATES = new Set(['claimed', 'in_progress']);

/**
 * Cross-check claims.json against backlog.json and repair inconsistencies
 * left by crash-interrupted two-file writes.
 *
 * Repairs performed:
 *   1. Task status out of sync with active claim state (claim is active, task disagrees)
 *   2. Task shows active status but no corresponding active claim exists → reset to 'todo'
 *   3. Claim shows terminal state (done/failed) but task still shows active status → reset task to 'todo'
 *   4. Duplicate active claims for the same task_ref → keep newest (max claimed_at), mark older 'failed'
 *   5. Orphan claims whose task_ref does not exist in any epic → mark claim 'failed'
 */
export function reconcileState(stateDir) {
  return withLock(join(stateDir, '.lock'), () => {
    const claims = readJson(stateDir, 'claims.json');
    const backlog = readJson(stateDir, 'backlog.json');
    let claimsModified = false;
    let backlogModified = false;

    // Build a set of all known task_refs from the backlog for orphan detection.
    const knownTaskRefs = new Set();
    for (const epic of backlog.epics ?? []) {
      for (const task of epic.tasks ?? []) {
        if (task.ref) knownTaskRefs.add(task.ref);
      }
    }

    // Rule 4 — Duplicate active claims: group active claims by task_ref, keep newest.
    // Rule 5 — Orphan claims: task_ref not in backlog → mark failed.
    const activeClaimsByTaskRef = new Map(); // task_ref → array of active claims
    for (const claim of claims.claims ?? []) {
      if (!ACTIVE_CLAIM_STATES.has(claim.state)) continue;

      // Rule 5: orphan claim.
      if (!knownTaskRefs.has(claim.task_ref)) {
        console.log(`[reconcile] orphan claim ${claim.run_id} for unknown task_ref ${claim.task_ref} → failed`);
        claim.state = 'failed';
        claimsModified = true;
        continue;
      }

      const existing = activeClaimsByTaskRef.get(claim.task_ref) ?? [];
      existing.push(claim);
      activeClaimsByTaskRef.set(claim.task_ref, existing);
    }

    // Rule 4: for each task_ref with multiple active claims, keep newest, fail the rest.
    for (const [taskRef, activeClaims] of activeClaimsByTaskRef) {
      if (activeClaims.length <= 1) continue;
      activeClaims.sort((a, b) => (a.claimed_at > b.claimed_at ? -1 : 1)); // newest first
      const [_keep, ...stale] = activeClaims;
      for (const staleClaim of stale) {
        console.log(`[reconcile] duplicate active claim ${staleClaim.run_id} for task ${taskRef} → failed (kept ${_keep.run_id})`);
        staleClaim.state = 'failed';
        claimsModified = true;
      }
    }

    // Build a map from task_ref → surviving active claim for backlog sync.
    const activeClaimByTaskRef = new Map();
    for (const claim of claims.claims ?? []) {
      if (ACTIVE_CLAIM_STATES.has(claim.state)) {
        activeClaimByTaskRef.set(claim.task_ref, claim);
      }
    }

    // Pass 1: for each task in backlog, check against active claims.
    for (const epic of backlog.epics ?? []) {
      for (const task of epic.tasks ?? []) {
        const taskRef = task.ref;
        if (!taskRef) continue;

        const activeClaim = activeClaimByTaskRef.get(taskRef);

        if (activeClaim) {
          // There is an active claim — task status must match claim state.
          const expectedStatus = activeClaim.state === 'in_progress' ? 'in_progress' : 'claimed';
          if (task.status !== expectedStatus) {
            console.log(`[reconcile] repaired task ${taskRef}: status ${task.status} → ${expectedStatus} (active claim ${activeClaim.run_id} state=${activeClaim.state})`);
            task.status = expectedStatus;
            backlogModified = true;
          }
        } else if (task.status === 'claimed' || task.status === 'in_progress') {
          // Task shows active status but no matching active claim → reset to todo.
          console.log(`[reconcile] repaired task ${taskRef}: status ${task.status} → todo (no active claim found)`);
          task.status = 'todo';
          backlogModified = true;
        }
        // 'done', 'blocked', 'todo' statuses with no active claim are consistent.
      }
    }

    if (backlogModified) {
      atomicWriteJson(join(stateDir, 'backlog.json'), backlog);
    }
    if (claimsModified) {
      atomicWriteJson(join(stateDir, 'claims.json'), claims);
    }

    const repairCount = (backlogModified ? 1 : 0) + (claimsModified ? 1 : 0);
    if (repairCount === 0) {
      console.log('[reconcile] state consistent — no repairs needed');
    } else {
      console.log(`[reconcile] wrote ${repairCount} repaired file(s)`);
    }
  });
}
```

### Step 2 — Call `reconcileState` at coordinator startup

**File:** `coordinator.mjs`

Add import:
```js
import { reconcileState } from './lib/reconcile.mjs';
```

In `main()`, call it after the startup file-existence checks but before emitting
`coordinator_started`:

```js
async function main() {
  log(`starting — mode=${MODE} ...`);

  // Check required files exist.
  for (const file of ['backlog.json', 'agents.json', 'claims.json', 'events.jsonl']) {
    if (!existsSync(join(STATE_DIR, file))) {
      console.error(`[coordinator] ERROR: required state file missing: ${file}`);
      process.exit(1);
    }
  }

  // Reconcile state before starting — repairs inconsistencies from prior crashes.
  reconcileState(STATE_DIR);

  emit({ event: 'coordinator_started', ... });
  // ... rest of main unchanged
}
```

### Step 3 — Create `lib/reconcile.test.mjs`

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileState } from './reconcile.mjs';
import { readJson } from './stateReader.mjs';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'reconcile-test-')); writeFileSync(join(dir, 'events.jsonl'), ''); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeState({ tasks, claims }) { /* write backlog + claims + agents */ }

describe('reconcileState', () => {
  it('is a no-op when state is consistent', () => { ... });
  it('repairs task status when claim is in_progress but task shows claimed', () => { ... });
  it('resets task to todo when claim is done but task shows in_progress', () => { ... });
  it('resets task to todo when task shows claimed but no active claim exists', () => { ... });
  it('is idempotent — calling twice produces same result', () => { ... });
});
```

---

## Acceptance criteria

- [ ] `lib/reconcile.mjs` exports `reconcileState(stateDir)`
- [ ] `reconcileState` is called at coordinator startup before `coordinator_started` is emitted
- [ ] Scenario A: claim `in_progress`, task `claimed` → task repaired to `in_progress`
- [ ] Scenario B: claim `done`, task `in_progress` → task repaired to `todo`
- [ ] Scenario C: task `claimed`/`in_progress`, no active claim → task repaired to `todo`
- [ ] Scenario D: two active claims for same `task_ref` → older one marked `failed`, newer kept active
- [ ] Scenario E: active claim whose `task_ref` is absent from backlog → claim marked `failed`
- [ ] Clean state with no repairs logs "no repairs needed" and makes no writes
- [ ] Calling `reconcileState` twice on the same state produces the same result (idempotent)
- [ ] All repairs are written atomically via `atomicWriteJson`
- [ ] No events are emitted to `events.jsonl` during reconciliation
- [ ] All existing tests pass; new reconcile tests pass

---

## Tests

Create `lib/reconcile.test.mjs` with at minimum:

- `is a no-op when state is consistent`
- `repairs in_progress claim with mismatched task status`
- `resets task to todo when terminal claim exists but task still active`
- `resets task to todo when no claim exists but task shows active status`
- `marks older duplicate active claim as failed, keeps newest`
- `marks claim as failed when task_ref is not in backlog (orphan claim)`
- `is idempotent`

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

```bash
# Confirm reconcile is called at startup
grep -n 'reconcileState' coordinator.mjs
# Expected: import line + one call in main()
```

---

## Risk / Rollback

**Risk:** Reconciliation runs under the coordinator lock. If another process holds the lock
at startup (e.g., a stale lock file), the coordinator will fail to acquire it and hang.
The 30-second stale-lock timeout in `lock.mjs` handles this automatically.

**Rollback:** Remove the `reconcileState(STATE_DIR)` call from `coordinator.mjs`. The
`lib/reconcile.mjs` file can remain — it is never called if not imported and invoked.
No state files are modified by this change under normal (consistent) conditions.
