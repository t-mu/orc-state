---
ref: orch/task-135-add-input-requested-input-response-event-types
epic: orch
status: done
---

# Task 135 — Add input_requested and input_response Event Types to Schema

Independent. Blocks Tasks 136, 137, 138.

## Scope

**In scope:**
- `schemas/event.schema.json` — add `input_requested` and `input_response` to the `event` enum

**Out of scope:**
- Any coordinator, CLI, or MCP handler changes — those are Tasks 136–138
- Changes to any state files or runtime behaviour
- Adding payload schema validation for the new event types

---

## Context

The worker input request flow requires two new event types to be appended to `events.jsonl`. Without them, `appendSequencedEvent` will fail AJV validation when workers or the master attempt to write these events.

`input_requested` is emitted by a worker when it is blocked on an interactive prompt and needs a human decision. `input_response` is emitted by the master (via the `respond_to_input` MCP tool) when the user provides an answer.

The event schema uses an exhaustive `enum` for the `event` field — new types must be registered here before any other task in this epic can be implemented.

**Affected files:**
- `schemas/event.schema.json` — `event` enum definition

---

## Goals

1. Must add `"input_requested"` to the `event` enum in `event.schema.json`.
2. Must add `"input_response"` to the `event` enum in `event.schema.json`.
3. Must not change any other field in the schema.
4. Must pass `npm run orc:doctor` with zero validation errors after the change.
5. Must pass `nvm use 24 && npm test` with no regressions.

---

## Implementation

### Step 1 — Add new event types to enum

**File:** `schemas/event.schema.json`

Add two entries after `"input_provided"` in the existing enum array:

```json
"input_requested",
"input_response",
```

The enum block (excerpt) should read:

```json
"need_input",
"input_provided",
"input_requested",
"input_response",
"heartbeat",
```

Invariant: do not reorder or remove any existing enum values.

---

## Acceptance criteria

- [ ] `event.schema.json` enum contains `"input_requested"`.
- [ ] `event.schema.json` enum contains `"input_response"`.
- [ ] No other field in the schema is modified.
- [ ] `npm run orc:doctor` exits 0.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new test file required. The existing AJV-based schema validation in `orc:doctor` and any event validation tests will exercise the new enum values implicitly once Tasks 136–138 write events of these types.

If an event schema unit test exists (e.g. `event.schema.test.mjs`), verify it still passes — do not add new assertions for this task.

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

**Risk:** Expanding an exhaustive enum is additive and non-breaking. No existing events are affected. AJV `additionalProperties: false` is not on the enum field, so no runtime breakage expected.
**Rollback:** `git restore schemas/event.schema.json && npm run orc:doctor`
