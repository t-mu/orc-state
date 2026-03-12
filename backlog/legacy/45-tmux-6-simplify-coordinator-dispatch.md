# Task 45 — Simplify Coordinator Dispatch (Remove Response Parsing)

Depends on Tasks 41, 42, 43. This task is a surgical removal — do not refactor anything else.

---

## Scope

**In scope:**
- Remove `recordAdapterResponseEvents()` calls from the 3 `adapter.send()` sites in `coordinator.mjs`
- Remove the `recordAdapterResponseEvents()` function definition itself (lines 98–176)
- Remove the `parseOrcEvents` import (line 23) if it becomes unused
- Remove the `responseParser.mjs` import from coordinator if no longer needed

**Out of scope:**
- `recordAdapterResponseEvents` in any other file — check if used elsewhere first
- `parseOrcEvents` in `lib/responseParser.mjs` — keep the file; it may be used by other tools
- The event log polling loop (lines 426–433) — keep unchanged; still needed for lifecycle
- `enforceRunStartLifecycle`, `enforceInProgressLifecycle` — keep the nudge logic; only remove response parsing from nudge send calls
- Any other coordinator logic — do not touch

---

## Context

### Current flow (SDK adapter, to be simplified)

```
adapter.send(handle, taskEnvelope)
  → returns response string containing [ORC_EVENT] lines
  → recordAdapterResponseEvents(response, { runId, taskRef, agentId })
     → parseOrcEvents(response)  -- extracts [ORC_EVENT] lines
     → for each event: drive state machine (startRun / heartbeat / finishRun)
     → appendSequencedEvent() for each event
```

### New flow (tmux adapter)

```
adapter.send(handle, taskEnvelope)
  → returns ''  (fire-and-forget; agent drives its own state via orc CLI commands)
  → nothing to parse
```

State transitions (`startRun`, `heartbeat`, `finishRun`) now happen when the agent calls
`orc-run-start`, `orc-run-heartbeat`, `orc-run-finish`, `orc-run-fail` (Task 43).
The coordinator tick still polls `events.jsonl` to track activity for lifecycle enforcement
(the existing lines 426–433 remain unchanged).

### Exact lines to change in `coordinator.mjs`

**`recordAdapterResponseEvents` function definition: lines 98–176**
Delete the entire function.

**Import of `parseOrcEvents`: line 23**
```js
import { parseOrcEvents } from './lib/responseParser.mjs';
```
Delete this line.

**Three call sites:**

1. Run-start nudge (around line 293–298):
```js
// BEFORE:
const response = await adapter.send(agentSessionHandle, buildRunStartNudge(claimSnapshot));
recordAdapterResponseEvents(response, {
  runId: claimSnapshot.run_id,
  taskRef: claimSnapshot.task_ref,
  agentId: claimSnapshot.agent_id,
});

// AFTER:
await adapter.send(agentSessionHandle, buildRunStartNudge(claimSnapshot));
```

2. In-progress nudge (around line 364–369):
```js
// BEFORE:
const response = await adapter.send(agentSessionHandle, buildInProgressNudge(claimSnapshot));
recordAdapterResponseEvents(response, {
  runId: claimSnapshot.run_id,
  taskRef: claimSnapshot.task_ref,
  agentId: claimSnapshot.agent_id,
});

// AFTER:
await adapter.send(agentSessionHandle, buildInProgressNudge(claimSnapshot));
```

3. Task dispatch (around line 459–467):
```js
// BEFORE:
const response = await adapter.send(
  agent.session_handle,
  buildTaskEnvelope(taskRef, run_id, agent.agent_id),
);
recordAdapterResponseEvents(response, {
  runId: run_id,
  taskRef,
  agentId: agent.agent_id,
});

// AFTER:
await adapter.send(
  agent.session_handle,
  buildTaskEnvelope(taskRef, run_id, agent.agent_id),
);
```

**Important:** After removing `recordAdapterResponseEvents`, check whether `startRun`,
`heartbeat`, `finishRun` are still imported and used elsewhere in coordinator.mjs.
They are used in `enforceRunStartLifecycle` (line 271) and `enforceInProgressLifecycle`
(timeout expiry path) — keep those imports. Only `parseOrcEvents` becomes unused.

**Affected files:**
- `coordinator.mjs` — remove function + 3 call sites + 1 import

---

## Goals

1. Must remove `recordAdapterResponseEvents()` from all 3 `adapter.send()` call sites
2. Must delete the `recordAdapterResponseEvents` function definition (lines 98–176)
3. Must remove the `import { parseOrcEvents }` line if it becomes unused
4. Must NOT remove `startRun`, `heartbeat`, `finishRun` imports (still used by lifecycle enforcement)
5. Must NOT change the event log polling loop (lines 426–433)
6. Must NOT change `enforceRunStartLifecycle` or `enforceInProgressLifecycle` logic (only the send call)
7. All existing coordinator tests must still pass after this change

---

## Implementation

### Step 1 — Verify line numbers before editing

Read `coordinator.mjs` and confirm the exact lines of:
- `recordAdapterResponseEvents` function (starts line ~98, ends ~176)
- Three `adapter.send()` + `recordAdapterResponseEvents()` call pairs
- `import { parseOrcEvents }` line

Use these confirmed line numbers for all edits.

### Step 2 — Remove `parseOrcEvents` import (line 23)

Delete the line:
```js
import { parseOrcEvents } from './lib/responseParser.mjs';
```

### Step 3 — Delete `recordAdapterResponseEvents` function (lines 98–176)

Delete the entire function body including its JSDoc comment if present.

### Step 4 — Remove 3 `recordAdapterResponseEvents` call sites

For each of the 3 `adapter.send()` sites, remove the `recordAdapterResponseEvents(...)` call
(and any intermediate `const response =` variable that now has no use). Keep the
`await adapter.send(...)` call itself — it still sends the nudge/envelope text.

### Step 5 — Verify remaining imports

After edits, scan the remaining imports to confirm:
- `startRun`, `expireStaleLeases`, `claimTask`, `heartbeat`, `finishRun` — still imported and used ✓
- `parseOrcEvents` — removed ✓
- All other imports — unchanged ✓

---

## Acceptance criteria

- [ ] `recordAdapterResponseEvents` does not appear anywhere in `coordinator.mjs`
- [ ] `parseOrcEvents` is not imported in `coordinator.mjs`
- [ ] All 3 `adapter.send()` call sites are still present (just without the response parsing)
- [ ] `startRun`, `heartbeat`, `finishRun` are still imported from `claimManager.mjs`
- [ ] Event log polling (lines reading `readEvents(EVENTS_FILE)`) is unchanged
- [ ] `nvm use 22 && npm run test:orc:unit` passes

---

## Tests

No new tests needed. Existing coordinator tests mock `adapters/index.mjs` and verify
dispatch behavior — they will confirm the change doesn't break the tick loop.

---

## Verification

```bash
# Confirm no trace of the removed function
grep 'recordAdapterResponseEvents' coordinator.mjs
# Expected: no output

grep 'parseOrcEvents' coordinator.mjs
# Expected: no output

# Confirm send() calls remain
grep 'adapter.send' coordinator.mjs
# Expected: 3 matches

# Run tests
nvm use 22 && npm run test:orc:unit
```
