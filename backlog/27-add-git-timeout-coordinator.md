---
ref: general/27-add-git-timeout-coordinator
feature: general
priority: high
status: done
---

# Task 27 — Add Timeout to Coordinator Git Calls

Independent.

## Scope

**In scope:**
- `coordinator.ts` — add `timeout: 30_000` to `branchContainsMain()` and `mergeTaskBranch()` spawnSync calls
- `coordinator.ts` — add `if (result.error) throw result.error;` to both functions (makes the ETIMEDOUT surfaced; mirrors Task 26 for these two functions to keep this task self-contained)

**Out of scope:**
- `lib/runWorktree.ts` spawnSync calls — covered by Task 26
- `lib/repoRoot.ts` — intentional, no timeout needed
- Any other spawnSync call outside `coordinator.ts`
- Changing the 30-second timeout value (use a named constant)

---

## Context

`branchContainsMain()` and `mergeTaskBranch()` are called synchronously inside the coordinator's main tick. If either git command hangs (filesystem lock, slow NFS mount, remote fetch triggered by git internals), the entire coordinator process blocks indefinitely — no lease expiry, no heartbeat processing, no task dispatch. Workers will eventually have their leases expire and tasks requeue, but the coordinator itself remains unresponsive.

When a `timeout` option is passed to `spawnSync`, Node terminates the child process after the specified milliseconds and returns `result.error` with `code: 'ETIMEDOUT'`. The `if (result.error) throw result.error` pattern (Task 26) then surfaces this as a thrown error, which propagates through `markFinalizeBlocked()` and is logged.

### Current state

Both `branchContainsMain()` and `mergeTaskBranch()` call `spawnSync` with no timeout. A hanging git command blocks the coordinator tick until the OS terminates it (minutes to hours).

### Desired state

Both functions abort after 30 seconds and throw a clear `ETIMEDOUT` error. The coordinator tick continues (the run is marked finalize-blocked with the timeout reason), and all other tasks and workers proceed normally.

### Start here

- `coordinator.ts:361–379` — `branchContainsMain()` and `mergeTaskBranch()`, the two functions to modify

**Affected files:**
- `coordinator.ts` — the two git call functions

---

## Goals

1. Must: `branchContainsMain()` passes `timeout: 30_000` to spawnSync.
2. Must: `mergeTaskBranch()` passes `timeout: 30_000` to spawnSync.
3. Must: both functions add `if (result.error) throw result.error;` so ETIMEDOUT is propagated as a thrown error (self-contained; no dependency on Task 26 applying first).
4. Must: the timeout value is defined as a named constant `GIT_OP_TIMEOUT_MS = 30_000` near the top of the function block or with other coordinator constants.
5. Must: normal (non-timeout, non-error) operation is unchanged.
6. Must: `npm test` passes.

---

## Implementation

### Step 1 — Add GIT_OP_TIMEOUT_MS constant

**File:** `coordinator.ts`

Add after line 76 (`const MANAGED_SESSION_START_RETRY_DELAY_MS = 30_000;`), before `const REPO_ROOT`:

```typescript
const GIT_OP_TIMEOUT_MS = 30_000; // abort coordinator git ops after 30s to prevent tick blockage
```

### Step 2 — Update branchContainsMain

**File:** `coordinator.ts`

> **Note:** If Task 26 has already been applied, `branchContainsMain` will already contain `if (result.error) throw result.error;`. In that case, simply add `timeout: GIT_OP_TIMEOUT_MS` to the existing spawnSync options object — do not add a duplicate `result.error` check.

Match the function body by its name (`function branchContainsMain`) and produce this final form:

```typescript
function branchContainsMain(branch: string) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', 'main', branch], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_OP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
}
```

### Step 3 — Update mergeTaskBranch

**File:** `coordinator.ts`

> **Note:** Same as Step 2 — if Task 26 was applied first, only add `timeout: GIT_OP_TIMEOUT_MS`; do not duplicate the `result.error` check.

Match by function name (`function mergeTaskBranch`) and produce this final form:

```typescript
function mergeTaskBranch(branch: string, taskRef: string) {
  const result = spawnSync('git', ['merge', branch, '--no-ff', '-m', `task(${taskRef}): merge worktree`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_OP_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git merge failed for ${branch}: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
}
```

**Invariant:** do not change the merge commit message format `task(${taskRef}): merge worktree` — it is matched by tests and automation.

---

## Acceptance criteria

- [ ] `GIT_OP_TIMEOUT_MS = 30_000` constant exists in `coordinator.ts`.
- [ ] `branchContainsMain()` spawnSync call includes `timeout: GIT_OP_TIMEOUT_MS`.
- [ ] `mergeTaskBranch()` spawnSync call includes `timeout: GIT_OP_TIMEOUT_MS`.
- [ ] Both functions include `if (result.error) throw result.error;` before status checks.
- [ ] Normal operation (git exits 0 or 1) is unaffected — existing tests pass.
- [ ] `npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

The coordinator functions are not directly unit-tested (coordinator.ts is a process entry point). The acceptance criteria are verified by ensuring existing tests don't regress and by manual/integration smoke:

```bash
# Verify the constant and timeout option are present in the source
grep -n 'GIT_OP_TIMEOUT_MS\|timeout:' coordinator.ts
```

Expected output includes both the constant definition and the two `timeout: GIT_OP_TIMEOUT_MS` lines.

---

## Verification

```bash
grep -n 'GIT_OP_TIMEOUT_MS\|timeout: GIT_OP_TIMEOUT_MS' coordinator.ts
# Expected: 3 lines — 1 const definition + 2 usages
```

```bash
nvm use 24 && npm test
```
