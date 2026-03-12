---
ref: orch/task-136-add-orc-run-input-request-cli
epic: orch
status: done
---

# Task 136 — Add orc-run-input-request CLI Command

Depends on Task 135. Blocks Task 139.

## Scope

**In scope:**
- `cli/run-input-request.mjs` — new CLI: appends `input_requested` event, polls for `input_response`
- `cli/orc.mjs` — register `run-input-request` subcommand
- `orchestrator/package.json` — add `orc-run-input-request` bin entry
- `cli/run-input-request.test.mjs` — unit tests

**Out of scope:**
- Coordinator changes — Task 137
- MCP tool changes — Task 138
- Bootstrap template changes — Task 139
- Any changes to existing CLI commands

---

## Context

Workers hit interactive confirmation prompts that block their PTY session. Instead of timing out silently, they need a way to bubble the question up to the master agent and wait for an answer. This CLI is the worker-facing side of that flow.

The command appends an `input_requested` event to `events.jsonl`, then polls the same file for a matching `input_response` event (same `run_id`). When found, it prints the response value to stdout and exits 0. Workers capture the response via command substitution: `RESPONSE=$(orc-run-input-request ...)`.

A 25-minute polling timeout matches the coordinator lease window — if no response arrives before the lease expires, the worker should fail the run rather than sit past expiry.

**Affected files:**
- `cli/run-input-request.mjs` — new file
- `cli/orc.mjs` — subcommand registration
- `orchestrator/package.json` — bin entry
- `cli/run-input-request.test.mjs` — new test file

---

## Goals

1. Must append an `input_requested` event to `events.jsonl` with `run_id`, `agent_id`, and `payload.question`.
2. Must poll `events.jsonl` every 3 seconds for an `input_response` event with a matching `run_id`.
3. Must print `payload.response` to stdout and exit 0 when a matching response is found.
4. Must exit 1 with a descriptive error message after 25 minutes with no response.
5. Must exit 1 with a descriptive error message if `--run-id`, `--agent-id`, or `--question` is missing.
6. Must be registered as `run-input-request` in `orc.mjs` and as `orc-run-input-request` in `package.json` bin.

---

## Implementation

### Step 1 — Create `run-input-request.mjs`

**File:** `cli/run-input-request.mjs`

```js
#!/usr/bin/env node
import { appendSequencedEvent, readEvents } from '../lib/eventLog.mjs';
import { STATE_DIR, EVENTS_FILE } from '../lib/paths.mjs';
import { flag } from '../lib/args.mjs';

const runId    = flag('run-id');
const agentId  = flag('agent-id');
const question = flag('question');

if (!runId || !agentId || !question) {
  console.error('Usage: orc-run-input-request --run-id=<id> --agent-id=<id> --question="<text>"');
  process.exit(1);
}

// 1. Append input_requested event
appendSequencedEvent(EVENTS_FILE, {
  event: 'input_requested',
  actor_type: 'agent',
  actor_id: agentId,
  run_id: runId,
  payload: { question },
});
console.error(`[orc-run-input-request] question submitted for run ${runId}. Waiting for response...`);

// 2. Poll for input_response
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes
const deadline = Date.now() + TIMEOUT_MS;

while (Date.now() < deadline) {
  const events = readEvents(EVENTS_FILE);
  const response = events.find(
    (e) => e.event === 'input_response' && e.run_id === runId,
  );
  if (response) {
    process.stdout.write(String(response.payload?.response ?? '') + '\n');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
}

console.error(`[orc-run-input-request] timeout: no response received for run ${runId} after 25 minutes.`);
process.exit(1);
```

### Step 2 — Register subcommand in `orc.mjs`

**File:** `cli/orc.mjs`

Add to the `COMMANDS` map:
```js
'run-input-request': 'run-input-request.mjs',
```

### Step 3 — Add bin entry to `package.json`

**File:** `orchestrator/package.json`

Add to the `bin` object:
```json
"orc-run-input-request": "./cli/run-input-request.mjs"
```

---

## Acceptance criteria

- [ ] `orc-run-input-request --run-id=x --agent-id=y --question="z"` appends an `input_requested` event to `events.jsonl`.
- [ ] When a matching `input_response` event (same `run_id`) is written to `events.jsonl`, the CLI prints `payload.response` to stdout and exits 0.
- [ ] After 25 minutes with no matching response, CLI exits 1 with a descriptive message.
- [ ] Missing `--run-id`, `--agent-id`, or `--question` causes exit 1 with usage message.
- [ ] Subcommand `run-input-request` is registered in `orc.mjs`.
- [ ] `orc-run-input-request` is present in `package.json` bin.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add `cli/run-input-request.test.mjs`:

```js
it('exits 1 with usage message when required flags are missing');
it('appends input_requested event with correct run_id, agent_id, and question');
it('prints response and exits 0 when matching input_response event exists in events.jsonl');
it('exits 1 after timeout when no input_response event appears');
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

**Risk:** Polling loop reads full `events.jsonl` every 3 seconds — on very large event logs this may be slow. Acceptable for now given log rotation (Task 119) keeps file size bounded.
**Rollback:** `git restore cli/orc.mjs orchestrator/package.json && rm cli/run-input-request.mjs cli/run-input-request.test.mjs && npm test`
