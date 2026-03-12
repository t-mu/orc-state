# Task 15 — Orchestrator A3: Extract Task Scheduler and Simplify Coordinator

> **Track A — Step 3 of 3.** Requires Task 14 (A2) to be complete first.

## Context

`nextEligibleTask` and `nextEligibleTaskFromBacklog` (lines 241–274 of `lib/claimManager.mjs`) are task scheduling concerns — given a backlog and an agent, return the next task the agent may work on. They live in `claimManager.mjs` alongside claim lifecycle (create, start, heartbeat, finish, expire), which is a different responsibility. The coordinator calls `nextEligibleTask` at dispatch time; `claimManager` calls `nextEligibleTaskFromBacklog` only internally.

The coordinator (`coordinator.mjs`) has grown 10 CLI flags at the top of the file (lines 42–51):

```js
const INTERVAL_MS                    = intArg('interval-ms', 30000);
const MODE                           = arg('mode', 'autonomous');
const RUN_START_TIMEOUT_MS           = intArg('run-start-timeout-ms', 300000);
const RUN_START_NUDGE_MS             = intArg('run-start-nudge-ms', 30000);
const RUN_START_NUDGE_INTERVAL_MS    = intArg('run-start-nudge-interval-ms', 60000);
const RUN_INACTIVE_TIMEOUT_MS        = intArg('run-inactive-timeout-ms', 1800000);
const RUN_INACTIVE_NUDGE_MS          = intArg('run-inactive-nudge-ms', 600000);
const RUN_INACTIVE_NUDGE_INTERVAL_MS = intArg('run-inactive-nudge-interval-ms', 600000);
const OWNER_STALE_THRESHOLD_MS       = intArg('owner-stale-threshold-ms', 120000);
const ENABLE_EXECUTION_KICK          = arg('enable-execution-kick', 'true') === 'true';
```

Six of these are implementation details that can be derived: nudge timing should be a fixed proportion of the corresponding timeout, not independently configurable. `OWNER_STALE_THRESHOLD_MS` is removed (A3 removes heartbeat enforcement). `ENABLE_EXECUTION_KICK` has been `true` in all known deployments — it can be hardcoded.

The coordinator also imports and calls `tryNotifyWorkerDisconnect` and `isOwnerHeartbeatStale` from two modules (`lib/workerDisconnectNotice.mjs`, `lib/sessionOwner.mjs`) that Track B will delete. This task removes the coordinator's usage of those modules.

---

## Goals

1. Create `lib/taskScheduler.mjs` and move `nextEligibleTask` / `nextEligibleTaskFromBacklog` into it.
2. Remove the moved functions from `lib/claimManager.mjs`.
3. Remove owner-heartbeat enforcement from `coordinator.mjs` (`enforceOwnerHeartbeat`, `OWNER_STALE_THRESHOLD_MS`, `tryNotifyWorkerDisconnect` usage in `markAgentOffline`).
4. Reduce coordinator CLI flags from 10 to 4 by deriving nudge timings and hardcoding the execution kick.
5. Update `dispatchPlanner.mjs` to drop the `ownerStaleThresholdMs` parameter.

---

## Step-by-Step Instructions

### Step 1 — Create `lib/taskScheduler.mjs`

Create `lib/taskScheduler.mjs`. Move the two functions verbatim from `claimManager.mjs` (lines 241–274):

```js
import { join } from 'node:path';
import { readJson } from './stateReader.mjs';
import { canAgentExecuteTask } from './taskRouting.mjs';

/**
 * Find the next task the agent can execute.
 * Returns task_ref string, or null if nothing is eligible.
 */
export function nextEligibleTaskFromBacklog(backlog, agentOrId = null) {
  // ... (copy verbatim from claimManager.mjs lines 241-265)
}

export function nextEligibleTask(stateDir, agentOrId = null) {
  const backlog = readJson(stateDir, 'backlog.json');
  if (typeof agentOrId === 'string') {
    // resolve agent object via readJson
    const agentsFile = readJson(stateDir, 'agents.json');
    const agent = (agentsFile.agents ?? []).find((a) => a.agent_id === agentOrId) ?? null;
    return nextEligibleTaskFromBacklog(backlog, agent ?? agentOrId);
  }
  return nextEligibleTaskFromBacklog(backlog, agentOrId);
}
```

> **Note:** The original `nextEligibleTask` in `claimManager.mjs` calls a private `readAgentById` helper. In the new file, replace that with a direct `readJson` call as shown above — the logic is equivalent.

### Step 2 — Update `lib/claimManager.mjs`

Remove `nextEligibleTaskFromBacklog` (lines 241–265) and `nextEligibleTask` (lines 267–274) from the file.

Remove their exports.

Remove the import of `canAgentExecuteTask` from `./taskRouting.mjs` if it is now unused in claimManager. Also remove the private `readAgentById` helper function (lines 32–39) if it was only used by `nextEligibleTask`.

> **Verify:** grep `claimManager.mjs` for remaining uses of `canAgentExecuteTask` and `readAgentById` before removing those. The public claim functions (`claimTask`, `finishRun`, etc.) do not use routing — only the scheduler did.

### Step 3 — Update `coordinator.mjs` imports

Change the claimManager import:

```js
// BEFORE:
import { expireStaleLeases, claimTask, finishRun, nextEligibleTask } from './lib/claimManager.mjs';

// AFTER:
import { expireStaleLeases, claimTask, finishRun } from './lib/claimManager.mjs';
import { nextEligibleTask } from './lib/taskScheduler.mjs';
```

Remove these two imports entirely:

```js
// DELETE both lines:
import { tryNotifyWorkerDisconnect } from './lib/workerDisconnectNotice.mjs';
import { isOwnerHeartbeatStale } from './lib/sessionOwner.mjs';
```

### Step 4 — Remove `enforceOwnerHeartbeat` from `coordinator.mjs`

Delete the entire `enforceOwnerHeartbeat(agents)` function definition.

Delete the `OWNER_STALE_THRESHOLD_MS` constant.

In `tick()`, remove the call `await enforceOwnerHeartbeat(agents);`.

### Step 5 — Simplify `markAgentOffline` in `coordinator.mjs`

```js
// BEFORE:
async function markAgentOffline(agent, reason) {
  await tryNotifyWorkerDisconnect(agent, 'offline', reason);
  updateAgentRuntime(STATE_DIR, agent.agent_id, { ... });
  ...
}

// AFTER:
function markAgentOffline(agent, reason) {
  updateAgentRuntime(STATE_DIR, agent.agent_id, { ... });
  ...
}
```

Remove the `await tryNotifyWorkerDisconnect(...)` call and the `async` keyword from the function signature. Remove the `owner_session_id: null, owner_tty: null, owner_pid: null` fields from the `updateAgentRuntime` call (those fields are removed by B3).

### Step 6 — Reduce coordinator CLI flags to 4

Delete 6 of the 10 constants:

```js
// DELETE these 6:
const RUN_START_NUDGE_MS             = intArg('run-start-nudge-ms', 30000);
const RUN_START_NUDGE_INTERVAL_MS    = intArg('run-start-nudge-interval-ms', 60000);
const RUN_INACTIVE_NUDGE_MS          = intArg('run-inactive-nudge-ms', 600000);
const RUN_INACTIVE_NUDGE_INTERVAL_MS = intArg('run-inactive-nudge-interval-ms', 600000);
const OWNER_STALE_THRESHOLD_MS       = intArg('owner-stale-threshold-ms', 120000);
const ENABLE_EXECUTION_KICK          = arg('enable-execution-kick', 'true') === 'true';
```

Derive nudge timings from the timeouts:

```js
const RUN_START_NUDGE_MS             = Math.floor(RUN_START_TIMEOUT_MS * 0.1);
const RUN_START_NUDGE_INTERVAL_MS    = Math.floor(RUN_START_TIMEOUT_MS * 0.2);
const RUN_INACTIVE_NUDGE_MS          = Math.floor(RUN_INACTIVE_TIMEOUT_MS * 0.1);
const RUN_INACTIVE_NUDGE_INTERVAL_MS = Math.floor(RUN_INACTIVE_TIMEOUT_MS * 0.2);
```

For `ENABLE_EXECUTION_KICK`: find the `if (ENABLE_EXECUTION_KICK) { ... }` block in `tick()` and remove the `if` wrapper — run its body unconditionally.

The 4 remaining flags are: `--interval-ms`, `--mode`, `--run-start-timeout-ms`, `--run-inactive-timeout-ms`.

Update the startup log line in `main()` to only mention these 4 flags.

### Step 7 — Update `lib/dispatchPlanner.mjs`

Remove the `ownerStaleThresholdMs` and `nowMs` parameters from `selectDispatchableAgents`:

```js
// BEFORE:
export function selectDispatchableAgents(
  agents,
  { busyAgents = new Set(), ownerStaleThresholdMs = 120000, nowMs = Date.now() } = {},
) {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && (a.role ?? 'worker') !== 'planner'
      && a.session_bound === true
      && !isOwnerHeartbeatStale(a, ownerStaleThresholdMs, nowMs)
      && !busyAgents.has(a.agent_id),
  );
}

// AFTER (also removes planner filter, done by B2 — coordinate with that task):
export function selectDispatchableAgents(agents, { busyAgents = new Set() } = {}) {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && a.session_handle != null
      && !busyAgents.has(a.agent_id),
  );
}
```

Remove the import of `isOwnerHeartbeatStale` from `./sessionOwner.mjs`.

> **Note:** The `session_bound` field is removed by B3. Use `a.session_handle != null` as the liveness check instead. The planner role filter is removed by B2 — if B2 has not landed yet, leave the planner filter in place and let B2 remove it.

### Step 8 — Run tests

```
nvm use 22 && npm test
```

All tests must pass.

---

## Acceptance Criteria

- [ ] `lib/taskScheduler.mjs` exists and exports `nextEligibleTask(stateDir, agentOrId)` and `nextEligibleTaskFromBacklog(backlog, agentOrId)`.
- [ ] `lib/claimManager.mjs` does not export `nextEligibleTask` or `nextEligibleTaskFromBacklog`.
- [ ] `coordinator.mjs` imports `nextEligibleTask` from `lib/taskScheduler.mjs`.
- [ ] `coordinator.mjs` does not import `isOwnerHeartbeatStale` or `tryNotifyWorkerDisconnect`.
- [ ] `coordinator.mjs` does not define or call `enforceOwnerHeartbeat`.
- [ ] `coordinator.mjs` exposes exactly 4 CLI flags: `--interval-ms`, `--mode`, `--run-start-timeout-ms`, `--run-inactive-timeout-ms`.
- [ ] Nudge timing constants (`RUN_START_NUDGE_MS`, etc.) are derived from the timeout values, not from CLI flags.
- [ ] `markAgentOffline` in `coordinator.mjs` is synchronous and does not call `tryNotifyWorkerDisconnect`.
- [ ] `lib/dispatchPlanner.mjs` does not import or call `isOwnerHeartbeatStale` and does not accept `ownerStaleThresholdMs`.
- [ ] All existing orchestrator tests pass.
