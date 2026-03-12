# Task 33 — Fix Cross-Process Session Probing (GC / clearall / attach)

Critical correctness fix. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Fix `heartbeatProbe` in all three adapter implementations so it returns `true` for a
  handle with valid format + present API key, even if the handle is not in the local Map
- Add a descriptive error/notice to `orc-attach` when a session is not in the local Map
- Add tests for the cross-process heartbeat behaviour
- Update `contracts.md` to document the cross-process limitation and the new heartbeat semantics

**Out of scope:**
- Implementing full persistent session storage (writing conversation history to disk) — that
  is a larger architectural change deferred to a future task
- Changing `gc-workers.mjs` or `clear-workers.mjs` beyond the adapter fix
- Changing `coordinator.mjs`

---

## Context

Provider adapters (`claude.mjs`, `codex.mjs`, `gemini.mjs`) store session state in an
in-memory `Map<sessionHandle, { messages, model, systemPrompt }>`. This Map lives only
in the coordinator's process.

`orc-worker-gc` and `orc-worker-clearall` create new adapter instances in separate processes.
These fresh instances have empty Maps. `heartbeatProbe(handle)` returns:

```js
return sessions.has(sessionHandle) && Boolean(apiKey);
// sessions is always empty → always false
```

Both GC tools therefore mark **every non-offline worker as dead** and remove it, even when
the coordinator's session is healthy. This is a false-positive removal that corrupts the
agent registry.

`orc-attach` has the same problem: it creates a fresh adapter and calls `adapter.attach()`,
which prints `(no messages yet)` for any handle not in the local Map.

**Fix strategy (without full persistence):**

Change `heartbeatProbe` to use a two-tier check:
1. If the handle IS in the local sessions Map → use existing check: `sessions.has && Boolean(apiKey)`
2. If the handle is NOT in the local Map → check if the handle is format-valid (`<provider>:<uuid>`)
   AND the API key env var is present → return `true` (we cannot confirm the session is alive,
   but we should not assume it is dead just because we don't know about it)

This prevents false-positive GC removals. The trade-off: a genuinely dead session with a
valid handle format will not be probed-as-dead from external processes. The coordinator's
own `heartbeatProbe` is unaffected (it has the sessions Map populated).

For `orc-attach`: print a diagnostic notice when the session history is unavailable from
an external process, rather than the misleading `(no messages yet)`.

**Affected files:**
- `adapters/claude.mjs` — update `heartbeatProbe`
- `adapters/codex.mjs` — update `heartbeatProbe`
- `adapters/gemini.mjs` — update `heartbeatProbe`
- `cli/attach.mjs` — add diagnostic when session not available cross-process
- `orchestrator/contracts.md` — document cross-process limitation
- `adapters/adapters.test.mjs` — new tests

---

## Goals

1. Must return `true` from `heartbeatProbe` when the handle is format-valid and the API key
   is present, even if the handle is not in the local sessions Map
2. Must still return `false` when the API key env var is absent regardless of handle format
3. Must still return `true` when the handle IS in the local Map and the API key is present
   (existing coordinator behaviour unchanged)
4. Must print a clear diagnostic when `orc-attach` is called from outside the coordinator
   process and the session history is unavailable
5. Must document the cross-process limitation in `contracts.md`
6. Must not change `coordinator.mjs`, `gc-workers.mjs`, or `clear-workers.mjs`

---

## Implementation

### Step 1 — Add a handle format validator helper

All three adapters need the same validation logic. Add a small helper inside each adapter
file (or extract to a shared module — one approach is to inline it since it's two lines):

```js
// Handle format: "<provider>:<uuid>" e.g. "claude:3f2a3c4d-1234-..."
// UUID v4: 8-4-4-4-12 hex chars separated by hyphens
const HANDLE_FORMAT_RE = /^[a-z]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isFormatValidHandle(handle) {
  return typeof handle === 'string' && HANDLE_FORMAT_RE.test(handle);
}
```

### Step 2 — Update `heartbeatProbe` in `claude.mjs`

**File:** `adapters/claude.mjs`

```js
// Before:
async heartbeatProbe(sessionHandle) {
  return sessions.has(sessionHandle) && Boolean(apiKey);
},

// After:
async heartbeatProbe(sessionHandle) {
  if (sessions.has(sessionHandle)) {
    return Boolean(apiKey);
  }
  // Cross-process probe: handle not in local Map (different process from coordinator).
  // Return true if the handle looks valid and the API key is present.
  // We cannot confirm the session is alive, but we must not assume it is dead.
  return isFormatValidHandle(sessionHandle) && Boolean(apiKey);
},
```

### Step 3 — Update `heartbeatProbe` in `codex.mjs`

**File:** `adapters/codex.mjs`

Apply the identical change as Step 2 (with `openai:` handle prefix expectation implicit
in `HANDLE_FORMAT_RE`).

### Step 4 — Update `heartbeatProbe` in `gemini.mjs`

**File:** `adapters/gemini.mjs`

Apply the identical change as Step 2.

### Step 5 — Update `attach.mjs` with a cross-process notice

**File:** `cli/attach.mjs`

The current code calls `adapter.attach(agent.session_handle)` which calls `console.log(last?.content ?? '(no messages yet)')`. When called from outside the coordinator, `last` is always undefined because the fresh adapter's Map is empty.

Update `attach.mjs` to detect this case and print a diagnostic:

```js
// After resolving agent + adapter, before calling adapter.attach():
// Check whether this is likely a cross-process invocation.
const alive = await adapter.heartbeatProbe(agent.session_handle);
if (!alive) {
  console.error(`Session ${agent.session_handle} is not reachable (API key missing or session invalid).`);
  process.exit(1);
}

// Print the session handle info + call attach (will show "(no messages yet)" cross-process)
console.error(`Note: orc-attach reads session history from the coordinator process memory.`);
console.error(`If the coordinator is running, conversation history is available only within that process.`);
console.error(`Showing last known response (may be empty if called from a separate process):`);
adapter.attach(agent.session_handle);
```

### Step 6 — Update `contracts.md`

**File:** `orchestrator/contracts.md`

Add a section under `## Session Handles`:

```md
### Cross-process session probing

Session history (conversation messages) lives in the coordinator process's in-memory adapter
state. It is not persisted to disk between coordinator restarts.

When `heartbeatProbe` is called from a separate process (e.g., `orc-worker-gc`):
- If the session handle is in the caller's adapter Map → uses in-memory liveness check.
- If the session handle is NOT in the Map → returns `true` if handle format is valid and
  the API key env var is present. This prevents false-positive GC removals.

`orc-attach` will display `(no messages yet)` when called from outside the coordinator
process, because the session message history is not accessible cross-process. This is
expected behaviour — the tool is primarily useful when embedded in the coordinator process
itself or when persistent session storage is implemented.
```

### Step 7 — Add tests

**File:** `adapters/adapters.test.mjs`

```js
describe('heartbeatProbe cross-process behaviour', () => {
  it('returns true for a format-valid handle not in sessions Map when API key is set', async () => {
    const adapter = createClaudeAdapter({ apiKey: 'test-key' });
    // Do not call adapter.start() — handle is not in the Map.
    const result = await adapter.heartbeatProbe('claude:3f2a3c4d-1234-5678-abcd-ef1234567890');
    expect(result).toBe(true);
  });

  it('returns false for a format-valid handle when API key is absent', async () => {
    const adapter = createClaudeAdapter({ apiKey: '' });
    const result = await adapter.heartbeatProbe('claude:3f2a3c4d-1234-5678-abcd-ef1234567890');
    expect(result).toBe(false);
  });

  it('returns false for a malformed handle', async () => {
    const adapter = createClaudeAdapter({ apiKey: 'test-key' });
    const result = await adapter.heartbeatProbe('not-a-valid-handle');
    expect(result).toBe(false);
  });

  it('returns true for a handle that IS in the sessions Map with API key', async () => {
    const adapter = createClaudeAdapter({ apiKey: 'test-key', clientFactory: mockFactory });
    const { session_handle } = await adapter.start('agent-1', {});
    expect(await adapter.heartbeatProbe(session_handle)).toBe(true);
  });
});
```

---

## Acceptance criteria

- [ ] `heartbeatProbe` returns `true` for a format-valid handle not in local Map when API key is present
- [ ] `heartbeatProbe` returns `false` for a format-valid handle when API key is absent
- [ ] `heartbeatProbe` returns `false` for a malformed or empty handle
- [ ] `heartbeatProbe` returns `true` for a handle in the local Map with API key (existing behaviour)
- [ ] `orc-worker-gc` and `orc-worker-clearall` no longer remove workers with valid handles + present API key
- [ ] `orc-attach` prints a cross-process notice before calling `adapter.attach()`
- [ ] `contracts.md` documents the cross-process limitation
- [ ] All existing tests pass; new adapter tests pass

---

## Tests

Add to `adapters/adapters.test.mjs` — cross-process heartbeat section with
at minimum 4 tests as described in Step 7 above. Run for all three adapters (claude, codex,
gemini) to ensure consistency.

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

```bash
# Verify gc-workers no longer removes live workers in a separate process
# (manual test — register a worker with a valid session_handle format, run orc-worker-gc,
# verify the worker is still registered)
ANTHROPIC_API_KEY=test-key ORCH_STATE_DIR=/tmp/orc-test-gc node cli/gc-workers.mjs
# Expected: no workers removed if their handles are format-valid
```
