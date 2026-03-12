---
ref: orch/task-137-coordinator-detect-input-requested-notify-master
epic: orch
status: done
---

# Task 137 — Coordinator Detects input_requested and Notifies Master

Depends on Task 135. Blocks Task 140.

## Scope

**In scope:**
- `coordinator.mjs` — detect `input_requested` events in the event processing loop and deposit `INPUT_REQUEST` notifications to the master notify queue

**Out of scope:**
- The `orc-run-input-request` CLI — Task 136
- The `respond_to_input` MCP tool — Task 138
- Bootstrap template changes — Task 140
- Any changes to claim lifecycle, lease expiry, or nudge logic

---

## Context

When a worker calls `orc-run-input-request`, an `input_requested` event is appended to `events.jsonl`. The coordinator's event processing loop (which already handles `run_finished` and `run_failed` via `processTerminalRunEvents`) needs to be extended to detect `input_requested` events and forward them to the master as `INPUT_REQUEST` notifications.

The master notify queue (`master-notify-queue.jsonl`) and `appendNotification` are already in place — this task wires the new event type into the existing notification pipeline.

**Affected files:**
- `coordinator.mjs` — `processTerminalRunEvents` or equivalent event loop section

---

## Goals

1. Must detect `input_requested` events in the coordinator event processing loop.
2. Must deposit an `INPUT_REQUEST` notification to `master-notify-queue.jsonl` for each detected event.
3. Must include `run_id`, `task_ref`, `agent_id`, `question` (from `payload.question`), and `asked_at` (from event `ts`) in the notification.
4. Must not deposit duplicate notifications for the same event (use `seq` or `run_id`+`ts` as dedup key).
5. Must not affect existing `run_finished` / `run_failed` / `need_input` processing.
6. Must pass `nvm use 24 && npm test` with no regressions.

---

## Implementation

### Step 1 — Extend event processing to handle `input_requested`

**File:** `coordinator.mjs`

In `processTerminalRunEvents` (or wherever `run_finished`/`run_failed` events are handled), add a branch for `input_requested`:

```js
if (event?.event === 'input_requested') {
  appendNotification(STATE_DIR, {
    type: 'INPUT_REQUEST',
    run_id: event.run_id ?? '(unknown)',
    task_ref: event.task_ref ?? '(unknown)',
    agent_id: event.agent_id ?? '(unknown)',
    question: event.payload?.question ?? '(no question provided)',
    asked_at: event.ts,
  });
}
```

Invariant: `lastProcessedSeq` already prevents re-processing events — no additional dedup needed.

---

## Acceptance criteria

- [ ] When an `input_requested` event is appended to `events.jsonl`, the coordinator deposits an `INPUT_REQUEST` notification to `master-notify-queue.jsonl` on its next tick.
- [ ] The notification contains `run_id`, `task_ref`, `agent_id`, `question`, and `asked_at`.
- [ ] The notification type field is exactly `"INPUT_REQUEST"`.
- [ ] Existing `run_finished`, `run_failed`, and `need_input` processing is unchanged.
- [ ] No duplicate notifications for the same event are deposited.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] `npm run orc:doctor` exits 0.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to the coordinator unit tests (or create `orchestrator/coordinator.input-request.test.mjs`):

```js
it('deposits INPUT_REQUEST notification when input_requested event is processed');
it('notification contains run_id, task_ref, agent_id, question, asked_at');
it('does not re-deposit notification for already-processed events');
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

**Risk:** Incorrect seq tracking could cause double-deposits or missed notifications. The existing `lastProcessedSeq` guard mitigates this — verify it is applied before the new branch.
**Rollback:** `git restore coordinator.mjs && nvm use 24 && npm test`
