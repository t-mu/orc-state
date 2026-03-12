# Task 17 — Orchestrator B2: Remove Planner-Loop and Simplify Task Routing

> **Track B — Step 2 of 3.** Requires Task 16 (B1) to be complete first.

## Context

The planner-loop daemon (`cli/planner-loop.mjs`) was designed to auto-generate review and refactor tasks by running a loop that picks up `planning` tasks and delegates work. No planner agents are registered in `orchestrator/state/agents.json`. The `planning` task type is unused and no task in `backlog.json` has `task_type: "planning"`.

In `lib/taskRouting.mjs` (lines 20–30), the routing table handles four task types:

```js
export function canAgentExecuteTaskType(taskType, agent) {
  const role = agent?.role ?? 'worker';
  const capSet = toCapSet(agent);

  if (role === 'planner') return taskType === 'planning';
  if (taskType === 'planning') return role === 'planner';
  if (taskType === 'implementation') return role === 'worker';
  if (taskType === 'review') return role === 'reviewer' || capSet.has('review');
  if (taskType === 'refactor') return role === 'worker' || role === 'reviewer' || capSet.has('refactor');
  return false;  // unknown type → fail closed
}
```

The final `return false` means unknown task types fail closed. With planning and review removed, the two remaining types are `implementation` and `refactor`. Unknown types should fail open (allow any agent) to avoid silently blocking future task types from dispatching.

`lib/dispatchPlanner.mjs` (line 12) explicitly filters out `planner`-role agents:

```js
&& (a.role ?? 'worker') !== 'planner'
```

After removing the planner role from the schema this filter has no targets but still runs on every dispatch cycle.

`cli/delegate-task.mjs` validates that the caller (`--planner-id`) is a registered planner-role agent before emitting a `task_delegated` event. With no planner agents and no planner role, this check blocks all use of the delegate command.

---

## Goals

1. Delete `cli/planner-loop.mjs`.
2. Simplify `lib/taskRouting.mjs` to handle two task types: `implementation` and `refactor`.
3. Remove the planner role filter from `lib/dispatchPlanner.mjs`.
4. Remove the `--planner-id` requirement from `cli/delegate-task.mjs`.
5. Remove `planner` from the role enum in `schemas/agents.schema.json`.
6. Simplify `planning_state` in `schemas/backlog.schema.json` to two values.

---

## Step-by-Step Instructions

### Step 1 — Delete `cli/planner-loop.mjs`

Delete the file `cli/planner-loop.mjs` entirely. If a test file `cli/planner-loop.test.mjs` exists, delete it too.

### Step 2 — Simplify `lib/taskRouting.mjs`

Replace the `canAgentExecuteTaskType` function body:

```js
// BEFORE:
export function canAgentExecuteTaskType(taskType, agent) {
  const role = agent?.role ?? 'worker';
  const capSet = toCapSet(agent);
  if (role === 'planner') return taskType === 'planning';
  if (taskType === 'planning') return role === 'planner';
  if (taskType === 'implementation') return role === 'worker';
  if (taskType === 'review') return role === 'reviewer' || capSet.has('review');
  if (taskType === 'refactor') return role === 'worker' || role === 'reviewer' || capSet.has('refactor');
  return false;
}

// AFTER:
export function canAgentExecuteTaskType(taskType, agent) {
  const role = agent?.role ?? 'worker';
  if (taskType === 'implementation') return role === 'worker';
  if (taskType === 'refactor') {
    return role === 'worker' || role === 'reviewer' || toCapSet(agent).has('refactor');
  }
  return true; // fail open for unknown task types
}
```

Keep `toCapSet`, `taskTypeOf`, `hasRequiredCapabilities`, and `canAgentExecuteTask` unchanged.

> **Verify:** Check that `toCapSet` is still referenced (it is, in the `refactor` branch). If after this change it is only referenced once, it is still worth keeping for clarity.

### Step 3 — Remove planner filter from `lib/dispatchPlanner.mjs`

```js
// BEFORE:
return (agents ?? []).filter(
  (a) => a.status !== 'offline'
    && (a.role ?? 'worker') !== 'planner'
    && a.session_bound === true
    && !isOwnerHeartbeatStale(a, ownerStaleThresholdMs, nowMs)
    && !busyAgents.has(a.agent_id),
);

// AFTER (remove planner condition; A3 removes the heartbeat and session_bound conditions):
return (agents ?? []).filter(
  (a) => a.status !== 'offline'
    && a.session_bound === true
    && !isOwnerHeartbeatStale(a, ownerStaleThresholdMs, nowMs)
    && !busyAgents.has(a.agent_id),
);
```

Remove only `&& (a.role ?? 'worker') !== 'planner'`. The `isOwnerHeartbeatStale` and `session_bound` conditions are removed by B3 / A3 — do not touch them in this task unless those tasks have already landed.

### Step 4 — Simplify `cli/delegate-task.mjs`

Remove the `--planner-id` flag and all code that reads or validates it:
- Delete the `plannerId` variable declaration.
- Delete the `getAgent(STATE_DIR, plannerId)` lookup and the `role !== 'planner'` check.
- Delete the `planner_id` field from the emitted `task_delegated` event payload.

Add the `args.mjs` import and remove the private flag parser:

```js
import { flag } from '../lib/args.mjs';
// Remove the private flag() / arg() / getFlag() function definition.
```

Set `actor_id` to `'human'` in the emitted event (there is no longer a planner agent ID):

```js
// BEFORE:
actor_id: plannerId,

// AFTER:
actor_id: 'human',
```

The command now accepts: `--task-ref`, `--target-agent-id` (optional), `--task-type` (default: `implementation`), `--note` (optional).

Update the usage string printed on error accordingly.

### Step 5 — Update `schemas/agents.schema.json`

Find the `role` property's `enum` array and change it from:

```json
"enum": ["planner", "worker", "reviewer"]
```

To:

```json
"enum": ["worker", "reviewer"]
```

### Step 6 — Update `schemas/backlog.schema.json`

Find the `planning_state` property's `enum` array and change it from the current multi-value list to:

```json
"enum": ["ready_for_dispatch", "archived"]
```

Remove: `"proposal"`, `"delegated"`, `"in_review"` (and any others present).

> **Note:** All existing tasks in `backlog.json` use `"ready_for_dispatch"` — verify this before removing the other values with a grep.

### Step 7 — Update `lib/agentRegistry.mjs`

Change `VALID_ROLES` (line 7):

```js
// BEFORE:
const VALID_ROLES = new Set(['planner', 'worker', 'reviewer']);

// AFTER:
const VALID_ROLES = new Set(['worker', 'reviewer']);
```

### Step 8 — Run tests

```
nvm use 22 && npm test
```

Run `npm run orc:doctor` and confirm no schema validation errors are reported for existing state files.

---

## Acceptance Criteria

- [ ] `cli/planner-loop.mjs` is deleted.
- [ ] `lib/taskRouting.mjs` handles only `implementation` and `refactor` task types; unknown types return `true` (fail open).
- [ ] `lib/dispatchPlanner.mjs` does not filter agents by the `planner` role.
- [ ] `cli/delegate-task.mjs` does not accept or validate `--planner-id`; it imports `flag` from `../lib/args.mjs`.
- [ ] `task_delegated` event payload no longer contains `planner_id`.
- [ ] `schemas/agents.schema.json` role enum is `["worker", "reviewer"]`.
- [ ] `schemas/backlog.schema.json` `planning_state` enum is `["ready_for_dispatch", "archived"]`.
- [ ] `lib/agentRegistry.mjs` `VALID_ROLES` does not include `planner`.
- [ ] All existing orchestrator tests pass.
