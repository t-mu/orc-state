---
ref: general/56-worktree-gc-after-merge
title: "Fix worktree cleanup: remove git worktree and branch after merge"
status: todo
feature: general
task_type: implementation
priority: high
depends_on: []
---

# Task 56 — Fix worktree cleanup: remove git worktree and branch after merge

## Context

After a task branch is merged into main, the coordinator calls
`cleanupRunWorktree(STATE_DIR, run_id)` which runs:

1. `git worktree remove --force <path>`
2. `git branch -d <branch>`

Two failure modes cause worktrees to accumulate indefinitely:

1. **`git branch -d` fails** after a `--no-ff` merge. Git's `-d` flag checks
   whether the branch tip is reachable from HEAD — but with `--no-ff`, the
   branch tip is always reachable, so this should work. However if the
   `worktree remove` step succeeds but the branch delete fails (or vice versa),
   `cleanupRunWorktree` returns `false`, logs "cleanup pending", and never retries.

2. **No retry mechanism.** The coordinator has `pruneMissingRunWorktrees` which
   runs every tick but it only removes entries from the JSON metadata file where
   the path is *already gone* — it never issues `git worktree remove` for
   entries that are still present but not in active runs.

The result: every completed task leaves a worktree directory and branch
permanently on disk.

## Acceptance Criteria

1. **`cleanupRunWorktree` uses `git branch -D`** (force-delete) instead of
   `-d`. After a `--no-ff` merge the branch is always incorporated; forcing
   is safe and avoids spurious failures.

2. **`pruneMissingRunWorktrees` actively cleans up** stale-but-present
   worktrees: for any entry in `run_worktrees.json` whose `run_id` is NOT in
   the active set AND whose path still exists as a git worktree, run
   `git worktree remove --force` + `git branch -D` and remove the entry from
   the JSON. The current behaviour (keep entries where the path exists) is
   replaced with active cleanup for non-active runs.

3. **Cleanup errors are tolerated without leaving entries permanently stuck.**
   If `git worktree remove` or `git branch -D` fails (e.g. permission error),
   log a warning and leave the entry in place so the next tick retries — do
   not mark the run as cleaned until both commands succeed.

4. **`orc worker-gc` CLI command** (already exists at `cli/worker-gc.ts`)
   extended or a new `orc worktree-gc` command added that triggers
   `pruneMissingRunWorktrees` manually for operator use.

5. **Existing tests updated**: `runWorktree.test.ts` — `cleanupRunWorktree`
   tests updated to use `-D`, and `pruneMissingRunWorktrees` tests updated to
   assert that `git worktree remove` is called for non-active present entries.

6. `npm test` passes. `orc doctor` exits 0.

## Files to Change

- `lib/runWorktree.ts` — fix `cleanupRunWorktree` (`-d` → `-D`) and
  `pruneMissingRunWorktrees` (add active cleanup logic)
- `lib/runWorktree.test.ts` — update affected tests
- `cli/orc.ts` — add `worktree-gc` command entry (or extend `worker-gc`)
- `cli/worktree-gc.ts` — new file implementing the CLI command

## Verification

```bash
npm test
orc doctor
# After a task completes and is merged, verify:
git worktree list | grep "\.worktrees/run-"  # should only show active runs
```
