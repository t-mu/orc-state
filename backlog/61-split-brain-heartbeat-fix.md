---
ref: runtime-robustness/61-split-brain-heartbeat-fix
title: "Reject heartbeat on expired or requeued claims to prevent split-brain"
status: done
feature: runtime-robustness
task_type: implementation
priority: critical
depends_on: []
---

# Task 61 — Reject Heartbeat on Expired or Requeued Claims

Independent.

## Scope

**In scope:**
- Heartbeat must verify the claim is still active before extending the lease.
- If the claim was already expired/failed/requeued, heartbeat must return an error signal.
- `cli/run-heartbeat.ts` must exit non-zero when the lease was already expired.

**Out of scope:**
- Changes to lease duration or expiry logic.
- Worker-side background heartbeat loop changes (worker will naturally stop on exit code 1).
- Coordinator-side lease expiry changes.

---

## Context

### Current state

A worker can call `orc run-heartbeat` to extend a lease that the coordinator has already expired in a previous tick. The heartbeat succeeds because it only checks `claim.state` is `claimed` or `in_progress`, not whether `lease_expires_at` is already past. This creates a split-brain scenario: the worker continues working while the coordinator has requeued the task and potentially dispatched it to another worker.

### Desired state

Heartbeat checks whether the lease has already expired (i.e., `lease_expires_at < now`). If so, it rejects the heartbeat with a clear error. The worker's background heartbeat loop sees exit code 1 and stops, signaling the worker to abandon work. This prevents two workers from operating on the same task.

### Start here

- `lib/claimManager.ts` — `heartbeat()` function
- `lib/workerLifecycleReducer.ts` — heartbeat case in reducer
- `cli/run-heartbeat.ts` — CLI entry point

**Affected files:**
- `lib/workerLifecycleReducer.ts` — add lease expiry check in heartbeat reducer
- `lib/claimManager.ts` — propagate expired signal from heartbeat
- `cli/run-heartbeat.ts` — exit 1 with clear message on expired lease

---

## Goals

1. Must reject heartbeat when `lease_expires_at < now` at time of heartbeat call.
2. Must reject heartbeat when claim state is `failed` (already expired by coordinator).
3. Must return a distinguishable error/signal so the CLI can detect the rejection.
4. Must cause `cli/run-heartbeat.ts` to exit with code 1 and print "lease expired" message.
5. Must not change behavior for valid heartbeats on active claims.
6. Must not introduce new race conditions (the check and update must be within the same lock).

---

## Implementation

### Step 1 — Add lease expiry check in reducer

**File:** `lib/workerLifecycleReducer.ts`

In the heartbeat case of the reducer, before extending the lease, add:

```typescript
if (claim.state === 'failed') {
  return { ...claim, _heartbeat_rejected: 'claim_failed' };
}
if (claim.lease_expires_at && new Date(claim.lease_expires_at).getTime() < Date.now()) {
  return { ...claim, _heartbeat_rejected: 'lease_expired' };
}
```

The `_heartbeat_rejected` field is a transient signal consumed by the caller, not persisted.

### Step 2 — Propagate rejection in claimManager

**File:** `lib/claimManager.ts`

In `heartbeat()`, after applying the reducer, check for `_heartbeat_rejected`:

```typescript
if (updatedClaim._heartbeat_rejected) {
  const reason = updatedClaim._heartbeat_rejected;
  delete updatedClaim._heartbeat_rejected;
  return { success: false, reason };
}
```

Return a result object `{ success: boolean; reason?: string }` instead of void.

### Step 3 — Handle rejection in CLI

**File:** `cli/run-heartbeat.ts`

Check the return value from heartbeat:

```typescript
const result = heartbeat(STATE_DIR, runId, agentId);
if (!result.success) {
  console.error(`heartbeat rejected: ${result.reason} — worker should stop`);
  process.exit(1);
}
```

---

## Acceptance criteria

- [ ] Heartbeat on a claim with `lease_expires_at` in the past is rejected.
- [ ] Heartbeat on a claim with state `failed` is rejected.
- [ ] `cli/run-heartbeat.ts` exits 1 with descriptive message on rejection.
- [ ] Valid heartbeats on active claims continue to work unchanged.
- [ ] The check and lease extension happen within the same lock acquisition.
- [ ] `npm test` passes.
- [ ] No changes outside `lib/workerLifecycleReducer.ts`, `lib/claimManager.ts`, and `cli/run-heartbeat.ts`.

---

## Tests

Add to `lib/claimManager.test.ts`:

```typescript
it('rejects heartbeat when lease_expires_at is in the past', () => { ... });
it('rejects heartbeat when claim state is failed', () => { ... });
it('accepts heartbeat when lease is still valid', () => { ... });
```

Add to `cli/run-reporting.test.ts` (or new file):

```typescript
it('run-heartbeat exits 1 when lease expired', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/claimManager.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Workers that are slightly late on heartbeat (e.g., heartbeat at 29:59, lease at 30:00) could be falsely rejected. The 4.5-minute heartbeat interval vs 30-minute lease provides a 25+ minute buffer, making this extremely unlikely.
**Rollback:** Revert the three affected files.
