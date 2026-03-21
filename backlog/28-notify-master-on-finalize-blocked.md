---
ref: general/28-notify-master-on-finalize-blocked
feature: general
priority: high
status: todo
---

# Task 28 — Notify Master on blocked_finalize

Independent.

## Scope

**In scope:**
- `coordinator.ts` — add `appendNotification()` call inside `markFinalizeBlocked()` so master sees a `FINALIZE_BLOCKED` queue entry
- `lib/masterNotifyQueue.test.ts` — verify `appendNotification` is called with `type: 'FINALIZE_BLOCKED'` (or add a coordinator-level integration test)

**Out of scope:**
- Changing `markFinalizeBlocked()` logic or retry counts
- Adding auto-recovery or escalation beyond the notification
- Modifying how `orc master-check` renders notifications (it already displays all queue entries)
- Any other `blocked_finalize` handling path

---

## Context

`markFinalizeBlocked()` is called when a task's git finalization fails after all retries. It sets `finalization_state: 'blocked_finalize'` in claims state and logs to the coordinator log — but it does not queue a master notification. The master agent has no way to discover the blocked task except by polling `orc status` or watching `orc doctor`. In a fully autonomous run, the master will not know to intervene.

The `appendNotification()` function from `lib/masterNotifyQueue.ts` is already imported in `coordinator.ts` (line 36) and used in several places (input request, task failure notifications). Adding one call inside `markFinalizeBlocked()` is a minimal, targeted change.

The `dedupe_key` field prevents duplicate notifications if `markFinalizeBlocked` is somehow called multiple times for the same run (the current flow only calls it once per run, but defensive deduplication costs nothing).

### Current state

`markFinalizeBlocked()` (coordinator.ts:393–405):
```typescript
async function markFinalizeBlocked(claim, workerPoolConfig, reason) {
  try {
    setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id, {
      finalizationState: 'blocked_finalize',
      blockedReason: reason,
    });
  } catch { return false; }
  await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
  log(`run ${claim.run_id} blocked during finalization: ${reason}`);
  return true;
}
```
No notification is queued. The master has no signal.

### Desired state

After `log(...)`, `appendNotification()` is called with `type: 'FINALIZE_BLOCKED'`, making the blocked run visible via `orc master-check`.

### Start here

- `coordinator.ts:393–405` — `markFinalizeBlocked()` function
- `coordinator.ts:36` — confirm `appendNotification` is already imported
- `coordinator.ts:517–526` — example of existing `appendNotification` usage (INPUT_REQUEST pattern to follow)

**Affected files:**
- `coordinator.ts` — one new `appendNotification` call in `markFinalizeBlocked()`

---

## Goals

1. Must: `markFinalizeBlocked()` calls `appendNotification(STATE_DIR, { type: 'FINALIZE_BLOCKED', ... })` after the log line.
2. Must: the notification payload includes `task_ref`, `run_id`, `agent_id`, `reason`, and `blocked_at` (ISO timestamp).
3. Must: a `dedupe_key: \`finalize_blocked:${claim.run_id}\`` field is set to prevent duplicate entries.
4. Must: the notification is only appended when `setRunFinalizationState` succeeds (i.e., after the try/catch, not inside it).
5. Must: `npm test` passes.

---

## Implementation

### Step 1 — Add appendNotification call to markFinalizeBlocked

**File:** `coordinator.ts`

Change `markFinalizeBlocked()` from:

```typescript
async function markFinalizeBlocked(claim: Claim, workerPoolConfig: WorkerPoolConfig, reason: string) {
  try {
    setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id, {
      finalizationState: 'blocked_finalize',
      blockedReason: reason,
    });
  } catch {
    return false;
  }
  await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
  log(`run ${claim.run_id} blocked during finalization: ${reason}`);
  return true;
}
```

To:

```typescript
async function markFinalizeBlocked(claim: Claim, workerPoolConfig: WorkerPoolConfig, reason: string) {
  try {
    setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id, {
      finalizationState: 'blocked_finalize',
      blockedReason: reason,
    });
  } catch {
    return false;
  }
  await cleanupRunCapacity(claim.agent_id, workerPoolConfig);
  log(`run ${claim.run_id} blocked during finalization: ${reason}`);
  appendNotification(STATE_DIR, {
    type: 'FINALIZE_BLOCKED',
    task_ref: claim.task_ref,
    run_id: claim.run_id,
    agent_id: claim.agent_id,
    reason,
    blocked_at: new Date().toISOString(),
    dedupe_key: `finalize_blocked:${claim.run_id}`,
  });
  return true;
}
```

**Invariant:** do not move the `appendNotification` call inside the try/catch block — it must only run after `setRunFinalizationState` succeeds.

---

## Acceptance criteria

- [ ] `markFinalizeBlocked()` calls `appendNotification` with `type: 'FINALIZE_BLOCKED'` after the log line.
- [ ] The notification payload includes `task_ref`, `run_id`, `agent_id`, `reason`, `blocked_at`, and `dedupe_key`.
- [ ] `dedupe_key` is `finalize_blocked:<run_id>` (prevents duplicate entries for same run).
- [ ] If `setRunFinalizationState` throws (early return false), `appendNotification` is NOT called.
- [ ] `npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/masterNotifyQueue.test.ts` or an appropriate coordinator integration test:

```typescript
it('appendNotification with type FINALIZE_BLOCKED is idempotent via dedupe_key', () => {
  appendNotification(dir, {
    type: 'FINALIZE_BLOCKED',
    run_id: 'run-abc',
    dedupe_key: 'finalize_blocked:run-abc',
  });
  appendNotification(dir, {
    type: 'FINALIZE_BLOCKED',
    run_id: 'run-abc',
    dedupe_key: 'finalize_blocked:run-abc',
  });
  const pending = readPendingNotifications(dir);
  expect(pending.filter(e => e.type === 'FINALIZE_BLOCKED')).toHaveLength(1);
});
```

---

## Verification

```bash
npx vitest run lib/masterNotifyQueue.test.ts
```

```bash
nvm use 24 && npm test
```
