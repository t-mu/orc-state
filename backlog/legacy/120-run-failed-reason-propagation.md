---
ref: orch/task-120-run-failed-reason-propagation
epic: orch
status: done
---

# Task 120 — Surface run_failed Reason in TASK_COMPLETE Notification

Independent.

## Scope

**In scope:**
- `coordinator.mjs` — `processTerminalRunEvents`: forward `failure_reason` and `exit_code` from `run_failed` events into the notify-queue entry
- `lib/masterNotifyQueue.mjs` — add optional `failure_reason` and `exit_code` fields to the notification entry written by `appendNotification`
- `cli/master-check.mjs` — print `failure_reason` / `exit_code` when present
- All three master bootstrap templates — update TASK_COMPLETE display format
- `orchestrator/coordinator.test.mjs` — verify failure reason propagation
- `lib/masterNotifyQueue.test.mjs` — verify new optional fields

**Out of scope:**
- Changing `claimManager.mjs` failure reason recording (already correct)
- Adding failure reasons to `run_cancelled` events (covered by Task 118)
- Changing the worker bootstrap or worker CLI commands

---

## Context

When a run fails, `claimManager.finishRun()` emits a `run_failed` event with:

```js
payload: {
  failure_reason: 'exit_code_nonzero' | 'max_attempts_exceeded' | ...,
  exit_code: number,
  policy: 'requeue' | 'block',
}
```

However, `coordinator.processTerminalRunEvents()` deposits only:

```js
appendNotification(stateDir, {
  type: 'TASK_COMPLETE',
  task_ref,
  agent_id,
  success: false,
  finished_at: ts,
});
```

The `failure_reason` and `exit_code` fields are discarded. The master receives `success: false` but cannot tell the operator *why* the task failed without manually grepping `events.jsonl`. This makes incident diagnosis unnecessarily hard.

**Affected files:**
- `coordinator.mjs` — `processTerminalRunEvents`
- `lib/masterNotifyQueue.mjs` — `appendNotification` and notification schema
- `cli/master-check.mjs` — display logic
- `orchestrator/coordinator.test.mjs` — existing failure tests
- `lib/masterNotifyQueue.test.mjs`
- All three `templates/master-bootstrap-*-v1.txt`

---

## Goals

1. Must forward `failure_reason` from the `run_failed` event payload into the master-notify-queue entry.
2. Must forward `exit_code` from the `run_failed` event payload into the entry (may be `null` if absent).
3. Must print `failure_reason` and `exit_code` in `master-check.mjs` output when present.
4. Must not break existing notify-queue entries that lack these fields (backward-compatible read).
5. Must update master bootstrap template so the TASK_COMPLETE display block shows reason when `success: false`.

---

## Implementation

### Step 1 — Forward reason in processTerminalRunEvents

**File:** `coordinator.mjs`

```js
// Before:
appendNotification(stateDir, {
  type: 'TASK_COMPLETE', task_ref, agent_id,
  success: false, finished_at: ts,
}, { lockAlreadyHeld: true });

// After:
appendNotification(stateDir, {
  type: 'TASK_COMPLETE', task_ref, agent_id,
  success: false,
  ...(event.payload?.failure_reason != null ? { failure_reason: event.payload.failure_reason } : {}),
  ...(event.payload?.exit_code != null ? { exit_code: event.payload.exit_code } : {}),
  finished_at: ts,
}, { lockAlreadyHeld: true });
```

### Step 2 — No schema change needed in masterNotifyQueue

**File:** `lib/masterNotifyQueue.mjs`

`appendNotification` already spreads the passed object into the entry. No structural change needed — the new fields are optional and will be written if present. Add a JSDoc comment noting the optional fields:

```js
/**
 * @param {object} notification
 * @param {string} notification.task_ref
 * @param {boolean} notification.success
 * @param {string} [notification.failure_reason]  — present when success=false
 * @param {number} [notification.exit_code]       — present when success=false and exit code is known
 */
```

### Step 3 — Print reason in master-check.mjs

**File:** `cli/master-check.mjs`

```js
// When printing each notification:
if (!n.success) {
  const reason = n.failure_reason ? ` (${n.failure_reason}` +
    (n.exit_code != null ? `, exit ${n.exit_code}` : '') + ')' : '';
  console.log(`  ✗ FAILED${reason}: ${n.task_ref}`);
} else {
  console.log(`  ✓ done: ${n.task_ref}`);
}
```

### Step 4 — Update master bootstrap templates

**Files:** all three `master-bootstrap-*-v1.txt`

Update the TASK_COMPLETE block example:

```
[ORCHESTRATOR] TASK_COMPLETE
  Task:    <task_ref>
  Worker:  <agent_id>
  Result:  ✓ success | ✗ failed (<failure_reason>, exit <exit_code>)
  Time:    <ISO timestamp>
```

---

## Acceptance criteria

- [ ] A `run_failed` event with `failure_reason: "exit_code_nonzero"` produces a notify-queue entry with `failure_reason: "exit_code_nonzero"`.
- [ ] A `run_failed` event with `exit_code: 1` produces a notify-queue entry with `exit_code: 1`.
- [ ] A `run_finished` (success) event produces a notify-queue entry with no `failure_reason` or `exit_code` fields.
- [ ] `master-check.mjs` prints failure reason and exit code when present.
- [ ] `master-check.mjs` output is unchanged for successful completions.
- [ ] Existing notify-queue entries without `failure_reason` are read without error.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `orchestrator/coordinator.test.mjs`:

```js
it('processTerminalRunEvents forwards failure_reason from run_failed event');
it('processTerminalRunEvents forwards exit_code from run_failed event');
it('processTerminalRunEvents omits failure_reason for run_finished events');
```

**File:** `lib/masterNotifyQueue.test.mjs`:

```js
it('appendNotification stores failure_reason and exit_code when provided');
it('readPendingNotifications returns entries with and without failure_reason');
```

---

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```
