---
ref: orch/task-108-delegate-task-active-claim-guard
epic: orch
status: done
---

# Task 108 — Guard delegate_task Against Dispatching to Already-Busy Agents

Independent. Blocks none.

## Scope

**In scope:**
- `mcp/handlers.mjs` — `handleDelegateTask`: add active-claim check before accepting an explicit `target_agent_id`
- `mcp/handlers.test.mjs` — add test for the new guard

**Out of scope:**
- Changes to auto-selection path (`selectAutoTarget`) — it already receives the claims list
- Changes to the coordinator dispatch path or `claimManager.mjs`
- Changes to any other MCP handler

## Context

`handleDelegateTask` validates that an explicit `target_agent_id` is registered and can execute the task type, but does not check whether that agent already has an active claim (`state: 'claimed'` or `state: 'in_progress'`). A master agent can therefore assign two tasks to the same worker simultaneously:

```js
// handlers.mjs (lines 327-341) — current:
if (assignedTarget) {
  const target = allAgents.find((a) => a.agent_id === assignedTarget);
  if (!target) throw new Error(`Target agent not found: ${assignedTarget}`);
  if (!canAgentExecuteTask(...)) throw new Error(`...`);
  // ← no busy-check here
}
```

The auto-selection path (`selectAutoTarget`) is handed `claims` and already skips busy agents. The manual path must apply the same guard.

**Affected files:**
- `mcp/handlers.mjs` — `handleDelegateTask`
- `mcp/handlers.test.mjs` — new test case

## Goals

1. Must check whether `target_agent_id` has an active claim (`'claimed'` or `'in_progress'`) before accepting a manual assignment.
2. Must throw a descriptive error when the target is already busy, including the agent ID and active run ID.
3. Must not change the auto-selection path.
4. Must not reject assignments to agents in `'idle'`, `'offline'`, or `'todo'` states — only active claims matter.

## Implementation

### Step 1 — Add busy check in handleDelegateTask

**File:** `mcp/handlers.mjs`

Inside `withLock`, after the existing `canAgentExecuteTask` check:

```js
// After the canAgentExecuteTask guard:
const activeClaim = claims.find(
  (c) => c.agent_id === assignedTarget && ['claimed', 'in_progress'].includes(c.state),
);
if (activeClaim) {
  throw new Error(
    `Target agent ${assignedTarget} already has an active claim: ${activeClaim.run_id} (${activeClaim.state}). ` +
    `Finish or requeue that run before delegating a new task.`,
  );
}
```

### Step 2 — Add test

**File:** `mcp/handlers.test.mjs`

```js
it('handleDelegateTask throws when target agent has an active claim', () => {
  // seed claims.json with a claimed entry for the target agent
  // expect handleDelegateTask to throw with the run_id in the message
});
```

## Acceptance criteria

- [ ] `handleDelegateTask` throws when the manually-specified `target_agent_id` has a `'claimed'` or `'in_progress'` claim.
- [ ] The error message includes the agent ID and active run ID.
- [ ] Delegation to an idle agent with no active claims succeeds as before.
- [ ] Auto-selection path is unchanged.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `mcp/handlers.test.mjs`

```js
it('handleDelegateTask throws when target has active claim', () => { ... });
it('handleDelegateTask succeeds when target has no active claim', () => { ... });
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```
