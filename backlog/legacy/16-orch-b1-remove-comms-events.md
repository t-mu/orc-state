# Task 16 — Orchestrator B1: Remove Communication Events and Message CLI

> **Track B — Step 1 of 3.** No prerequisites. Track A (tasks 13–15) can start in parallel.

## Context

Five event types exist in the system that emit to `events.jsonl` but change no state:

```
clarification_requested
clarification_answered
review_requested
review_result
handoff_completed
```

In `lib/projection.mjs` (being deleted by A2), every one of these is a `case: break` — they are logged but never projected onto any state object. The coordinator does not react to them at all.

Their validation logic in `lib/eventValidation.mjs` spans lines 49–119 — the entire `validateCommunicationPayload` function — 70 lines of payload checks for zero coordinator behaviour:

```js
function validateCommunicationPayload(event, errors) {
  const needsPayload = [
    'task_delegated',
    'clarification_requested',
    'clarification_answered',
    'review_requested',
    'review_result',
    'handoff_completed',
  ].includes(event?.event);
  // ... 60 more lines of field validation
}
```

The sole purpose of `cli/message.mjs` is to emit these events. It has no other callers.

Additionally, `AGENT_ID_RE` is defined at line 11 as a module-level constant — which is correct — but a near-identical inline regex appears inside `validateCommunicationPayload`. After deletion the module-level constant remains canonical.

---

## Goals

1. Delete `cli/message.mjs` entirely.
2. Remove the 5 communication event types from `schemas/event.schema.json`.
3. Delete `validateCommunicationPayload` and its call site from `lib/eventValidation.mjs`.
4. Remove `task_delegated` payload validation from `validateCommunicationPayload` (the function is gone) while preserving the `task_ref` requirement that lives in `validateCoreEventInvariants`.
5. Leave `task_delegated` itself in the schema — it is still emitted by `cli/delegate-task.mjs` (refactored in B2).

---

## Step-by-Step Instructions

### Step 1 — Delete `cli/message.mjs`

Delete the file `cli/message.mjs` entirely. If a corresponding test file `cli/message.test.mjs` exists, delete it too.

### Step 2 — Update `schemas/event.schema.json`

Open `schemas/event.schema.json`. Find the `event` field's `enum` array and remove exactly these 5 values:

```
"clarification_requested"
"clarification_answered"
"review_requested"
"review_result"
"handoff_completed"
```

Leave `task_delegated` and all other event types untouched.

### Step 3 — Delete `validateCommunicationPayload` from `lib/eventValidation.mjs`

Remove the entire function body of `validateCommunicationPayload` (lines 49–119).

Remove the call to it in `validateEventObject` at the bottom of the file:

```js
// BEFORE:
export function validateEventObject(event) {
  const ok = validateSchema(event);
  const errors = ok ? [] : formatAjvErrors(validateSchema.errors);
  validateCoreEventInvariants(event, errors);
  validateCommunicationPayload(event, errors);  // ← delete this line
  return errors;
}
```

### Step 4 — Remove dead constants from `lib/eventValidation.mjs`

With `validateCommunicationPayload` gone, `REVIEW_OUTCOME_SET` (line 14) is unused. Delete that constant.

`TASK_TYPE_SET` (line 13) was used in `validateCommunicationPayload` to validate `payload.task_type`. It is now unused — delete it.

> **Verify:** grep the file for any remaining reference to `REVIEW_OUTCOME_SET` and `TASK_TYPE_SET` before deleting them. If either is used elsewhere in the file, keep it.

### Step 5 — Clean up `validateCoreEventInvariants`

`task_delegated` remains in `taskEvents` (line 123) so its `task_ref` is still required. That check stays.

The `taskEvents` Set (line 123) currently contains four values: `task_added`, `task_updated`, `task_released`, `task_delegated`. Leave this untouched — the requirement that `task_delegated` carries a `task_ref` is still valid.

### Step 6 — Run tests

```
nvm use 22 && npm test
```

Confirm that `npm run orc:status` and `npm run orc:doctor` run without errors after the schema change.

---

## Acceptance Criteria

- [ ] `cli/message.mjs` is deleted.
- [ ] `schemas/event.schema.json` does not contain `clarification_requested`, `clarification_answered`, `review_requested`, `review_result`, or `handoff_completed` in its event enum.
- [ ] `lib/eventValidation.mjs` does not contain a `validateCommunicationPayload` function.
- [ ] `validateEventObject` no longer calls `validateCommunicationPayload`.
- [ ] `REVIEW_OUTCOME_SET` and `TASK_TYPE_SET` are removed if they are no longer referenced.
- [ ] `task_delegated` is still present in the schema and still requires `task_ref` via `validateCoreEventInvariants`.
- [ ] All existing orchestrator tests pass.
