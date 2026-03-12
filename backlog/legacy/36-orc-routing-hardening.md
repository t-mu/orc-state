# Task 36 — Task Routing Hardening: Owner Re-Check and Unknown Type Guard

Medium severity correctness fix. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Add `owner` re-validation inside `claimTask` in `claimManager.mjs` — reject claim if
  `task.owner` is set and does not match the claiming `agentId`
- Update `canAgentExecuteTaskType` in `taskRouting.mjs` to return `false` for unknown task
  types instead of silently accepting them
- Add tests for both behaviours

**Out of scope:**
- Changing `taskScheduler.mjs` (it already checks `owner` before calling `claimTask`)
- Changing `delegate-task.mjs` or any CLI tools
- Changing backlog schema or event schema

---

## Context

### Issue 1: `claimTask` does not re-check `task.owner`

`taskScheduler.mjs::nextEligibleTask` correctly skips tasks whose `owner` doesn't match
the claiming agent:

```js
if (task.owner && task.owner !== agentId) continue;
```

However, `claimManager.mjs::claimTask` does NOT verify this constraint:

```js
export function claimTask(stateDir, taskRef, agentId, ...) {
  return withLock(lp(stateDir), () => {
    const backlog = readJson(stateDir, 'backlog.json');
    const task = findTask(backlog, taskRef);
    if (!task) throw new Error(`Task not found: ${taskRef}`);
    if (task.status !== 'todo') throw new Error(`Task not claimable (status: ${task.status}): ${taskRef}`);
    // ← no owner check here
    ...
  });
}
```

There is a race window: between `nextEligibleTask` reading the old backlog (no owner) and
`claimTask` acquiring the lock and re-reading the backlog (owner now set by a concurrent
`orc-delegate` call), a task could be claimed by the wrong agent.

More importantly, `claimTask` is part of the public API (exported). Any caller — including
future adapters or tests — could bypass the owner constraint by calling `claimTask` directly.

### Issue 2: `canAgentExecuteTaskType` silently accepts unknown task types

```js
// taskRouting.mjs
export function canAgentExecuteTaskType(taskType, agent) {
  if (agent.role === 'master') {
    return !['implementation', 'refactor'].includes(taskType);
  }
  return true; // ← any unknown type passes for worker agents
}
```

A task with `task_type: 'researh'` (typo for 'research') or any unregistered type would
be routed to any worker without warning. The intended behaviour is to restrict dispatch
to declared types only.

**Affected files:**
- `lib/claimManager.mjs` — add owner check in `claimTask`
- `lib/taskRouting.mjs` — guard unknown task types
- `lib/claimManager.test.mjs` — new test
- `lib/taskRouting.test.mjs` (or equivalent) — new tests

---

## Goals

1. Must reject `claimTask` with a descriptive error when `task.owner` is set and does not
   match the claiming `agentId`
2. Must allow `claimTask` when `task.owner` is absent or null
3. Must allow `claimTask` when `task.owner === agentId`
4. Must make `canAgentExecuteTaskType` return `false` for task types not in
   `['implementation', 'refactor']` for worker-role agents
5. Must add log-level warning when an unknown task type is encountered during routing
6. Must not change any existing passing test behaviour

---

## Implementation

### Step 1 — Add owner check in `claimTask`

**File:** `lib/claimManager.mjs`

Inside the `withLock` callback, after the `task.status` check:

```js
// After:
if (task.status !== 'todo') throw new Error(`Task not claimable (status: ${task.status}): ${taskRef}`);

// Add:
if (task.owner && task.owner !== agentId) {
  throw new Error(`Task ${taskRef} is reserved for agent "${task.owner}" — claiming agent "${agentId}" is not the owner`);
}
```

### Step 2 — Update `canAgentExecuteTaskType` for strict type checking

**File:** `lib/taskRouting.mjs`

```js
const KNOWN_TASK_TYPES = new Set(['implementation', 'refactor']);

export function canAgentExecuteTaskType(taskType, agent) {
  if (!KNOWN_TASK_TYPES.has(taskType)) {
    // Unknown task types are not dispatchable to any agent.
    // This surfaces misconfigured tasks early rather than silently routing them anywhere.
    return false;
  }
  if (agent.role === 'master') {
    return false; // master agents do not execute implementation tasks
  }
  return true;
}
```

> **Note:** The previous master-agent logic was `return !['implementation','refactor'].includes(taskType)`.
> For master agents that means they could execute unknown task types. With the new guard,
> unknown types return `false` before the master-role check, so master agents also cannot
> execute unknown types. This is the correct behaviour.

### Step 3 — Add tests for `claimTask` owner enforcement

**File:** `lib/claimManager.test.mjs`

```js
it('throws when claiming agent is not the task owner', () => {
  // Set up a task with owner: 'agent-a'; attempt to claim with 'agent-b'
  expect(() => claimTask(dir, 'epic/task-1', 'agent-b')).toThrow(
    'reserved for agent "agent-a"'
  );
});

it('allows claim when task has no owner', () => {
  // Task has no owner field; any agent can claim
  expect(() => claimTask(dir, 'epic/task-1', 'agent-b')).not.toThrow();
});

it('allows claim when claiming agent matches owner', () => {
  // task.owner = 'agent-a'; claimTask called with 'agent-a'
  expect(() => claimTask(dir, 'epic/task-1', 'agent-a')).not.toThrow();
});
```

### Step 4 — Add tests for `canAgentExecuteTaskType` unknown type guard

**File:** `lib/taskRouting.test.mjs` (or add to existing task routing tests)

```js
it('returns false for unknown task type for worker agents', () => {
  const agent = { role: 'worker', capabilities: [] };
  expect(canAgentExecuteTaskType('research', agent)).toBe(false);
  expect(canAgentExecuteTaskType('', agent)).toBe(false);
  expect(canAgentExecuteTaskType(undefined, agent)).toBe(false);
});

it('returns true for known task types for worker agents', () => {
  const agent = { role: 'worker', capabilities: [] };
  expect(canAgentExecuteTaskType('implementation', agent)).toBe(true);
  expect(canAgentExecuteTaskType('refactor', agent)).toBe(true);
});

it('returns false for all task types for master agents', () => {
  const agent = { role: 'master', capabilities: [] };
  expect(canAgentExecuteTaskType('implementation', agent)).toBe(false);
  expect(canAgentExecuteTaskType('refactor', agent)).toBe(false);
  expect(canAgentExecuteTaskType('research', agent)).toBe(false);
});
```

---

## Acceptance criteria

- [ ] `claimTask` throws a descriptive error containing "reserved for agent" when `task.owner` is set and does not match claiming agent
- [ ] `claimTask` succeeds when `task.owner` is absent or matches the claiming agent
- [ ] `canAgentExecuteTaskType` returns `false` for any task type not in `['implementation', 'refactor']`
- [ ] `canAgentExecuteTaskType` returns `false` for all task types when agent role is `'master'`
- [ ] `canAgentExecuteTaskType` returns `true` for `'implementation'` and `'refactor'` for worker agents
- [ ] All existing tests pass
- [ ] New tests for owner enforcement and unknown type guard pass

---

## Tests

`lib/claimManager.test.mjs` — 3 new tests (owner match, owner mismatch, no owner).

`lib/taskRouting.test.mjs` — 3 new tests (unknown type, known types, master role).

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

```bash
# Confirm claimTask owner check is present
grep -n 'task.owner' lib/claimManager.mjs
# Expected: two lines — the owner assignment (from existing code if any) and the new check

grep -n 'KNOWN_TASK_TYPES' lib/taskRouting.mjs
# Expected: definition + usage in canAgentExecuteTaskType
```
