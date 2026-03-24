---
ref: general/38-auto-ack-run-start-and-extend-timeout
feature: general
priority: high
status: todo
---

# Task 38 — Auto-Ack `run_started` on TASK_START Injection and Extend Kill Timer

Independent.

## Scope

**In scope:**
- Emit `run_started` automatically when the coordinator successfully writes the TASK_START payload into a worker PTY session, eliminating the need for the worker to call `orc run-start` to prevent a timeout kill
- Increase `RUN_START_TIMEOUT_MS` from 300,000 ms (5 min) to 600,000 ms (10 min) as a secondary safety net
- Make the worker's `orc run-start` call idempotent (no-op if already set) so it continues to work correctly as a belt-and-suspenders acknowledgement

**Out of scope:**
- Changes to the worker bootstrap template or AGENTS.md (covered by task 39)
- Changes to the heartbeat mechanism or lease duration
- Changes to any other timeout constants

---

## Context

When the coordinator dispatches a task, it injects a TASK_START payload into the worker's PTY session and starts a 5-minute clock. If the worker doesn't call `orc run-start` within that window, the coordinator declares `ERR_RUN_START_TIMEOUT`, kills the session via `adapter.stop()`, and requeues the task with a new run ID.

This causes false kills when the worker is alive and actively doing real work (e.g. running `npm test`, writing files) but hasn't had a chance to call `run-start` yet — Claude can't interrupt a running tool call to respond to the nudge. The result is cascading timeout loops that waste resources, generate noise, and can interrupt real work mid-task.

The fix: writing the TASK_START payload to the PTY already proves the session is alive. The coordinator should treat successful injection as the acknowledgement signal and emit `run_started` itself at that point. The worker calling `orc run-start` later becomes a harmless no-op.

### Current state

- `RUN_START_TIMEOUT_MS = 300_000` (5 min) in `coordinator.ts` line 68
- Coordinator injects TASK_START via `adapter.send()` but does not emit `run_started`
- Worker must call `orc run-start` within 5 minutes or the session is killed
- A worker blocked in a long tool call cannot respond to RUN_NUDGE in time, causing repeated kill/redispatch cycles

### Desired state

- When `adapter.send(sessionHandle, taskStartPayload)` succeeds during dispatch, the coordinator immediately calls the equivalent of `orc run-start` for that run
- `RUN_START_TIMEOUT_MS` raised to 600,000 ms (10 min) as a backstop for edge cases
- Workers calling `orc run-start` is still valid and idempotent — the claim transition to `in_progress` is already done, the duplicate call is silently accepted
- The `ERR_RUN_START_TIMEOUT` kill cycle no longer fires for live, working sessions

### Start here

- `coordinator.ts` — find the TASK_START injection call (`adapter.send`) in the dispatch path; this is where the auto-ack must be inserted
- `coordinator.ts` lines 68–71 — `RUN_START_TIMEOUT_MS` and related constants
- `lib/claimManager.ts` — `startRun()` function; confirm it is idempotent when called on an already-started claim

**Affected files:**
- `coordinator.ts` — TASK_START injection site + timeout constant
- `lib/claimManager.ts` — verify/make `startRun()` idempotent
- `coordinator.ts` or `lib/claimManager.ts` tests — add coverage for auto-ack behaviour

---

## Goals

1. Must: Coordinator emits `run_started` (transitions claim to `in_progress`) immediately after a successful `adapter.send()` of the TASK_START payload during dispatch.
2. Must: `RUN_START_TIMEOUT_MS` is 600,000 ms (10 min).
3. Must: A worker calling `orc run-start` on an already-started claim is a no-op (no error, no state corruption).
4. Must: `ERR_RUN_START_TIMEOUT` is only triggered for sessions where TASK_START injection itself failed or never happened — not for sessions that received the payload but haven't responded yet.
5. Must: Existing `run_started` event schema is unchanged — event is emitted with the same fields as before, just with `actor_id` set to `coordinator` rather than the worker agent.
6. Must: `npm test` passes with zero failures.
7. Must: `orc doctor` exits 0 after changes.

---

## Implementation

### Step 1 — Locate the TASK_START injection site in `coordinator.ts`

Find the call to `adapter.send(sessionHandle, taskStartPayload)` (or equivalent) in the dispatch path. This is where the TASK_START message is written into the worker PTY session.

### Step 2 — Emit `run_started` immediately after successful injection

Directly after the `adapter.send()` call succeeds (does not throw), call `startRun(STATE_DIR, runId, agentId)` (or whatever function `orc run-start` CLI invokes) so the claim transitions to `in_progress` and a `run_started` event is appended with `actor_id: 'coordinator'`.

```typescript
// After adapter.send() for TASK_START:
try {
  startRun(STATE_DIR, claim.run_id, claim.agent_id);
} catch {
  // Already started (worker beat us to it) — safe to ignore
}
```

### Step 3 — Make `startRun()` idempotent

In `lib/claimManager.ts`, if `startRun()` is called on a claim that already has `started_at` set, return silently instead of throwing or writing a duplicate event. This ensures the worker's own `orc run-start` call is accepted without error.

### Step 4 — Increase `RUN_START_TIMEOUT_MS`

In `coordinator.ts` around line 68:

```typescript
// Before
const RUN_START_TIMEOUT_MS = 600_000; // changed from 300_000

// Update the comment to reflect new value
```

### Step 5 — Update tests

- Add a test asserting that dispatching a task auto-emits `run_started` after TASK_START injection.
- Add a test asserting `startRun()` called twice on the same claim is idempotent.
- Update any existing test that asserts `started_at` is null after dispatch.

---

## Acceptance criteria

- [ ] After dispatch, `list_active_runs` shows `state: "in_progress"` and `started_at` is non-null without the worker calling `orc run-start`.
- [ ] Worker calling `orc run-start` on an already-started claim returns success (exit 0) with no state change.
- [ ] `RUN_START_TIMEOUT_MS` is 600,000 in source.
- [ ] No `ERR_RUN_START_TIMEOUT` fires for a run where TASK_START was successfully injected.
- [ ] `run_started` event has `actor_id: 'coordinator'` when auto-emitted; `actor_id: <agent_id>` when emitted by the worker.
- [ ] `npm test` passes.
- [ ] `orc doctor` exits 0.

---

## Tests

Add to coordinator tests or `lib/claimManager.test.ts`:

```typescript
it('auto-emits run_started after TASK_START injection', async () => {
  // dispatch a task, verify claim transitions to in_progress
  // without the worker calling orc run-start
});

it('startRun() is idempotent — second call is a no-op', () => {
  // call startRun twice on same run_id, expect no error and no duplicate event
});
```

---

## Verification

```bash
nvm use 24 && npm test
orc doctor
```
