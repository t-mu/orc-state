---
ref: general/29-structured-session-start-errors
feature: general
priority: normal
status: done
---

# Task 29 — Surface Actual Error in Session-Start Failures

Independent.

## Scope

**In scope:**
- `coordinator.ts` — replace two hardcoded `failureReason` strings with the actual `ready.reason` from `ensureSessionReady()`, and add `appendNotification` calls for both session-start failure paths
- `coordinator.ts` — include `ready.reason` in the `session_start_failed` event payload when retries are exhausted

**Out of scope:**
- `lib/workerRuntime.ts` — already captures `error.message` as `reason` and returns it; no change needed there
- Changing retry counts or retry delays
- Changing the `ERR_SESSION_START_FAILED` failure code
- Adding new event types

---

## Context

When a worker session fails to start (PTY spawn fails, adapter.start() throws, git worktree allocation fails), `launchWorkerSession()` in `lib/workerRuntime.ts` captures the error as `reason: (error as Error)?.message` and returns `{ ok: false, reason }`. This reason propagates back through `ensureSessionReady()` as `result.reason`.

The two `finishRun()` calls that handle exhausted retries both use hardcoded strings instead of `ready.reason`:

- `coordinator.ts:322`: `failureReason: 'session_start_failed: worker session could not be launched in assigned worktree'`
- `coordinator.ts:957`: same hardcoded string

So the actual error (e.g., `"spawnSync git ENOENT"`, `"Failed to allocate worktree /path: "`) is stored in `session_start_last_error` on the claim but is dropped from the `finishRun` failure record and from master notifications. When debugging why tasks keep requeuing, the operator has no actionable information from `orc status` or `orc doctor`.

Neither failure path calls `appendNotification`, so the master never receives a signal that repeated session starts are failing for a specific task/agent.

### Current state

- `coordinator.ts:322`: hardcoded `failureReason` string — actual error lost
- `coordinator.ts:957`: hardcoded `failureReason` string — actual error lost
- `coordinator.ts:315`: `session_start_failed` event payload carries a hardcoded reason, not the actual error
- Neither failure path surfaces the error to the master notify queue

### Desired state

- `finishRun()` is called with `failureReason: \`session_start_failed: ${ready.reason ?? '...'}\`` in both paths
- The `session_start_failed` event at line 308–319 includes the actual `ready.reason` in its payload
- Both failure paths call `appendNotification` with `type: 'SESSION_START_FAILED'` so master can see the error via `orc master-check`

### Start here

- `coordinator.ts:305–330` — `processManagedSessionStartRetries()` — retries-exhausted path
- `coordinator.ts:946–964` — initial dispatch failure path
- `coordinator.ts:307–319` — the `session_start_failed` event payload with hardcoded reason

**Affected files:**
- `coordinator.ts` — two `finishRun` calls, one event payload, two new `appendNotification` calls

---

## Goals

1. Must: both `finishRun()` calls for session-start failure use `ready.reason` in `failureReason` (falling back to the current hardcoded string only when `ready.reason` is undefined).
2. Must: the `session_start_failed` event emitted at retries-exhausted includes the actual `ready.reason` in its payload.
3. Must: both failure paths call `appendNotification` with `type: 'SESSION_START_FAILED'`, `task_ref`, `run_id`, `agent_id`, `reason`, and a `dedupe_key`.
4. Must: `ready.reason` is never silently dropped — it must appear in at least one of: event payload, failureReason, or notification.
5. Must: `npm test` passes with no regressions.

---

## Implementation

### Step 1 — Fix retries-exhausted path in processManagedSessionStartRetries

**File:** `coordinator.ts`

In `processManagedSessionStartRetries()`, replace the entire `if (nextFailedAttempts >= MANAGED_SESSION_START_MAX_ATTEMPTS) { ... }` block (lines 306–331 inclusive). Current code to replace:

```typescript
if (nextFailedAttempts >= MANAGED_SESSION_START_MAX_ATTEMPTS) {
  emit({
    event: 'session_start_failed',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    run_id: claim.run_id,
    task_ref: claim.task_ref,
    agent_id: claim.agent_id,
    payload: {
      reason: 'worker session could not be launched in assigned worktree after bounded retries',
      code: 'ERR_SESSION_START_FAILED',
      working_directory: getRunWorktree(STATE_DIR, claim.run_id)?.worktree_path ?? undefined,
    },
  });
  finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
    success: false,
    failureReason: 'session_start_failed: worker session could not be launched in assigned worktree',
    failureCode: 'ERR_SESSION_START_FAILED',
    policy: 'requeue',
  });
  if (agent.status !== 'offline') {
    await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
  }
  console.error(`[coordinator] Failed to start session for '${claim.agent_id}': bounded retries exhausted`);
  continue;
}
```

Replace with:

```typescript
if (nextFailedAttempts >= MANAGED_SESSION_START_MAX_ATTEMPTS) {
  const failReason = ready.reason ?? 'worker session could not be launched in assigned worktree';
  emit({
    event: 'session_start_failed',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    run_id: claim.run_id,
    task_ref: claim.task_ref,
    agent_id: claim.agent_id,
    payload: {
      reason: failReason,
      code: 'ERR_SESSION_START_FAILED',
      working_directory: getRunWorktree(STATE_DIR, claim.run_id)?.worktree_path ?? undefined,
    },
  });
  finishRun(STATE_DIR, claim.run_id, claim.agent_id, {
    success: false,
    failureReason: `session_start_failed: ${failReason}`,
    failureCode: 'ERR_SESSION_START_FAILED',
    policy: 'requeue',
  });
  if (agent.status !== 'offline') {
    await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
  }
  appendNotification(STATE_DIR, {
    type: 'SESSION_START_FAILED',
    task_ref: claim.task_ref,
    run_id: claim.run_id,
    agent_id: claim.agent_id,
    reason: failReason,
    failed_at: new Date().toISOString(),
    dedupe_key: `session_start_failed:${claim.run_id}`,
  });
  console.error(`[coordinator] Failed to start session for '${claim.agent_id}': bounded retries exhausted — ${failReason}`);
  continue;
}
```

### Step 2 — Fix initial dispatch failure path

**File:** `coordinator.ts`

In the dispatch loop, find the `if (!ready.ok || !agent.session_handle || agent.status === 'offline')` block (around line 946). Inside it, there is a nested `if (isManagedSlot(...))` branch that handles managed slots (sets retry state and returns). The code to modify is the **else path** — the non-managed-slot `finishRun` call that comes after the managed-slot `if`. It currently reads:

```typescript
finishRun(STATE_DIR, runId, agent.agent_id, {
  success: false,
  failureReason: 'session_start_failed: worker session could not be launched in assigned worktree',
  failureCode: 'ERR_SESSION_START_FAILED',
  policy: 'requeue',
});
if (agent.status !== 'offline') {
  await cleanupRunCapacity(agent.agent_id, workerPoolConfig);
}
return;
```

Replace with (keep the `return` at the end, add `appendNotification` before it):

```typescript
const failReason = ready.reason ?? 'worker session could not be launched in assigned worktree';
finishRun(STATE_DIR, runId, agent.agent_id, {
  success: false,
  failureReason: `session_start_failed: ${failReason}`,
  failureCode: 'ERR_SESSION_START_FAILED',
  policy: 'requeue',
});
if (agent.status !== 'offline') {
  await cleanupRunCapacity(agent.agent_id, workerPoolConfig);
}
appendNotification(STATE_DIR, {
  type: 'SESSION_START_FAILED',
  task_ref: taskRef,
  run_id: runId,
  agent_id: agent.agent_id,
  reason: failReason,
  failed_at: new Date().toISOString(),
  dedupe_key: `session_start_failed:${runId}`,
});
return;
```

**Invariant:** `appendNotification` belongs inside `if (!ready.ok ...)` before the `return`, NOT inside the outer `catch (err)` block at the bottom of the dispatch lambda (which handles `dispatch_error` — a different failure path).

---

## Acceptance criteria

- [ ] `coordinator.ts`: both `finishRun` calls for `ERR_SESSION_START_FAILED` use `ready.reason` in `failureReason`.
- [ ] The `session_start_failed` event payload at retries-exhausted includes `ready.reason` (not the hardcoded string).
- [ ] Both failure paths call `appendNotification` with `type: 'SESSION_START_FAILED'` and a `dedupe_key`.
- [ ] The fallback string when `ready.reason` is `undefined` is `'worker session could not be launched in assigned worktree'` (backward-compatible).
- [ ] `npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

The coordinator dispatch loop is not directly unit-tested. Verify via source inspection:

```bash
grep -n 'SESSION_START_FAILED\|failReason\|ready\.reason' coordinator.ts
```

Expected: `SESSION_START_FAILED` appears in both the event payload and `appendNotification` calls; `ready.reason` is used in `failReason` construction in both paths.

---

## Verification

```bash
grep -n 'failureReason.*session_start_failed\|SESSION_START_FAILED' coordinator.ts
# Expected: failureReason uses template literal with failReason variable (not hardcoded string)
```

```bash
nvm use 24 && npm test
```
