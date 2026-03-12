# Task A — Redesign the Adapter Interface for API-Based Operation

Blocks Tasks B, C, D, E. Must be completed first.

## Scope

**In scope:**
- Rewrite the JSDoc contract in `adapters/interface.mjs`
- Change `send()` return type from `Promise<void>` to `Promise<string>` (returns response text)
- Respecify `attach()` as "print last response to stdout" — no interactive terminal required
- Update `assertAdapterContract()` to verify the new interface signatures
- Update `adapters/index.mjs` JSDoc to reflect new method semantics
- Update `adapters/adapters.test.mjs` to match new interface

**Out of scope:**
- Actual SDK implementations (Task B)
- Coordinator changes (Task D)
- Removing tmux utilities from existing adapters (Task B)

---

## Context

All three current adapters (`codex.mjs`, `claude.mjs`, `gemini.mjs`) share a 5-method
interface defined in `interface.mjs`. That interface was designed around tmux:

- `send()` returns `Promise<void>` because tmux paste is fire-and-forget
- `attach()` interactively replaces the current process stdio via `tmux attach`
- `heartbeatProbe()` inspects a tmux process name

In the API world, `send()` returns the full response text (synchronously from the caller's
perspective). The coordinator reads that text to extract progress events rather than polling
`events.jsonl`. `attach()` has no tmux equivalent, so it becomes a "print last response"
convenience — useful for debugging and log inspection. The rest of the interface is
semantically compatible.

This task changes only the interface definition and the abstract contract check. Existing
adapter implementations continue to compile and pass their tests — they will be replaced in
Task B.

**Affected files:**
- `adapters/interface.mjs` — contract doc + `assertAdapterContract()`
- `adapters/index.mjs` — JSDoc on `createAdapter()`
- `adapters/adapters.test.mjs` — update `assertAdapterContract` tests; add
  `send()` return type expectations in existing adapter tests

---

## Goals

1. Must document the 5 adapter methods with their API-era semantics in `interface.mjs`
2. Must make `send()` return `Promise<string>` (the response text from the provider)
3. Must make `attach()` synchronous and non-interactive: print last response to stdout
4. Must leave `start()`, `heartbeatProbe()`, and `stop()` signatures unchanged
5. Must update `assertAdapterContract()` so it can still detect missing methods
6. Must not break existing adapter tests that check contract compliance
7. Must add a test verifying that `send()` on a mock adapter returns a string

---

## Implementation

### Step 1 — Rewrite `interface.mjs`

**File:** `adapters/interface.mjs`

Replace the entire file content with the updated contract and contract checker:

```js
/**
 * Provider Adapter Contract — API Edition
 *
 * All adapter factories must return an object implementing these five methods.
 * Provider-specific state (conversation history, SDK clients, session UUIDs)
 * lives inside the adapter; the core only ever sees `session_handle` and
 * `provider_ref`.
 *
 * ─── Method signatures ────────────────────────────────────────────────────
 *
 * start(agentId, config) → Promise<{ session_handle, provider_ref }>
 *   Initialize a new agent session (SDK client + conversation context).
 *   config: { system_prompt?, model?, ...providerExtras }
 *   session_handle: opaque string used for subsequent operations.
 *                   Recommended format: "<provider>:<uuid>"
 *                   Example: "claude:3f2a...", "openai:7b1c...", "gemini:9e4d..."
 *   provider_ref:   adapter-internal metadata (opaque to orchestrator core).
 *
 * send(sessionHandle, text) → Promise<string>
 *   Send a prompt to the agent session and return the full response text.
 *   The response text may contain [ORC_EVENT] JSON lines which the coordinator
 *   will extract and write to events.jsonl.
 *   Throws if sessionHandle is unknown or if the SDK call fails.
 *
 * attach(sessionHandle) → void  (synchronous)
 *   Print the most recent assistant response for this session to stdout.
 *   Used for debugging and log inspection. Must not throw if there are no
 *   messages yet — print "(no messages yet)" instead.
 *   Adapters that cannot retrieve history should print a descriptive notice.
 *
 * heartbeatProbe(sessionHandle) → Promise<boolean>
 *   Return true if the session is alive and the API key is present/valid.
 *   Returns false (not throw) on any failure.
 *
 * stop(sessionHandle) → Promise<void>
 *   Tear down the session and release associated resources (e.g. clear
 *   conversation history from memory). No-op if session not found.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Throws if adapter is missing any required interface method.
 * Call this in tests and factory functions to catch misconfigured adapters.
 */
export function assertAdapterContract(adapter) {
  for (const method of ['start', 'send', 'attach', 'heartbeatProbe', 'stop']) {
    if (typeof adapter[method] !== 'function') {
      throw new Error(`Adapter missing required method: ${method}`);
    }
  }
}
```

### Step 2 — Update JSDoc in `adapters/index.mjs`

**File:** `adapters/index.mjs`

Update the JSDoc comment on `createAdapter()` to mention the new `send()` return type:

```js
/**
 * Create a provider adapter by name.
 *
 * @param {'codex'|'claude'|'gemini'} provider
 * @param {object} options  Passed to the adapter factory (apiKey, model, etc.)
 * @returns Adapter object satisfying the interface contract.
 *          adapter.send() returns Promise<string> — the full response text.
 */
export function createAdapter(provider, options = {}) {
  // ... existing body unchanged ...
}
```

### Step 3 — Update `adapters.test.mjs` — assertAdapterContract section

**File:** `adapters/adapters.test.mjs`

The existing `assertAdapterContract` tests already cover the method presence check and
remain valid. Add one new test that verifies a compliant mock adapter's `send()` must
return a string-like value (catches adapters that return void):

```js
// In the describe('assertAdapterContract') block:

it('accepts adapter where send() returns a string', async () => {
  const adapter = {
    start: async () => ({ session_handle: 'test:1', provider_ref: {} }),
    send: async () => 'response text',
    attach: () => {},
    heartbeatProbe: async () => true,
    stop: async () => {},
  };
  expect(() => assertAdapterContract(adapter)).not.toThrow();
  await expect(adapter.send('test:1', 'hi')).resolves.toBe('response text');
});
```

---

## Acceptance criteria

- [ ] `interface.mjs` documents all 5 methods with API-era semantics
- [ ] `send()` JSDoc states it returns `Promise<string>` (the response text)
- [ ] `attach()` JSDoc states "print last response to stdout; no interactive terminal"
- [ ] `assertAdapterContract()` still validates all 5 method names are present
- [ ] All 224 existing orchestrator tests pass unchanged
- [ ] New test `accepts adapter where send() returns a string` passes
- [ ] No changes to `codex.mjs`, `claude.mjs`, `gemini.mjs`, or `coordinator.mjs`

---

## Tests

Add to `adapters/adapters.test.mjs` inside `describe('assertAdapterContract')`:

```js
it('accepts adapter where send() returns a string', async () => {
  const adapter = {
    start: async () => ({ session_handle: 'test:1', provider_ref: {} }),
    send: async () => 'response text',
    attach: () => {},
    heartbeatProbe: async () => true,
    stop: async () => {},
  };
  expect(() => assertAdapterContract(adapter)).not.toThrow();
  await expect(adapter.send('test:1', 'hi')).resolves.toBe('response text');
});

it('throws when a method is missing', () => {
  // existing test — keep as-is
});
```

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

Expected: all 224 + 1 new test = 225 tests pass, 0 failed.

```bash
# Verify no tmux references leaked into interface.mjs
grep -i tmux adapters/interface.mjs
# Expected: no output
```
