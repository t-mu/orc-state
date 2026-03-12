---
ref: orch/task-157-coordinator-worktree-cleanup-after-merge
epic: orch
status: todo
---

# Task 157 — Coordinator Cleans Up Worktree After Merge

Depends on Task 152. Blocks nothing.

## Scope

**In scope:**
- New `cleanupRunWorktree(stateDir, runId)` export in `lib/runWorktree.mjs`
- Call `cleanupRunWorktree` from the coordinator finalization path (after successful `git merge`) added by tasks 150–152
- Remove the run entry from `run-worktrees.json` after cleanup
- Tests for the new function in `lib/runWorktree.test.mjs`

**Out of scope:**
- The merge logic itself (tasks 150–152)
- Worktree creation path (`ensureRunWorktree`) — must not change
- Any change to worker bootstrap or `AGENTS.md` finish section
- Cleanup of worktrees that belong to failed runs (a separate concern)

---

## Context

After a worker signals `run_work_complete`, the coordinator-owned finalization flow (tasks 150–152) rebases and merges the task branch into main. Today that flow ends after the merge — the git worktree directory at `.worktrees/<run_id>` and the task branch `task/<run_id>` are left dangling on disk indefinitely.

`lib/runWorktree.mjs` already tracks worktree paths and branches in `.orc-state/run-worktrees.json`. The data needed for cleanup is already stored; we just need a cleanup function and a call site.

### Current state

After a successful coordinator-owned merge the worktree directory `.worktrees/<run_id>` remains on disk and the branch `task/<run_id>` remains in the git repo. `run-worktrees.json` retains a stale entry for the run. Over time these accumulate without bound.

### Desired state

After a successful merge the coordinator calls `cleanupRunWorktree`. The function removes the git worktree (`git worktree remove --force <path>`), deletes the branch (`git branch -d <branch>`), and removes the entry from `run-worktrees.json`. The directory and branch are gone from disk; `run-worktrees.json` no longer references the run.

### Start here

- `lib/runWorktree.mjs` — existing worktree creation and tracking logic
- `coordinator.mjs` — locate the finalization success path added by task 152

**Affected files:**
- `lib/runWorktree.mjs` — add `cleanupRunWorktree` export
- `lib/runWorktree.test.mjs` — add tests for cleanup
- `coordinator.mjs` — call `cleanupRunWorktree` after successful merge

---

## Goals

1. Must export `cleanupRunWorktree(stateDir, runId)` from `lib/runWorktree.mjs`.
2. Must remove the git worktree via `git worktree remove --force <worktree_path>`.
3. Must delete the task branch via `git branch -d <branch>` (non-force; branch must already be merged).
4. Must remove the run entry from `run-worktrees.json` using `withLock + atomicWriteJson`.
5. Must not throw if the worktree path or branch no longer exists — log a warning and continue.
6. Must be called by the coordinator finalization success handler added in tasks 150–152.

---

## Implementation

### Step 1 — Add `cleanupRunWorktree` to `lib/runWorktree.mjs`

**File:** `lib/runWorktree.mjs`

Add after the existing `ensureRunWorktree` export:

```js
export function cleanupRunWorktree(stateDir, runId) {
  if (!runId) throw new Error('runId is required');

  return withLock(lockPath(stateDir), () => {
    const file = readRunWorktrees(stateDir);
    const entry = file.runs.find((r) => r.run_id === runId) ?? null;

    if (!entry) {
      console.warn(`[runWorktree] cleanupRunWorktree: no entry found for run ${runId}`);
      return;
    }

    const { worktree_path, branch } = entry;

    // Remove git worktree (--force in case checkout is dirty)
    if (existsSync(worktree_path)) {
      const rmResult = spawnSync('git', ['worktree', 'remove', '--force', worktree_path], {
        cwd: repoRoot(),
        encoding: 'utf8',
      });
      if (rmResult.status !== 0) {
        console.warn(`[runWorktree] worktree remove failed: ${rmResult.stderr?.trim()}`);
      }
    } else {
      console.warn(`[runWorktree] cleanupRunWorktree: worktree path not found, skipping remove: ${worktree_path}`);
    }

    // Delete branch (non-force; must already be merged)
    if (branch) {
      const branchResult = spawnSync('git', ['branch', '-d', branch], {
        cwd: repoRoot(),
        encoding: 'utf8',
      });
      if (branchResult.status !== 0) {
        console.warn(`[runWorktree] branch delete failed: ${branchResult.stderr?.trim()}`);
      }
    }

    // Remove entry from run-worktrees.json
    const remaining = file.runs.filter((r) => r.run_id !== runId);
    atomicWriteJson(RUN_WORKTREES_FILE, { version: '1', runs: remaining });
  });
}
```

Invariant: do not change `ensureRunWorktree`, `getRunWorktree`, or the file read helpers.

### Step 2 — Call cleanup from the coordinator finalization success path

**File:** `coordinator.mjs`

In the finalization success handler added by task 152, after the merge completes and the task is marked `done`, add:

```js
import { cleanupRunWorktree } from './lib/runWorktree.mjs';

// After successful merge:
cleanupRunWorktree(stateDir, runId);
```

Invariant: the cleanup call must be best-effort — catch and log any error without aborting the finalization success path.

### Step 3 — Add tests

**File:** `lib/runWorktree.test.mjs`

```js
it('cleanupRunWorktree removes the entry from run-worktrees.json', () => {
  // seed run-worktrees.json with an entry
  // stub spawnSync to succeed
  // call cleanupRunWorktree
  // assert entry is gone from run-worktrees.json
});

it('cleanupRunWorktree warns and continues when worktree path does not exist', () => {
  // seed entry with a non-existent path
  // assert no throw, entry removed from json
});

it('cleanupRunWorktree warns and continues when run entry not found', () => {
  // call with unknown runId
  // assert no throw
});
```

---

## Acceptance criteria

- [ ] `cleanupRunWorktree(stateDir, runId)` is exported from `lib/runWorktree.mjs`.
- [ ] After a successful call, the worktree directory is removed from disk (or a warning is logged if it was already absent).
- [ ] After a successful call, the task branch is deleted (or a warning is logged if already absent).
- [ ] After a successful call, the run entry is absent from `run-worktrees.json`.
- [ ] If the run has no entry in `run-worktrees.json`, function logs a warning and returns without throwing.
- [ ] Coordinator finalization success path calls `cleanupRunWorktree` and does not crash if it throws.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/runWorktree.test.mjs`:

```js
describe('cleanupRunWorktree', () => {
  it('removes json entry and issues git commands on success', () => { ... });
  it('warns and returns when entry not found', () => { ... });
  it('warns and continues when worktree path missing', () => { ... });
});
```

---

## Verification

```bash
npx vitest run lib/runWorktree.test.mjs
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

**Risk:** `git branch -d` fails if the branch was not merged (e.g. coordinator merges with `--no-ff` but git doesn't recognize the branch as merged in some edge case). The `--force` flag is intentionally not used on branch delete to protect unmerged work.
**Rollback:** If cleanup is called erroneously, run `git worktree list` to verify state; restore branch from reflog with `git branch <branch> <sha>` if needed. Revert the coordinator call site and re-run `npm run orc:doctor`.
