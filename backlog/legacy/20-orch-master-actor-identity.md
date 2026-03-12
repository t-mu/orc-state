# Task 20 — Orchestrator: Actor Identity in `delegate-task.mjs`

> **Part D — Master Agent, Step 2 of 4.** No dependencies. Can run in parallel with Task 19.

## Context

`cli/delegate-task.mjs` currently hardcodes `actor_type: 'human'` and `actor_id: 'human'` in
the emitted `task_delegated` event. This was correct when only a human could call the command.
Once the master agent calls `orc:delegate` it needs to identify itself as the actor so the
event log accurately reflects who delegated the task.

The fix is one flag and two field substitutions.

---

## Goals

1. Accept an optional `--actor-id=<agent_id>` flag in `delegate-task.mjs`.
2. Derive `actor_type` (`'human'` or `'agent'`) from the value.
3. Use both in the emitted `task_delegated` event and in `task.delegated_by`.

---

## Step-by-Step Instructions

### Step 1 — Read `--actor-id` from flags

In `cli/delegate-task.mjs`, the existing flag declarations are at the top of the
file (after imports). Add one line:

```js
const actorId = flag('actor-id') ?? 'human';
```

### Step 2 — Derive `actor_type`

Add immediately after:

```js
const actorType = actorId === 'human' ? 'human' : 'agent';
```

### Step 3 — Use `actorId` in the task mutation

Find the block that writes fields onto `task` before calling `atomicWriteJson`:

```js
// BEFORE:
task.delegated_by = 'human';

// AFTER:
task.delegated_by = actorId;
```

### Step 4 — Use both in the emitted event

Find the `appendSequencedEvent` call. Replace the hardcoded actor fields:

```js
// BEFORE:
actor_type: 'human',
actor_id:   'human',

// AFTER:
actor_type: actorType,
actor_id:   actorId,
```

### Step 5 — Update the usage string

The usage error message is printed when `--task-ref` is missing. Append the new flag to it:

```js
// BEFORE:
'Usage: orchestrator delegate-task --task-ref=<epic/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>]'

// AFTER:
'Usage: orchestrator delegate-task --task-ref=<epic/task> [--target-agent-id=<agent_id>] [--task-type=<implementation|refactor>] [--note=<text>] [--actor-id=<agent_id>]'
```

### Step 6 — Update `delegate-task.test.mjs`

The existing test asserts:

```js
expect(taskDelegatedEvent?.actor_type).toBe('human');
expect(taskDelegatedEvent?.actor_id).toBe('human');
```

These assertions remain valid (default actor is still `'human'`). Add one new test case that
passes `--actor-id=master-01` and asserts:

```js
expect(event.actor_type).toBe('agent');
expect(event.actor_id).toBe('master-01');
expect(task.delegated_by).toBe('master-01');
```

### Step 7 — Run tests

```
nvm use 22 && npm run test:orch
```

---

## Acceptance Criteria

- [ ] `delegate-task.mjs` accepts `--actor-id=<value>`; defaults to `'human'` when absent.
- [ ] The emitted `task_delegated` event uses the provided `actor_id` and derives `actor_type` correctly.
- [ ] `task.delegated_by` is set to the actor id, not hardcoded to `'human'`.
- [ ] Existing tests pass without modification (default behaviour unchanged).
- [ ] New test covers non-human actor delegation.
- [ ] All orchestrator tests pass.
