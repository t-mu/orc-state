---
ref: runtime-robustness/62-requeue-backoff
title: "Add exponential backoff delay before requeued tasks become eligible"
status: done
feature: runtime-robustness
task_type: implementation
priority: high
depends_on: []
---

# Task 62 — Add Exponential Backoff for Requeued Tasks

Independent.

## Scope

**In scope:**
- Add `requeue_eligible_after` field to task type and schema.
- Set exponential backoff timestamp on task failure/requeue.
- Check eligibility in task scheduler before dispatch.
- Clear backoff on manual `task-reset`.

**Out of scope:**
- Per-provider or per-task configurable backoff.
- Changes to the `blocked` transition (max attempts still triggers block).
- Backoff for infrastructure failures (dispatch errors, session start failures).

---

## Context

### Current state

When a task fails and is requeued (policy=requeue), it immediately becomes eligible for re-dispatch. If the failure is environmental (provider down, rate limit), this creates a rapid retry storm consuming all worker capacity across multiple ticks.

### Desired state

Requeued tasks have a `requeue_eligible_after` timestamp set to `now + backoff`. The backoff increases exponentially with attempt count: 30s → 60s → 120s → 240s → 480s (then blocked at attempt 5). The task scheduler skips tasks whose `requeue_eligible_after` is in the future.

### Start here

- `lib/claimManager.ts` — `finishRun()` failure path where `attempt_count` is incremented
- `lib/taskScheduler.ts` — task eligibility checks
- `types/backlog.ts` — task type definition

**Affected files:**
- `types/backlog.ts` — add `requeue_eligible_after?: string` field
- `schemas/backlog.schema.json` — add field to schema
- `lib/claimManager.ts` — set backoff timestamp on requeue
- `lib/taskScheduler.ts` — check `requeue_eligible_after` in eligibility
- `cli/task-reset.ts` — clear `requeue_eligible_after` on manual reset

---

## Goals

1. Must add `requeue_eligible_after` optional field to task type and JSON schema.
2. Must set backoff timestamp on task failure with requeue policy.
3. Must use exponential backoff: `30_000 * 2^(attempt_count - 1)`, capped at 600,000ms (10 min).
4. Must skip ineligible tasks in scheduler dispatch planning.
5. Must clear `requeue_eligible_after` on manual `task-reset`.
6. Must not apply backoff for infrastructure failure codes (ERR_DISPATCH_FAILURE, ERR_SESSION_START).

---

## Implementation

### Step 1 — Add field to type and schema

**File:** `types/backlog.ts`

Add to the task interface:
```typescript
requeue_eligible_after?: string; // ISO timestamp
```

**File:** `schemas/backlog.schema.json`

Add to task properties:
```json
"requeue_eligible_after": {
  "type": "string",
  "format": "date-time"
}
```

### Step 2 — Set backoff on requeue

**File:** `lib/claimManager.ts`

In the failure path where `attempt_count` is incremented and task is set back to `todo`, add:

```typescript
const INFRA_FAILURE_CODES = ['ERR_DISPATCH_FAILURE', 'ERR_SESSION_START'];
if (!INFRA_FAILURE_CODES.includes(failureCode)) {
  const backoffMs = Math.min(30_000 * Math.pow(2, task.attempt_count - 1), 600_000);
  task.requeue_eligible_after = new Date(Date.now() + backoffMs).toISOString();
}
```

### Step 3 — Check eligibility in scheduler

**File:** `lib/taskScheduler.ts`

In the task eligibility filter, add:
```typescript
if (task.requeue_eligible_after && new Date(task.requeue_eligible_after) > new Date()) {
  continue; // still in backoff period
}
```

### Step 4 — Clear on manual reset

**File:** `cli/task-reset.ts`

After resetting task status to `todo`, clear the backoff:
```typescript
delete task.requeue_eligible_after;
```

---

## Acceptance criteria

- [ ] Requeued tasks are not eligible for dispatch until backoff expires.
- [ ] Backoff increases exponentially: 30s, 60s, 120s, 240s, 480s.
- [ ] Backoff is capped at 600s (10 minutes).
- [ ] Infrastructure failures (ERR_DISPATCH_FAILURE, ERR_SESSION_START) do not apply backoff.
- [ ] `task-reset` clears the backoff field.
- [ ] Schema validation passes with the new field.
- [ ] `npm test` passes.
- [ ] `orc doctor` exits 0.

---

## Tests

Add to `lib/claimManager.test.ts`:

```typescript
it('sets requeue_eligible_after with exponential backoff on task failure', () => { ... });
it('does not set backoff for infrastructure failure codes', () => { ... });
it('caps backoff at 600s', () => { ... });
```

Add to `lib/taskScheduler.test.ts`:

```typescript
it('skips tasks with requeue_eligible_after in the future', () => { ... });
it('includes tasks with requeue_eligible_after in the past', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/claimManager.test.ts lib/taskScheduler.test.ts
```

```bash
nvm use 24 && npm test
```

```bash
orc doctor
# Expected: exits 0, schema validates with new field
```

---

## Risk / Rollback

**Risk:** Existing `backlog.json` files without the field are fine (field is optional). Adding the schema field is backwards-compatible.
**Rollback:** Revert affected files. Remove `requeue_eligible_after` from any modified `backlog.json` if needed.
