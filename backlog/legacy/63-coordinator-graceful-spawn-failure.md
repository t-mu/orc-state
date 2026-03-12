# Task 63 — Coordinator Graceful Failure on PTY Spawn Error

No dependencies. Independent of Tasks 59–62.

---

## Scope

**In scope:**
- `coordinator.mjs` — wrap `adapter.start()` call in `ensureSessionReady()` with try/catch; mark agent offline on failure; emit error event
- `e2e/orchestrationLifecycle.e2e.test.mjs` — add a test for the failure path

**Out of scope:**
- `adapters/pty.mjs` — do not modify
- CLI scripts — do not modify
- Binary installation — that is Tasks 59–61

---

## Context

The coordinator calls `adapter.start(agentId, config)` inside `ensureSessionReady()` to spawn a worker's PTY session. With the pty adapter, `pty.spawn(binary, [])` can fail if:

- The binary is not installed (most common case)
- The binary is installed but crashes immediately on startup
- `node-pty` encounters a system-level error (e.g. too many open file descriptors)

Currently, an uncaught error from `adapter.start()` would crash the coordinator's async tick and could leave the coordinator in a broken state where it retries the same failing spawn on every tick.

This task wraps the call so:
1. The error is caught and logged
2. The agent is marked `offline` in `agents.json` so the coordinator stops retrying immediately
3. An `[ORC_EVENT]` error entry is appended to `events.jsonl` for observability
4. The coordinator tick continues normally for other agents

### Why mark offline immediately

`ensureSessionReady()` is gated by `agent.session_handle === null`. If the spawn fails and we don't update the agent, the coordinator will retry on every tick (every ~5 s) — creating a spin loop that fills `events.jsonl` with error entries. Marking offline stops the retry until a human intervenes (e.g. installs the binary and runs `orc-worker-start-session`).

**Affected files:**
- `coordinator.mjs`
- `e2e/orchestrationLifecycle.e2e.test.mjs`

---

## Goals

1. `ensureSessionReady()` catches errors from `adapter.start()`.
2. On error: logs the error message to `console.error`, marks the agent `status: 'offline'` in `agents.json`, appends an error event to `events.jsonl`.
3. The coordinator does NOT crash or stop its tick loop.
4. The coordinator does NOT retry a spawn for an `offline` agent on the next tick (existing `selectDispatchableAgents` already filters offline agents — verify this holds).
5. A test verifies that when `adapter.start()` throws, the coordinator marks the agent offline.

---

## Implementation

### Locate `ensureSessionReady` in `coordinator.mjs`

Find the function that calls `adapter.start()` for agents with `session_handle === null`. It looks roughly like:

```js
async function ensureSessionReady(agent) {
  const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
    system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider, agent.role),
  });
  updateAgentRuntime(STATE_DIR, agent.agent_id, {
    status:            'running',
    session_handle,
    provider_ref,
    last_heartbeat_at: new Date().toISOString(),
    last_status_change_at: new Date().toISOString(),
  });
}
```

Wrap the body:

```js
async function ensureSessionReady(agent) {
  try {
    const { session_handle, provider_ref } = await adapter.start(agent.agent_id, {
      system_prompt: buildSessionBootstrap(agent.agent_id, agent.provider, agent.role),
    });
    updateAgentRuntime(STATE_DIR, agent.agent_id, {
      status:               'running',
      session_handle,
      provider_ref,
      last_heartbeat_at:    new Date().toISOString(),
      last_status_change_at: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.error(`[coordinator] Failed to start session for '${agent.agent_id}': ${msg}`);
    updateAgentRuntime(STATE_DIR, agent.agent_id, {
      status:               'offline',
      last_status_change_at: new Date().toISOString(),
    });
    appendSequencedEvent(STATE_DIR, {
      type:     'session_start_failed',
      agent_id: agent.agent_id,
      reason:   msg,
    });
  }
}
```

**Note:** Read `coordinator.mjs` before editing — the actual function name, call site, and imports may differ slightly. Adjust accordingly.

---

## Acceptance criteria

- [ ] When `adapter.start()` throws, `agents.json` shows the agent as `offline`.
- [ ] An event of type `session_start_failed` appears in `events.jsonl`.
- [ ] The coordinator's tick loop continues after the failure (other agents are still processed).
- [ ] The coordinator does not retry spawning the failed agent on subsequent ticks (it remains `offline` until manually restarted via `orc-worker-start-session`).
- [ ] `npm run test:orc:unit && npm run test:orc:e2e` passes.

---

## Tests

Add to `e2e/orchestrationLifecycle.e2e.test.mjs`:

```js
it('marks agent offline when adapter.start() throws — coordinator does not crash', async () => {
  // Seed worker with session_handle: null
  // Mock adapter.start() to throw new Error('binary not found')
  // Run coordinator tick
  // Assert: agent.status === 'offline'
  // Assert: events.jsonl contains session_start_failed event
  // Assert: coordinator tick completes without rethrowing
});
```

---

## Verification

```bash
nvm use 24 && npm run test:orc:unit && npm run test:orc:e2e

# Manual smoke:
# Seed an agent with provider 'fakeprovider', session_handle: null
# Start coordinator
# Check events.jsonl for session_start_failed
# Check agents.json for status: offline
```
