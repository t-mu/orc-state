---
ref: runtime-robustness/60-input-wait-timeout
title: "Add secondary timeout for claims stuck in awaiting_input"
status: done
feature: runtime-robustness
task_type: implementation
priority: high
depends_on: []
---

# Task 60 — Add Secondary Timeout for Awaiting Input Claims

Independent.

## Scope

**In scope:**
- Add `INPUT_WAIT_TIMEOUT_MS` constant (default 1 hour).
- Modify `_expireLeasesCore()` to expire `awaiting_input` claims that exceed this timeout.
- Ensure expired input claims are requeued with reason `ERR_INPUT_TIMEOUT`.

**Out of scope:**
- Changes to `run-input-request.ts` polling behavior.
- Changes to the input-respond path.
- Adding configurable timeout per task.

---

## Context

### Current state

In `lib/claimManager.ts` `_expireLeasesCore()`, claims with `input_state === 'awaiting_input'` are unconditionally skipped during lease expiry. If the master agent crashes or loses context and never responds, the task deadlocks permanently. Manual intervention via `orc task-reset` is required.

### Desired state

Claims in `awaiting_input` are still protected from normal lease expiry, but a secondary timeout (default 1 hour) causes them to expire if the input wait exceeds the threshold. The task is requeued with `ERR_INPUT_TIMEOUT` reason, allowing automatic retry.

### Start here

- `lib/claimManager.ts` — `_expireLeasesCore()`, the `awaiting_input` skip condition
- `lib/constants.ts` — timeout constants
- `lib/workerLifecycleReducer.ts` — verify `input_requested_at` is set on input state transition

**Affected files:**
- `lib/constants.ts` — add `INPUT_WAIT_TIMEOUT_MS`
- `lib/claimManager.ts` — modify `_expireLeasesCore()` skip logic

---

## Goals

1. Must add `INPUT_WAIT_TIMEOUT_MS` constant (default 3,600,000 ms = 1 hour).
2. Must allow `awaiting_input` claims within the timeout to remain protected from expiry.
3. Must expire `awaiting_input` claims that exceed the timeout.
4. Must set failure reason to `ERR_INPUT_TIMEOUT` on expiry.
5. Must not change behavior for claims not in `awaiting_input` state.

---

## Implementation

### Step 1 — Add constant

**File:** `lib/constants.ts`

```typescript
export const INPUT_WAIT_TIMEOUT_MS = 3_600_000; // 1 hour
```

### Step 2 — Modify awaiting_input skip logic

**File:** `lib/claimManager.ts` — `_expireLeasesCore()`

Replace the blanket skip:
```typescript
if (claim.input_state === 'awaiting_input') continue;
```

With a time-bounded skip:
```typescript
if (claim.input_state === 'awaiting_input') {
  const inputRequestedAt = claim.input_requested_at
    ? new Date(claim.input_requested_at).getTime()
    : new Date(claim.last_heartbeat_at ?? claim.claimed_at).getTime();
  if (now - inputRequestedAt < INPUT_WAIT_TIMEOUT_MS) continue;
  // else fall through to normal expiry — input wait exceeded
}
```

Ensure the failure reason for these expirations is set to `ERR_INPUT_TIMEOUT`.

### Step 3 — Verify input_requested_at is set

Check `workerLifecycleReducer.ts` to confirm that the `input_requested` event handler sets `input_requested_at` on the claim. If not, add it there.

---

## Acceptance criteria

- [ ] Claims in `awaiting_input` within 1 hour are NOT expired.
- [ ] Claims in `awaiting_input` exceeding 1 hour ARE expired with `ERR_INPUT_TIMEOUT`.
- [ ] Expired input claims are requeued (not blocked, unless at max attempts).
- [ ] Normal lease expiry for non-input claims is unchanged.
- [ ] `npm test` passes.
- [ ] No changes outside `lib/constants.ts` and `lib/claimManager.ts` (and `workerLifecycleReducer.ts` if `input_requested_at` is missing).

---

## Tests

Add to `lib/claimManager.test.ts`:

```typescript
it('does not expire awaiting_input claims within INPUT_WAIT_TIMEOUT_MS', () => { ... });
it('expires awaiting_input claims exceeding INPUT_WAIT_TIMEOUT_MS with ERR_INPUT_TIMEOUT', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/claimManager.test.ts
```

```bash
nvm use 24 && npm test
```
