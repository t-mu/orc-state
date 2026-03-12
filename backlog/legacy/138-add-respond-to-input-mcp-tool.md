---
ref: orch/task-138-add-respond-to-input-mcp-tool
epic: orch
status: done
---

# Task 138 — Add respond_to_input MCP Tool

Depends on Task 135. Blocks Task 140.

## Scope

**In scope:**
- `mcp/handlers.mjs` — implement `respond_to_input` handler
- `mcp/server.mjs` — register the new tool
- `mcp/handlers.test.mjs` — tests for the new handler

**Out of scope:**
- CLI changes — Tasks 136, 139
- Coordinator changes — Task 137
- Bootstrap template changes — Task 140
- Any changes to existing MCP tools

---

## Context

When the master agent receives an `INPUT_REQUEST` notification, the user provides an answer. The master calls `respond_to_input` to deliver that answer back to the waiting worker. The tool appends an `input_response` event to `events.jsonl`; the worker's polling CLI (`orc-run-input-request`) detects it and returns the response value to the worker.

This is the master-facing half of the input request flow. It mirrors the existing `run_finish`/`run_fail` pattern: validate the run state, append a sequenced event, return confirmation.

**Affected files:**
- `mcp/handlers.mjs` — new `respond_to_input` handler function
- `mcp/server.mjs` — tool registration
- `mcp/handlers.test.mjs` — handler tests

---

## Goals

1. Must expose a `respond_to_input` MCP tool accepting `run_id` (string, required) and `response` (string, required).
2. Must validate that a claim for the given `run_id` exists and is in an active state (`claimed` or `in_progress`).
3. Must append an `input_response` event to `events.jsonl` via `appendSequencedEvent` with `payload: { response }`.
4. Must return `{ run_id, response, delivered: true }` on success.
5. Must return a descriptive error if `run_id` is unknown or the run is not active.
6. Must pass `nvm use 24 && npm test` with no regressions.

---

## Implementation

### Step 1 — Add handler in `handlers.mjs`

**File:** `mcp/handlers.mjs`

```js
export async function respondToInput(stateDir, eventsFile, { run_id, response }) {
  if (!run_id || typeof run_id !== 'string') throw new Error('run_id is required');
  if (response === undefined || response === null) throw new Error('response is required');

  // Validate run is active
  const claims = readJson(stateDir, 'claims.json');
  const claim = (claims.claims ?? []).find((c) => c.run_id === run_id);
  if (!claim) throw new Error(`No active claim found for run_id: ${run_id}`);
  if (!['claimed', 'in_progress'].includes(claim.status)) {
    throw new Error(`Run ${run_id} is not active (status: ${claim.status})`);
  }

  appendSequencedEvent(eventsFile, {
    event: 'input_response',
    actor_type: 'agent',
    actor_id: 'master',
    run_id,
    task_ref: claim.task_ref,
    agent_id: claim.agent_id,
    payload: { response: String(response) },
  });

  return { run_id, response: String(response), delivered: true };
}
```

### Step 2 — Register tool in `server.mjs`

**File:** `mcp/server.mjs`

Register `respond_to_input` with schema:
```js
{
  name: 'respond_to_input',
  description: 'Deliver a response to a worker blocked on an input_requested event.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id:   { type: 'string', description: 'The run_id of the blocked worker run.' },
      response: { type: 'string', description: 'The answer to deliver to the worker.' },
    },
    required: ['run_id', 'response'],
  },
}
```

---

## Acceptance criteria

- [ ] `respond_to_input` MCP tool is registered and callable.
- [ ] Calling with a valid active `run_id` appends an `input_response` event to `events.jsonl`.
- [ ] Returned value is `{ run_id, response, delivered: true }`.
- [ ] Calling with an unknown `run_id` returns a descriptive error.
- [ ] Calling with an inactive (done/failed) `run_id` returns a descriptive error.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] `npm run orc:doctor` exits 0.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `mcp/handlers.test.mjs`:

```js
it('respond_to_input appends input_response event with correct run_id and response');
it('respond_to_input returns { run_id, response, delivered: true } on success');
it('respond_to_input throws when run_id is not found in claims');
it('respond_to_input throws when run is not in active state');
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

**Risk:** Appending an `input_response` event for an already-answered run_id would cause the worker CLI to pick up a stale response on a future poll. The active-state guard prevents this for completed runs, but concurrent double-calls are not guarded. Acceptable for now.
**Rollback:** `git restore mcp/handlers.mjs mcp/server.mjs mcp/handlers.test.mjs && nvm use 24 && npm test`
