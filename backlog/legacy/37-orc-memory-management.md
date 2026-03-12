# Task 37 — Memory Management: Conversation History Trimming and Nudge Map Cleanup

High severity reliability fix. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Implement a sliding-window message history in all three adapters (`claude.mjs`, `codex.mjs`,
  `gemini.mjs`) — keep the first 2 messages (system bootstrap) + the last N exchanges
- Clear completed run entries from `runStartNudgeAtMs` and `runInactiveNudgeAtMs` in
  `coordinator.mjs` when a `run_finished` or `run_failed` event is processed
- Add configuration constant `MAX_HISTORY_MESSAGES` (default: 40) in each adapter factory
- Add tests for history trimming and nudge map cleanup

**Out of scope:**
- Persistent session storage (separate task)
- Implementing LLM-based history summarisation
- Changing how the coordinator dispatches or routes tasks

---

## Context

### Issue 1: Unbounded conversation history

Each adapter maintains a `session.messages[]` array. Every `send()` call appends two entries:
the user message and the assistant response. After 100 tasks there could be 200 entries. A
single long response might be 50,000 tokens. After 50 tasks, the `messages.create()` API call
would send 2.5M+ tokens of history — far exceeding the model's context window, causing
a 400 error and requeuing the task.

The fix: after each `send()`, if `messages.length > MAX_HISTORY_MESSAGES`, trim to keep
the system bootstrap (first 2 messages: `session.systemPrompt` is sent as the `system`
parameter separately in Claude, but for Codex the first message is a system role message)
plus the most recent N exchanges.

For Claude: conversation history does not include the system message (it's passed separately),
so we simply keep the last `MAX_HISTORY_MESSAGES` messages from `messages[]`.

For Codex: the system message is prepended in `send()` but NOT stored in `session.messages`.
So we also keep the last `MAX_HISTORY_MESSAGES` from `messages[]`.

For Gemini: apply the same pattern.

### Issue 2: `runStartNudgeAtMs` / `runInactiveNudgeAtMs` accumulate for completed runs

The coordinator clears these maps only when it observes a run that is no longer in
`claimed`/`in_progress` state during the *next* tick's lifecycle enforcement pass.
However, runs that finish mid-tick (via `run_finished` in `recordAdapterResponseEvents`)
leave entries in the maps until the next tick processes them. Over many thousands of
completed runs, these maps grow without bound.

The fix: clear entries immediately when processing `run_finished` or `run_failed` events in
`recordAdapterResponseEvents`.

**Affected files:**
- `adapters/claude.mjs` — add history trimming
- `adapters/codex.mjs` — add history trimming
- `adapters/gemini.mjs` — add history trimming
- `coordinator.mjs` — clear nudge maps on run_finished/run_failed events

---

## Goals

1. Must trim `session.messages[]` to at most `MAX_HISTORY_MESSAGES` entries after each `send()`
2. Must preserve the most recent messages (last N) when trimming — do not truncate from the end
3. Must make `MAX_HISTORY_MESSAGES` configurable via the adapter factory options (default: 40)
4. Must clear `runStartNudgeAtMs.get(runId)` and `runInactiveNudgeAtMs.get(runId)` when a
   `run_finished` or `run_failed` event is processed for that `runId`
5. Must not change the API call itself — trimming happens to the in-memory history only
6. Must not break existing adapter tests

---

## Implementation

### Step 1 — Add history trimming in `claude.mjs`

**File:** `adapters/claude.mjs`

Add `maxHistory` to the factory options (default: 40):

```js
export function createClaudeAdapter({
  apiKey = process.env.ANTHROPIC_API_KEY,
  model = 'claude-sonnet-4-6',
  clientFactory = defaultClientFactory,
  maxHistory = 40,
} = {}) {
```

After `session.messages.push({ role: 'assistant', content: responseText })` in `send()`,
add trimming:

```js
// Trim history to maxHistory most-recent messages.
// For Claude, the system prompt is passed separately — messages[] is user/assistant turns only.
if (session.messages.length > maxHistory) {
  session.messages = session.messages.slice(session.messages.length - maxHistory);
}
return responseText;
```

### Step 2 — Apply the same to `codex.mjs`

**File:** `adapters/codex.mjs`

Same pattern: add `maxHistory = 40` to factory options. After the assistant response push,
trim `session.messages` to last `maxHistory` entries.

Note: the Codex adapter prepends the system message in `send()` itself before the API call
(`messages = session.systemPrompt ? [{ role: 'system', ... }, ...session.messages] : session.messages`).
The system message is NOT stored in `session.messages`, so trimming `session.messages` is safe.

### Step 3 — Apply to `gemini.mjs`

**File:** `adapters/gemini.mjs`

Same pattern. Check how the Gemini adapter stores history and apply equivalent trimming.

### Step 4 — Add nudge map cleanup in `coordinator.mjs`

**File:** `coordinator.mjs`

In `recordAdapterResponseEvents`, inside the `switch` block, add cleanup to the
`run_finished` and `run_failed` cases:

```js
case 'run_finished':
  finishRun(STATE_DIR, effectiveRunId, effectiveAgentId, { success: true });
  runStartNudgeAtMs.delete(effectiveRunId);
  runInactiveNudgeAtMs.delete(effectiveRunId);
  break;

case 'run_failed': {
  const failureReason = ev.payload?.reason ?? ev.reason ?? 'worker reported failure';
  const failureCode = ev.payload?.code ?? 'ERR_WORKER_REPORTED_FAILURE';
  const policy = ev.payload?.policy ?? 'requeue';
  finishRun(STATE_DIR, effectiveRunId, effectiveAgentId, {
    success: false, failureReason, failureCode, policy,
  });
  runStartNudgeAtMs.delete(effectiveRunId);
  runInactiveNudgeAtMs.delete(effectiveRunId);
  break;
}
```

Also clear the maps when `finishRun` is called for timeout-based finishes in
`enforceRunStartLifecycle` and `enforceInProgressLifecycle`:

```js
// After finishRun(...) call in enforceRunStartLifecycle timeout block:
runStartNudgeAtMs.delete(claim.run_id);

// After finishRun(...) call in enforceInProgressLifecycle timeout block:
runInactiveNudgeAtMs.delete(claim.run_id);
```

(These deletions may already exist in the current code — verify and add if missing.)

### Step 5 — Add tests for history trimming

**File:** `adapters/adapters.test.mjs`

```js
describe('claude adapter — history trimming', () => {
  it('trims messages to maxHistory after many send() calls', async () => {
    const adapter = createClaudeAdapter({
      apiKey: 'test',
      clientFactory: mockFactory, // returns 'ok' for every call
      maxHistory: 4, // small limit for testing
    });
    const { session_handle } = await adapter.start('agent', {});
    // Send 5 messages — should result in exactly 4 messages kept (last 2 pairs)
    for (let i = 0; i < 5; i++) {
      await adapter.send(session_handle, `message ${i}`);
    }
    // Verify next send still works (no error from overly long history)
    await expect(adapter.send(session_handle, 'still works')).resolves.toBeDefined();
  });

  it('does not trim when under maxHistory', async () => {
    // 1 send() call = 2 messages — below maxHistory=40 default
    // verify all messages are preserved
  });
});
```

### Step 6 — Add tests for nudge map cleanup

**File:** `e2e/orchestrationLifecycle.e2e.test.mjs`

```js
it('clears nudge map entries when run_finished is processed', async () => {
  // Manually set a runStartNudgeAtMs entry for a run_id.
  // Mock adapter returns a response with run_finished for that run_id.
  // After recordAdapterResponseEvents, assert the entry is gone from the map.
  // (Access via coordinator module's exported Map or spy on Map.delete)
});
```

---

## Acceptance criteria

- [ ] After more than `maxHistory` messages are accumulated, `session.messages.length` never exceeds `maxHistory`
- [ ] The most recent messages are preserved (oldest are discarded) — trim from front, not end
- [ ] `maxHistory` is configurable per adapter instance via factory options
- [ ] `run_finished` events clear the corresponding entry from both nudge maps
- [ ] `run_failed` events clear the corresponding entry from both nudge maps
- [ ] Timeout-based `finishRun` calls in lifecycle enforcement also clear nudge map entries
- [ ] All existing adapter tests pass
- [ ] New trimming tests pass

---

## Tests

`adapters/adapters.test.mjs` — history trimming tests for all three adapters.

`e2e/orchestrationLifecycle.e2e.test.mjs` — nudge map cleanup test.

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

```bash
# Confirm maxHistory option present in each adapter
grep -n 'maxHistory' adapters/claude.mjs
grep -n 'maxHistory' adapters/codex.mjs
grep -n 'maxHistory' adapters/gemini.mjs

# Confirm nudge map cleanup in run_finished/run_failed
grep -n 'runStartNudgeAtMs.delete\|runInactiveNudgeAtMs.delete' coordinator.mjs
# Expected: at least 4 occurrences (run_finished, run_failed, and two timeout sites)
```
