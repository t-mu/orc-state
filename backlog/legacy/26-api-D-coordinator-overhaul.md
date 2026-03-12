# Task D — Coordinator Dispatch Loop Overhaul

Depends on Tasks A, B, and C. Blocks Task F (e2e test updates).

## Scope

**In scope:**
- Change `coordinator.mjs` dispatch so `adapter.send()` return value is parsed for
  `[ORC_EVENT]` lines using `parseOrcEvents()` from `responseParser.mjs`
- Change `buildSessionBootstrap()` to pass bootstrap text as `system_prompt` in
  `adapter.start()` config instead of sending it as a separate message
- Change the nudge mechanism: nudges become follow-up `adapter.send()` calls whose
  responses are also parsed (for API-backed workers)
- Change `ensureSessionReady()` to skip the separate bootstrap `send()` call
- Add SDK error handling (rate limits, network errors) → `run_failed` event + requeue
- Guard lifecycle enforcement (run-start nudges, inactivity nudges) so they only apply
  to workers without active `session_handle` in API mode; API workers complete tasks
  synchronously and do not need time-based nudges during the task call itself
- Update `coordinator.mjs` imports to include `parseOrcEvents`

**Out of scope:**
- Changing the tick interval logic or `setInterval` structure
- Removing the `cli/progress.mjs` CLI ingest path (human workers still use it)
- Changing the claim / lease / state machine in `claimManager.mjs`
- Any CLI tool changes (Task E)

---

## Context

The current dispatch loop in `coordinator.mjs` (`tick()` → `buildDispatchPlan()` loop)
sends a task envelope to an agent via `adapter.send()` which returns `Promise<void>` —
the response is never examined. Progress events arrive separately when the agent runs
`npm run orc:progress -- --event=...` on the shell.

After Tasks A+B, `adapter.send()` returns `Promise<string>` — the full agent response.
After Task C, `parseOrcEvents(responseText)` extracts embedded `[ORC_EVENT]` JSON lines.

The coordinator now needs to:
1. Await the response from `adapter.send()`
2. Feed it to `parseOrcEvents()`
3. Write each extracted event to `events.jsonl` via `appendSequencedEvent()`

The session bootstrap also changes: instead of calling `adapter.start()` and then
`adapter.send(bootstrapText)`, the coordinator passes `system_prompt: bootstrapText` in
the `config` argument to `adapter.start()`. This avoids an extra round-trip and ensures
the bootstrap instructions are applied as the system-level context (which the Anthropic,
OpenAI, and Gemini SDKs treat with higher priority than user messages).

The run-start and inactivity nudge mechanisms remain in place for human workers (no
`session_handle`). For API-backed workers the nudge paths should check whether the agent
has a `session_handle` before attempting `adapter.send()` — which is already how they
work, so the guard is already correct.

**Affected files:**
- `coordinator.mjs` — dispatch loop, `ensureSessionReady()`, imports
- No other files

---

## Goals

1. Must call `parseOrcEvents(responseText)` on the return value of every `adapter.send()`
   call and write the extracted events to `events.jsonl`
2. Must pass `system_prompt` to `adapter.start()` instead of a separate bootstrap `send()`
3. Must catch SDK errors from `adapter.send()` and emit `run_failed` + requeue (same
   handling as the existing `dispatch_error` catch block)
4. Must log each extracted event at debug level (using `log()`)
5. Must log any `parseOrcEvents` warnings at warn level
6. Must not change the `claimTask()` / `finishRun()` / `expireStaleLeases()` mechanics
7. Must add `parseOrcEvents` import from `./lib/responseParser.mjs`
8. All 224 existing orchestrator unit tests must continue to pass

---

## Implementation

### Step 1 — Add `parseOrcEvents` import

**File:** `coordinator.mjs` (top of file, with existing imports)

```js
import { parseOrcEvents } from './lib/responseParser.mjs';
```

### Step 2 — Update `ensureSessionReady()` — pass bootstrap as system prompt

**File:** `coordinator.mjs`

Current code in `ensureSessionReady()`:

```js
const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {});
await adapter.send(session_handle, buildSessionBootstrap(agent.agent_id, agent.provider));
```

Replace with:

```js
const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
  system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider),
});
```

This removes the extra `send()` call and lets the SDK apply the bootstrap as the
system-level context. No response to parse from `start()`.

### Step 3 — Update dispatch loop — parse `send()` response

**File:** `coordinator.mjs`

Current code in `tick()` → dispatch loop (lines ~284–288):

```js
await adapter.send(agent.session_handle, buildTaskEnvelope(taskRef, run_id, agent.agent_id));
await adapter.send(agent.session_handle, buildImmediateExecutionKick(taskRef, run_id, agent.agent_id));
```

Replace with a single `send()` call that awaits and parses the response:

```js
const envelopeText = buildTaskEnvelope(taskRef, run_id, agent.agent_id);
const responseText = await adapter.send(agent.session_handle, envelopeText);
const { events: parsedEvents, warnings } = parseOrcEvents(responseText);

for (const warning of warnings) {
  log(`warn: [ORC_EVENT] parse warning for ${run_id}: ${warning}`);
}
for (const ev of parsedEvents) {
  log(`event from ${agent.agent_id}: ${ev.event} (${run_id})`);
  appendSequencedEvent(STATE_DIR, {
    ts: ev.ts ?? new Date().toISOString(),
    ...ev,
    // Ensure required fields are present even if agent omitted them
    actor_type: ev.actor_type ?? 'agent',
    actor_id: ev.actor_id ?? agent.agent_id,
  });
}
```

**Remove** the `buildImmediateExecutionKick` call entirely — in API mode the task envelope
itself contains `start_immediately` instructions and there is no separate "kick". The
`buildImmediateExecutionKick` function and `buildRunStartNudge` / `buildInProgressNudge`
functions may remain in the file for now (they are still used by nudge paths for human
workers) but the kick call is removed from the dispatch path.

### Step 4 — Update nudge send() calls to parse responses

**File:** `coordinator.mjs`

In `enforceRunStartLifecycle()` and `enforceInProgressLifecycle()`, the existing nudge
`adapter.send()` calls return void currently. Update them to await and parse responses:

```js
// In enforceRunStartLifecycle():
const nudgeResponse = await adapter.send(agent.session_handle, buildRunStartNudge(claim));
const { events: nudgeEvents, warnings: nudgeWarnings } = parseOrcEvents(nudgeResponse);
for (const w of nudgeWarnings) log(`warn: nudge parse warning ${claim.run_id}: ${w}`);
for (const ev of nudgeEvents) {
  appendSequencedEvent(STATE_DIR, {
    ts: ev.ts ?? new Date().toISOString(),
    ...ev,
    actor_type: ev.actor_type ?? 'agent',
    actor_id: ev.actor_id ?? claim.agent_id,
  });
}
```

Apply the same pattern in `enforceInProgressLifecycle()` for the `buildInProgressNudge`
call.

### Step 5 — Update error handling in dispatch loop

**File:** `coordinator.mjs`

The existing catch block already handles dispatch errors by calling `finishRun()` with
`policy: 'requeue'`. No change needed — the same catch block will handle SDK errors
thrown by `adapter.send()`. Verify the existing structure handles the new single-call
pattern (it wraps the `send()` call(s), so it does).

---

## Acceptance criteria

- [ ] `parseOrcEvents` is imported from `./lib/responseParser.mjs` at top of file
- [ ] `ensureSessionReady()` passes `system_prompt` to `adapter.start()` — no separate
  bootstrap `send()` call
- [ ] Dispatch loop awaits `adapter.send()` return value and passes it to `parseOrcEvents()`
- [ ] All extracted events are written to `events.jsonl` via `appendSequencedEvent()`
- [ ] Parse warnings are logged via `log()`
- [ ] SDK errors from `adapter.send()` are caught and result in `run_failed` + requeue
- [ ] `buildImmediateExecutionKick` is no longer called in the dispatch path
- [ ] All 224 + 9 existing unit tests continue to pass (coordinator unit tests remain
  unchanged because they do not import `coordinator.mjs` directly)
- [ ] `node -e "import('./coordinator.mjs').then(() => console.log('ok'))"` →
  prints `ok` without starting the daemon

---

## Tests

No new unit tests for `coordinator.mjs` itself (it is a daemon entry point, not a library
module). The coordinator logic is covered by the e2e test updated in Task F.

To verify this task manually:

```bash
# Confirm the coordinator module can be imported cleanly
node -e "import('./coordinator.mjs').then(() => console.log('imported ok'))"

# Run full test suite (no coordinator-specific unit tests exist, but all others must pass)
nvm use 22 && npm run test:orc
```

---

## Verification

```bash
nvm use 22 && npm run test:orc
# Expected: all tests pass (224 + responseParser 9 = 233)

# Confirm no separate bootstrap send() call in ensureSessionReady
grep -A 5 "ensureSessionReady" coordinator.mjs | grep "adapter.send"
# Expected: no match (send was removed from ensureSessionReady)

# Confirm buildImmediateExecutionKick is not called in dispatch path
grep "buildImmediateExecutionKick" coordinator.mjs
# Expected: only the function definition line — no call site in tick()

# Confirm parseOrcEvents is imported
grep "parseOrcEvents" coordinator.mjs
# Expected: import line + call sites in dispatch loop and nudge paths
```

## Risk / Rollback

**Risk:** If the coordinator now awaits the full API response (which can take 30–120 s for
complex tasks), the `setInterval` tick may fire while a previous tick's `send()` is still
awaiting. This is acceptable: `setInterval` callbacks queue up but Node's event loop
serializes them. No additional mutex is needed.

**Risk:** If an agent does not embed `[ORC_EVENT] {"event":"run_started",...}` in its
response, `run_started_timeout` will eventually fire and requeue the task. The coordinator
treats missing events the same as it treats missing `orc:progress` CLI calls today.

**Rollback:** `git checkout coordinator.mjs` restores the prior version. No
state files are modified by this task.
