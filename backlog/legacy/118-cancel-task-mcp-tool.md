---
ref: orch/task-118-cancel-task-mcp-tool
epic: orch
status: done
---

# Task 118 — Add cancel_task MCP Tool

Independent.

## Scope

**In scope:**
- `mcp/handlers.mjs` — new `handleCancelTask` export
- `mcp/tools-list.mjs` — new `cancel_task` tool schema
- `lib/claimManager.mjs` — new `cancelClaim(stateDir, taskRef, reason)` helper (or inline in handler)
- `lib/masterNotifyQueue.mjs` — reuse `appendNotification` for cancellation notification
- `mcp/handlers.test.mjs` — new tests for all status transitions
- All three master bootstrap templates — document `cancel_task` in WRITE STATE section

**Out of scope:**
- Force-killing the worker PTY (operator must do that separately; the worker stops on next heartbeat failure)
- UI or CLI wrapper for `cancel_task` (MCP tool only)
- Changing max_attempts or retry policy logic

---

## Context

There is currently no way to cancel a dispatched task from the master. When a worker gets stuck in a long run, the operator must either wait for the lease to expire (~30 minutes), manually edit `claims.json` and `backlog.json`, or restart the coordinator. This is an operational blocker for any interactive workflow.

The mechanism is straightforward: cancelling an active claim removes it from `claims.json` and sets the task status to `blocked` with a `cancellation_reason`. On the worker's next heartbeat, the coordinator will find no matching claim and the worker will treat it as a failed run — stopping naturally.

For non-active tasks (todo/blocked), cancellation is a simple status update with no claim side-effect.

**Affected files:**
- `mcp/handlers.mjs` — new handler
- `mcp/tools-list.mjs` — new tool entry
- `lib/claimManager.mjs` — claim removal helper
- `lib/masterNotifyQueue.mjs` — notification deposit
- `mcp/handlers.test.mjs` — tests
- `templates/master-bootstrap-v1.txt`
- `templates/master-bootstrap-codex-v1.txt`
- `templates/master-bootstrap-gemini-v1.txt`

---

## Goals

1. Must cancel tasks in `todo` or `blocked` state by setting status to `blocked` with `cancellation_reason`.
2. Must cancel tasks in `claimed` or `in_progress` state by: removing the active claim, setting task status to `blocked`, emitting `run_cancelled` event, and depositing a TASK_COMPLETE notification with `success: false`.
3. Must return `{ cancelled: true, task_ref, previous_status }` on success.
4. Must return `{ error: "already_terminal", task_ref }` when task is `done` or `released`.
5. Must emit a `task_cancelled` event to `events.jsonl` for all cancellations.
6. Must be idempotent for `blocked` state (cancelling an already-blocked task is a no-op returning `{ cancelled: true }`).

---

## Implementation

### Step 1 — Add cancelClaim helper

**File:** `lib/claimManager.mjs`

```js
export function cancelClaim(stateDir, runId, reason) {
  // Called within an existing lock context.
  // Finds claim by runId, sets state='cancelled', records cancellation_reason.
  // Returns the cancelled claim or null if not found.
}
```

### Step 2 — Add handleCancelTask handler

**File:** `mcp/handlers.mjs`

```js
export function handleCancelTask(stateDir, { task_ref, reason = 'cancelled by operator', actor_id } = {}) {
  if (!task_ref) throw new Error('task_ref is required');
  const resolvedActor = actor_id ?? defaultActorId(stateDir);

  return withLock(join(stateDir, '.lock'), () => {
    const backlog = readJson(stateDir, 'backlog.json');
    const task = findTask(backlog, task_ref);
    if (!task) throw new Error(`Task not found: ${task_ref}`);

    const TERMINAL = new Set(['done', 'released']);
    if (TERMINAL.has(task.status)) {
      return { error: 'already_terminal', task_ref };
    }

    const previousStatus = task.status;
    const now = new Date().toISOString();
    const claims = readClaims(stateDir);

    // If active, remove the claim and deposit TASK_COMPLETE notification.
    if (['claimed', 'in_progress'].includes(task.status)) {
      const activeClaim = claims.claims.find(
        (c) => c.task_ref === task_ref && ['claimed', 'in_progress'].includes(c.state),
      );
      if (activeClaim) {
        activeClaim.state = 'cancelled';
        activeClaim.cancellation_reason = reason;
        atomicWriteJson(join(stateDir, 'claims.json'), claims);

        appendNotification(stateDir, {
          type: 'TASK_COMPLETE',
          task_ref,
          agent_id: activeClaim.agent_id,
          success: false,
          failure_reason: reason,
          finished_at: now,
        }, { lockAlreadyHeld: true });

        appendSequencedEvent(stateDir, {
          ts: now, event: 'run_cancelled', actor_id: resolvedActor,
          task_ref, run_id: activeClaim.run_id,
          payload: { reason },
        }, { lockAlreadyHeld: true });
      }
    }

    task.status = 'blocked';
    task.cancellation_reason = reason;
    task.updated_at = now;
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(stateDir, {
      ts: now, event: 'task_cancelled', actor_id: resolvedActor,
      task_ref, payload: { previous_status: previousStatus, reason },
    }, { lockAlreadyHeld: true });

    return { cancelled: true, task_ref, previous_status: previousStatus };
  });
}
```

### Step 3 — Register tool in tools-list.mjs

**File:** `mcp/tools-list.mjs`

```js
{
  name: 'cancel_task',
  description: 'Cancel a task regardless of current state. For active runs, removes the claim so the worker stops on next heartbeat. Returns { cancelled, task_ref, previous_status } or { error: "already_terminal" }.',
  inputSchema: {
    type: 'object',
    required: ['task_ref'],
    properties: {
      task_ref: { type: 'string', description: 'Full task ref to cancel' },
      reason: { type: 'string', description: 'Human-readable cancellation reason (default: "cancelled by operator")' },
      actor_id: { type: 'string', description: 'Defaults to master agent_id' },
    },
    additionalProperties: false,
  },
}
```

### Step 4 — Wire handler in server.mjs

**File:** `mcp/server.mjs` — import and dispatch `handleCancelTask` for tool name `cancel_task`.

### Step 5 — Update master bootstrap templates

**Files:** all three `master-bootstrap-*-v1.txt`

Add to WRITE STATE section:
```
cancel_task(task_ref, reason?, actor_id?)
  Cancels a task in any non-terminal state.
  For active runs, removes the claim; worker stops on next heartbeat.
  Returns { cancelled: true, task_ref, previous_status } or
  { error: "already_terminal" }.
```

---

## Acceptance criteria

- [ ] `cancel_task` on a `todo` task sets status to `blocked` and returns `{ cancelled: true, previous_status: "todo" }`.
- [ ] `cancel_task` on an `in_progress` task removes the active claim, emits `run_cancelled`, deposits TASK_COMPLETE with `success: false`, sets task to `blocked`.
- [ ] `cancel_task` on a `done` task returns `{ error: "already_terminal" }` and makes no state changes.
- [ ] `task_cancelled` event is appended to `events.jsonl` for every successful cancellation.
- [ ] `cancel_task` on a `blocked` task is a no-op returning `{ cancelled: true }` (idempotent).
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `mcp/handlers.test.mjs`:

```js
it('handleCancelTask cancels a todo task and sets status blocked');
it('handleCancelTask cancels an in_progress task, removes claim, deposits notification');
it('handleCancelTask returns already_terminal for done task');
it('handleCancelTask emits task_cancelled event');
it('handleCancelTask on blocked task is idempotent');
```

---

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

```bash
npm run orc:doctor
npm run orc:status
```

## Risk / Rollback

**Risk:** Removing a claim while the worker is actively running may leave the worker in an inconsistent state until its next heartbeat. The worker will attempt to call `orc-run-finish` or heartbeat and receive a claim-not-found error, which is handled gracefully.

**Rollback:** `git restore mcp/handlers.mjs mcp/tools-list.mjs lib/claimManager.mjs && npm test`
