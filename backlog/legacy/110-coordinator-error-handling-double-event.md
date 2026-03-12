---
ref: orch/task-110-coordinator-error-handling-double-event
epic: orch
status: done
---

# Task 110 — Fix Coordinator Double Event Emission on Session Start Failure

Independent. Blocks none.

## Scope

**In scope:**
- `coordinator.mjs` — `ensureSessionReady()`: remove the redundant `session_start_failed` event that duplicates information already in the `agent_offline` event emitted by `markAgentOffline`

**Out of scope:**
- Changes to `markAgentOffline` itself
- Changes to any other coordinator function
- Changes to event consumers or the MCP event reader

## Context

When `adapter.start()` fails in `ensureSessionReady`, the current code calls `markAgentOffline` (which emits `agent_offline`) and then emits a second `session_start_failed` event:

```js
// coordinator.mjs lines 187-198:
} catch (err) {
  const reason = err?.message ?? String(err);
  console.error(`...`);
  markAgentOffline(agent, 'session_start_failed');  // ← emits agent_offline event
  emit({
    event: 'session_start_failed',   // ← duplicate event for the same failure
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    agent_id: agent.agent_id,
    payload: { reason },
  });
  return false;
}
```

`markAgentOffline` already sets the reason code via `reasonCode('session_start_failed')` in its payload. The second `emit` is redundant, increases event log noise, and can confuse event consumers that count failures.

The fix is to remove the redundant `emit` block. The `agent_offline` event with `code: 'ERR_SESSION_START_FAILED'` carries all the information needed.

**Affected files:**
- `coordinator.mjs` — `ensureSessionReady` catch block

## Goals

1. Must remove the `emit({ event: 'session_start_failed', ... })` call from the `ensureSessionReady` catch block.
2. Must preserve the `markAgentOffline(agent, 'session_start_failed')` call — the `agent_offline` event is the single source of truth for this failure.
3. Must preserve the `console.error` log line.
4. Must not change any other behaviour in `ensureSessionReady`.

## Implementation

### Step 1 — Remove redundant emit

**File:** `coordinator.mjs`

```js
// Before:
} catch (err) {
  const reason = err?.message ?? String(err);
  console.error(`[coordinator] Failed to start session for '${agent.agent_id}': ${reason}`);
  markAgentOffline(agent, 'session_start_failed');
  emit({
    event: 'session_start_failed',
    actor_type: 'coordinator',
    actor_id: 'coordinator',
    agent_id: agent.agent_id,
    payload: { reason },
  });
  return false;
}

// After:
} catch (err) {
  const reason = err?.message ?? String(err);
  console.error(`[coordinator] Failed to start session for '${agent.agent_id}': ${reason}`);
  markAgentOffline(agent, 'session_start_failed');
  return false;
}
```

## Acceptance criteria

- [ ] `emit({ event: 'session_start_failed', ... })` is removed from `ensureSessionReady`.
- [ ] `markAgentOffline` call is retained.
- [ ] `console.error` log is retained.
- [ ] Only one event is emitted per session-start failure (the `agent_offline` event from `markAgentOffline`).
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

No new test file required. Verify by reading the modified function and confirming only one `emit` path exists for the failure case. Existing coordinator tests must continue to pass.

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```
