---
ref: general/31-review-submitted-event-type
feature: general
priority: normal
status: done
---

# Task 31 — Add `review_submitted` Event Type and Validation

Independent. Blocks Tasks 32 and 33.

## Scope

**In scope:**
- `types/events.ts` — add `ReviewSubmittedEvent` interface and add it to the `OrcEvent` union
- `lib/progressValidation.ts` — register `review_submitted` in `SUPPORTED_EVENTS`; exempt it from the `in_progress` claim requirement

**Out of scope:**
- Any CLI files
- Any changes to the coordinator or state machine
- `AGENTS.md`

---

## Context

Workers spawn two sub-agent reviewers after committing implementation work. Currently reviewers return findings only as conversation text. If the worker's context gets compacted while waiting, those findings are permanently lost and the review round cannot be recovered.

The fix is to persist reviewer findings as SQLite events. This task adds the event type that makes that possible. Tasks 32 and 33 build the CLI surface on top.

### Current state

No `review_submitted` event type exists. There is no durable way for a reviewer sub-agent to record its findings in the orchestrator event store.

### Desired state

A `review_submitted` event can be appended to the SQLite event store. It carries the reviewer's `agent_id` (unique per reviewer), an `outcome` of `approved` or `findings`, and the full findings text. The event is valid after `work_complete` — it does not require the claim to be in `in_progress` state.

### Start here

- `types/events.ts` — find the `OrcEvent` union (near line 275) and study `RunFailedEvent` as the closest structural analogue
- `lib/progressValidation.ts` — `SUPPORTED_EVENTS` set (line ~3) and `EVENTS_REQUIRING_IN_PROGRESS` set

**Affected files:**
- `types/events.ts` — new interface + union member
- `lib/progressValidation.ts` — set additions

---

## Goals

1. Must: `ReviewSubmittedEvent` interface is added to `types/events.ts` with fields `event: 'review_submitted'`, `run_id: string`, `agent_id: string`, and `payload: { outcome: 'approved' | 'findings'; findings: string }`. No `task_ref` or `reviewer_index`.
2. Must: `ReviewSubmittedEvent` is added to the `OrcEvent` union type.
3. Must: `'review_submitted'` is added to `SUPPORTED_EVENTS` in `progressValidation.ts`.
4. Must: `'review_submitted'` is NOT added to `EVENTS_REQUIRING_IN_PROGRESS` — review submission is valid after `work_complete`.
5. Must: `tsc --noEmit` passes (type-check clean).
6. Must: `npm test` passes with no regressions.
7. Must: no files modified outside the stated scope.

---

## Implementation

### Step 1 — Add `ReviewSubmittedEvent` to `types/events.ts`

**File:** `types/events.ts`

Add the interface near the other run-scoped event types (e.g. after `WorkCompleteEvent`):

```typescript
export interface ReviewSubmittedEvent extends BaseEvent {
  event: 'review_submitted';
  run_id: string;
  agent_id: string;
  payload: {
    outcome: 'approved' | 'findings';
    findings: string;
  };
}
```

Then add `| ReviewSubmittedEvent` to the `OrcEvent` union.

### Step 2 — Register in `progressValidation.ts`

**File:** `lib/progressValidation.ts`

Add `'review_submitted'` to `SUPPORTED_EVENTS`. Do not add it to `EVENTS_REQUIRING_IN_PROGRESS`, `EVENTS_REQUIRING_PHASE`, or `EVENTS_REQUIRING_REASON`.

---

## Acceptance criteria

- [ ] `ReviewSubmittedEvent` interface exists in `types/events.ts` with exactly the fields specified above — no `task_ref`, no `reviewer_index`.
- [ ] `OrcEvent` union includes `ReviewSubmittedEvent`.
- [ ] `'review_submitted'` appears in `SUPPORTED_EVENTS`.
- [ ] `'review_submitted'` does NOT appear in `EVENTS_REQUIRING_IN_PROGRESS`.
- [ ] `tsc --project tsconfig.check.json --noEmit` exits 0.
- [ ] `npm test` passes.
- [ ] No changes outside `types/events.ts` and `lib/progressValidation.ts`.

---

## Verification

```bash
grep -n 'review_submitted\|ReviewSubmittedEvent' types/events.ts lib/progressValidation.ts
# Expected: interface definition, union member, SUPPORTED_EVENTS entry
```

```bash
nvm use 24 && npm test
```
