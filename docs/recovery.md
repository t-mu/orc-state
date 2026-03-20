# Operator Recovery Guide

This guide is for exceptional operator recovery cases. It does not replace the
normal coordinator-owned workflow.

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
