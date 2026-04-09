# Operator Recovery Guide

This guide covers multi-step operational recovery procedures. For quick
single-symptom fixes, see [Troubleshooting](./troubleshooting.md).

## Finalization Failure (`blocked_finalize`)

A run enters `blocked_finalize` when the coordinator cannot complete the
coordinator-owned finalization flow after the configured retry path. The work is
preserved in the run worktree and branch metadata tracked by the coordinator.

### Symptoms

- `orc status` shows `finalization_state=blocked_finalize`
- Recent failures include a preserved finalization problem
- The worker may no longer be able to finish through the normal handoff path

### Recovery Steps

1. Find the blocked run with `orc status` or `orc runs-active`.
2. Inspect the preserved worktree and branch metadata for that run.
3. Prefer the normal coordinator-owned path first.
   - If the worker is still active, use the documented finalize-rebase handoff flow.
   - If the live worker/coordinator handoff is no longer recoverable, move to manual recovery.
4. Manual recovery is recovery-only, not the normal workflow.

```bash
cd .worktrees/<run_id>
git rebase main
# resolve conflicts
git rebase --continue
```

5. After manual recovery, reconcile the run/task through the operator or coordinator path that applies at that moment.
6. Do not treat `orc run-finish` as the default manual recovery step after preserved finalization failure. That command is only valid if the live handoff path still supports it.

## Hung Input Request

If a worker is blocked on `orc run-input-request` and the master cannot respond:

1. Find the run with `orc runs-active`.
2. Respond through the supported input-response path:

```bash
orc run-input-respond --run-id=<run_id> --agent-id=<agent_id> --response="..."
```

3. If a response cannot be provided before timeout, expect the run to fail through the timeout path.
4. If operator intervention is still needed, stop the worker through the normal worker-management path and requeue or reset the task as needed.

## Session Start Failure After Retries

If coordinator logs show repeated `session_start_failed` after the bounded retry path:

1. Check the provider CLI is installed and in `PATH`.

```bash
which claude
which codex
which gemini
```

2. Check provider authentication and local environment health.
3. Distinguish managed-slot launch failures from manual worker-session failures and recover with the matching operator command.
4. If the slot remains unhealthy, use the existing worker reset or cleanup path before redispatching work.

## Stale Workers

Workers become stale when a PTY session terminates unexpectedly but the agent registration is
not cleaned up. The coordinator expires the claim when it detects the dead PID, but the stale
worker entry may remain in agent state.

### Symptoms

- `orc status` shows workers in `offline` or `error` state that are not processing tasks
- `orc doctor` reports stale worker entries

### Diagnosis

```bash
orc doctor
orc runs-active
```

### Fix

Mark stale workers offline, then remove them:

```bash
orc worker-gc
orc worker-clearall
```

If a task was claimed by the stale worker, reset it so it can be re-dispatched:

```bash
orc task-reset <task-ref>
```

## Stuck/Orphaned Worktrees

After a run finishes or fails, the coordinator cleans up the worktree and branch. If the
coordinator was interrupted or the cleanup step was skipped, the worktree directory persists
even though no active run is using it.

### Symptoms

- `.worktrees/` contains directories for runs that have finished or failed
- `git worktree list` shows entries with no corresponding active run

### Diagnosis

Compare the worktree list against active runs:

```bash
git worktree list
orc runs-active
```

Entries in `git worktree list` with no matching entry in `orc runs-active` are orphaned.

### Fix

Remove each orphaned worktree entry:

```bash
git worktree remove .worktrees/<run_id>
```

If the directory cannot be removed cleanly, use the force flag:

```bash
git worktree remove --force .worktrees/<run_id>
```

After removing orphaned worktrees, prune any lingering metadata:

```bash
git worktree prune
```

## Blocked Tasks

A task enters `blocked` state when a worker calls `orc run-fail --policy=block`. This prevents
automatic requeue so that the operator can review the failure before the task is retried.

### Symptoms

- `orc status` shows tasks with status `blocked`
- A task that should be eligible does not get dispatched

### Diagnosis

Check the task list and its dependency chain:

```bash
orc status
```

Inspect the task spec to review the `depends_on` field and the failure reason recorded in state.

### Fix

If the underlying issue has been resolved, unblock the task:

```bash
orc task-unblock <task-ref>
```

If the task is waiting on a dependency that is not yet `done`, complete the dependency first.
If the dependency itself is stuck, reset it and re-dispatch:

```bash
orc task-reset <dependency-ref>
orc delegate
```

## Full System Reset

Use this procedure only when session state is corrupted and normal recovery paths are not
viable — for example, after multiple coordinator crashes or when state files are inconsistent
beyond what `orc doctor` can report.

### Symptoms

- `orc status` or `orc doctor` returns errors even after individual recovery steps
- Multiple workers or runs are stuck in inconsistent states with no clear path forward

### Diagnosis

```bash
orc doctor --json
orc status
```

Review the output to confirm that incremental recovery is not possible.

### Fix

Stop all agents and clear all session state:

```bash
orc kill-all
```

**Warning:** This stops all work in progress. Active runs will be interrupted. Unmerged
worktrees remain on disk and must be cleaned up manually if needed (see
[Stuck/Orphaned Worktrees](#stuckorphaned-worktrees) above).

After `kill-all` completes, start a fresh session:

```bash
orc start-session
```
