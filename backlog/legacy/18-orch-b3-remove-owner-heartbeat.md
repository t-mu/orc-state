# Task 18 — Orchestrator B3: Remove Owner Heartbeat Machinery and Simplify Progress Path

> **Track B — Step 3 of 3.** Requires Task 17 (B2) to be complete first.

## Context

The owner heartbeat system was designed to detect dead agent sessions. It works by running `runtime/worker-runtime.mjs` as a wrapper process alongside each agent; the wrapper writes `owner_last_seen_at` to `agents.json` every 30 seconds. The coordinator checks `isOwnerHeartbeatStale()` to skip dispatch to agents whose wrapper has stopped.

In `lib/agentRegistry.mjs` (lines 53–67), five `owner_*` fields are written on every agent registration:

```js
const entry = {
  ...
  owner_session_id: null,
  owner_tty:        null,
  owner_pid:        null,
  owner_last_seen_at: null,
  session_bound:    false,
  ...
};
```

The lease expiry mechanism in `claimManager.mjs` already handles dead agents without any heartbeat — a claimed task whose 30-minute lease expires is requeued regardless of session state. The owner heartbeat adds a second, weaker detection path that requires an external process to function.

`lib/completionGate.mjs` requires workers to pass `--confirm-ac=N` where `N` must equal the `acceptance_criteria` array length before `run_finished` is accepted. In `cli/progress.mjs`, a gate failure causes `finishRun` with `success: false`. This creates a failure mode for correct submissions that include the wrong count, without providing correctness guarantees.

`lib/progressValidation.mjs` (line 35) currently reads `claims.json` from disk internally:

```js
export function validateProgressInput(stateDir, input) {
  ...
  const claim = findClaimByRunId(stateDir, runId);
  ...
}
```

This makes it impure and untestable without a real state directory.

---

## Goals

1. Delete `runtime/worker-runtime.mjs`, `lib/sessionOwner.mjs`, `lib/workerDisconnectNotice.mjs`, `lib/completionGate.mjs`.
2. Remove `owner_*` and `session_bound` fields from `lib/agentRegistry.mjs` and `schemas/agents.schema.json`.
3. Remove `isOwnerHeartbeatStale` and `session_bound` from `lib/dispatchPlanner.mjs`.
4. Refactor `lib/progressValidation.mjs` to accept `(input, claim)` instead of `(stateDir, input)`.
5. Update `cli/progress.mjs` to load the claim from disk itself, remove the completion gate, and use `lib/args.mjs`.

---

## Step-by-Step Instructions

### Step 1 — Delete four files

Delete these files entirely:

- `orchestrator/runtime/worker-runtime.mjs`
- `lib/sessionOwner.mjs`
- `lib/workerDisconnectNotice.mjs`
- `lib/completionGate.mjs`

If corresponding test files exist for any of these, delete them too.

### Step 2 — Update `lib/agentRegistry.mjs`

Remove the five owner fields from the `entry` object in `registerAgent()`:

```js
// DELETE these 5 lines from the entry object:
owner_session_id: null,
owner_tty:        null,
owner_pid:        null,
owner_last_seen_at: null,
session_bound:    false,
```

Remove the same five keys from the `ALLOWED` Set in `updateAgentRuntime()`:

```js
// BEFORE:
const ALLOWED = new Set([
  'status', 'session_handle', 'provider_ref', 'last_heartbeat_at',
  'last_status_change_at', 'owner_session_id', 'owner_tty',
  'owner_pid', 'owner_last_seen_at', 'session_bound',
]);

// AFTER:
const ALLOWED = new Set([
  'status', 'session_handle', 'provider_ref',
  'last_heartbeat_at', 'last_status_change_at',
]);
```

### Step 3 — Update `lib/dispatchPlanner.mjs`

Remove the `isOwnerHeartbeatStale` import (line 1).

Remove `ownerStaleThresholdMs`, `nowMs`, and the stale check from `selectDispatchableAgents`. Also replace the `session_bound` check with `session_handle != null`:

```js
// BEFORE:
export function selectDispatchableAgents(
  agents,
  { busyAgents = new Set(), ownerStaleThresholdMs = 120000, nowMs = Date.now() } = {},
) {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && a.session_bound === true
      && !isOwnerHeartbeatStale(a, ownerStaleThresholdMs, nowMs)
      && !busyAgents.has(a.agent_id),
  );
}

// AFTER:
export function selectDispatchableAgents(agents, { busyAgents = new Set() } = {}) {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && a.session_handle != null
      && !busyAgents.has(a.agent_id),
  );
}
```

> **Note:** If A3 has already made this change, skip Step 3 — the two tasks target the same function. Verify the current state of the file before editing.

### Step 4 — Refactor `lib/progressValidation.mjs`

Change the function signature from `(stateDir, input)` to `(input, claim)`:

```js
// BEFORE:
export function validateProgressInput(stateDir, input) {
  const { event, runId, agentId, phase, reason, policy } = input;
  ...
  const claim = findClaimByRunId(stateDir, runId);
  if (!claim) {
    throw new Error(`Run not found in claims: ${runId}`);
  }
  ...
}

// AFTER:
export function validateProgressInput(input, claim) {
  const { event, runId, agentId, phase, reason, policy } = input;
  ...
  if (!claim) throw new Error(`Run not found in claims: ${runId}`);
  if (claim.run_id !== runId) throw new Error(`Claim run_id mismatch: expected ${runId}`);
  ...
}
```

Delete the private `findClaimByRunId(stateDir, runId)` function (lines 78–85).

Remove the `readFileSync` and `join` imports at the top of the file — they are no longer needed.

The return value `{ claim }` stays unchanged for backward compatibility with the caller in `progress.mjs`.

### Step 5 — Update `cli/progress.mjs`

Add `import { flag } from '../lib/args.mjs';` at the top. Remove the private flag parser function (`getFlag`, `arg`, or however it is named in this file).

Remove the import of `evaluateCompletionGate` from `../lib/completionGate.mjs`.

Add a `loadClaim` helper that reads from disk:

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadClaim(runId) {
  try {
    const claims = JSON.parse(readFileSync(join(STATE_DIR, 'claims.json'), 'utf8'));
    return (claims.claims ?? []).find((c) => c.run_id === runId) ?? null;
  } catch {
    return null;
  }
}
```

> **Verify:** `readFileSync` and `join` may already be imported. Do not add duplicates.

Before calling `validateProgressInput`, load the claim:

```js
// BEFORE:
const { claim } = validateProgressInput(STATE_DIR, { event, runId, agentId, phase, reason, policy });

// AFTER:
const claim = loadClaim(runId);
const { claim: validatedClaim } = validateProgressInput({ event, runId, agentId, phase, reason, policy }, claim);
```

In the `run_finished` case, remove the completion gate block entirely:

```js
// BEFORE:
case 'run_finished': {
  const gate = evaluateCompletionGate(STATE_DIR, runId, { confirmAc });
  if (!gate.passed) {
    finishRun(STATE_DIR, runId, agentId, { success: false, failureReason: gate.reason, policy: 'requeue' });
    break;
  }
  finishRun(STATE_DIR, runId, agentId, { success: true });
  break;
}

// AFTER:
case 'run_finished':
  finishRun(STATE_DIR, runId, agentId, { success: true });
  break;
```

Remove the `confirmAcRaw` and `confirmAc` variable declarations wherever they appear.

### Step 6 — Update `schemas/agents.schema.json`

Find the agent's `properties` object and remove:
- `owner_session_id`
- `owner_tty`
- `owner_pid`
- `owner_last_seen_at`
- `session_bound`

Also remove them from `required` if they appear there.

### Step 7 — Run tests

```
nvm use 22 && npm test
```

Confirm `npm run orc:progress -- --event=run_started --run-id=test --agent-id=test` exits with a `'Run not found'` error and does not crash with an unhandled exception.

---

## Acceptance Criteria

- [ ] `runtime/worker-runtime.mjs` is deleted.
- [ ] `lib/sessionOwner.mjs` is deleted.
- [ ] `lib/workerDisconnectNotice.mjs` is deleted.
- [ ] `lib/completionGate.mjs` is deleted.
- [ ] `lib/agentRegistry.mjs` does not write `owner_session_id`, `owner_tty`, `owner_pid`, `owner_last_seen_at`, or `session_bound` when registering or updating an agent.
- [ ] `lib/dispatchPlanner.mjs` does not import or call `isOwnerHeartbeatStale`; it does not reference `session_bound` or `ownerStaleThresholdMs`.
- [ ] `lib/progressValidation.mjs` signature is `validateProgressInput(input, claim)` with no disk reads.
- [ ] `cli/progress.mjs` loads the claim from disk before calling `validateProgressInput`, and passes it as the second argument.
- [ ] `cli/progress.mjs` does not import or call `evaluateCompletionGate`; `run_finished` is accepted unconditionally on valid claim state.
- [ ] `schemas/agents.schema.json` does not contain `owner_session_id`, `owner_tty`, `owner_pid`, `owner_last_seen_at`, or `session_bound`.
- [ ] All existing orchestrator tests pass.
