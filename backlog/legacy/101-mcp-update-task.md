# Task 101 — Add update_task MCP Tool to Orchestrator

Independent.

## Scope

**In scope:**
- `mcp/tools-list.mjs` — add `update_task` tool definition
- `mcp/handlers.mjs` — add `handleUpdateTask` function
- `mcp/server.mjs` — wire `update_task` case in `invokeTool`
- `mcp/handlers.test.mjs` — add tests for `handleUpdateTask`

**Out of scope:**
- Updating `status` or `owner` fields (coordinator-owned state machine fields)
- Updating `task_type`, `planning_state`, or `delegated_by`
- Adding an `update_task` CLI command
- Modifying `backlog.json` schema or epic structure

## Context

The MCP server currently has no way to patch an existing task's mutable fields (`title`, `description`, `acceptance_criteria`, `depends_on`) after creation. When `create_task` fails to set `acceptance_criteria` (e.g. due to serialization issues), the master agent has no recovery path short of editing `backlog.json` directly.

`handleUpdateTask` follows the same pattern as `handleCreateTask` and `handleDelegateTask`: acquire `.lock`, read backlog, mutate in place, `atomicWriteJson`, append a `task_updated` event with `lockAlreadyHeld: true`. Only fields explicitly provided in `args` (non-`undefined`) are applied — absent fields are left unchanged.

`status` and `owner` are deliberately excluded: they are managed by the coordinator's state machine and must not be writable by the master agent directly.

**Affected files:**
- `mcp/tools-list.mjs` — tool schema registry
- `mcp/handlers.mjs` — business logic; exports `handleUpdateTask`
- `mcp/server.mjs` — `invokeTool` switch dispatch
- `mcp/handlers.test.mjs` — handler unit tests

## Goals

- Must export `handleUpdateTask(stateDir, args)` from `handlers.mjs`.
- Must apply only fields that are explicitly present in `args` (patch semantics — no field is cleared unless explicitly passed).
- Must throw if `task_ref` is missing or the task does not exist.
- Must throw if `actor_id` does not match `ACTOR_ID_RE`.
- Must throw if `acceptance_criteria` or `depends_on` are provided but are not string arrays.
- Must write `updated_at` to the current ISO timestamp on every successful update.
- Must append a `task_updated` event to `events.jsonl` with `payload.fields` listing the names of changed fields.

## Implementation

### Step 1 — Add tool definition

**File:** `mcp/tools-list.mjs`

Insert after the `create_task` entry and before `delegate_task`:

```js
{
  name: 'update_task',
  description: 'Update mutable fields on an existing task. Only provided fields are changed. Does not modify status or owner.',
  inputSchema: {
    type: 'object',
    required: ['task_ref'],
    properties: {
      task_ref: {
        type: 'string',
        description: 'Full task ref, e.g. "orch/task-101-foo"',
      },
      title: { type: 'string', description: 'Replacement title' },
      description: { type: 'string', description: 'Replacement description' },
      acceptance_criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Native JSON array of criterion strings — NOT a JSON-encoded string. Example: ["criterion one", "criterion two"]',
      },
      depends_on: {
        type: 'array',
        items: { type: 'string' },
        description: 'Native JSON array of task ref strings — NOT a JSON-encoded string.',
      },
      actor_id: { type: 'string', description: 'Defaults to master agent_id' },
    },
    additionalProperties: false,
  },
},
```

### Step 2 — Add handler

**File:** `mcp/handlers.mjs`

Add after `handleCreateTask` and before `handleDelegateTask`:

```js
export function handleUpdateTask(stateDir, args = {}) {
  const {
    task_ref,
    title,
    description,
    acceptance_criteria,
    depends_on,
    actor_id = defaultActorId(stateDir),
  } = args;

  if (!task_ref) throw new Error('task_ref is required');
  if (!ACTOR_ID_RE.test(actor_id)) {
    throw new Error(`Invalid actor_id: ${actor_id}. Must match ^[a-z0-9][a-z0-9-]*$.`);
  }
  assertStringArray(acceptance_criteria, 'acceptance_criteria');
  assertStringArray(depends_on, 'depends_on');

  const now = new Date().toISOString();
  const changedFields = [];

  return withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readJson(stateDir, 'backlog.json');
    const task = findTask(backlog, task_ref);
    if (!task) throw new Error(`Task not found: ${task_ref}`);

    if (title !== undefined)               { task.title = title;                             changedFields.push('title'); }
    if (description !== undefined)         { task.description = description;                 changedFields.push('description'); }
    if (acceptance_criteria !== undefined) { task.acceptance_criteria = acceptance_criteria; changedFields.push('acceptance_criteria'); }
    if (depends_on !== undefined)          { task.depends_on = depends_on;                   changedFields.push('depends_on'); }

    task.updated_at = now;

    atomicWriteJson(backlogPath, backlog);
    appendSequencedEvent(
      stateDir,
      {
        ts: now,
        event: 'task_updated',
        actor_type: 'agent',
        actor_id,
        task_ref,
        payload: { fields: changedFields },
      },
      { lockAlreadyHeld: true },
    );

    return task;
  });
}
```

### Step 3 — Wire in server

**File:** `mcp/server.mjs`

In the `invokeTool` switch, add after the `create_task` case:

```js
case 'update_task':
  return handlers.handleUpdateTask(stateDir, args);
```

## Acceptance criteria

- [ ] `update_task` appears in `TOOLS` array in `tools-list.mjs` with `required: ['task_ref']` and `additionalProperties: false`.
- [ ] `handleUpdateTask` is exported from `handlers.mjs`.
- [ ] Providing `title`, `description`, `acceptance_criteria`, and `depends_on` updates those fields; omitting them leaves them unchanged.
- [ ] `updated_at` is set to a new ISO timestamp on every successful call.
- [ ] A `task_updated` event is appended to `events.jsonl` with `payload.fields` listing only the changed fields.
- [ ] Throws `task_ref is required` when `task_ref` is absent.
- [ ] Throws `Task not found` when `task_ref` does not exist in the backlog.
- [ ] Throws `Invalid actor_id` when `actor_id` does not match `^[a-z0-9][a-z0-9-]*$`.
- [ ] Throws when `acceptance_criteria` or `depends_on` is a non-array value.
- [ ] `status` and `owner` fields are not accepted and cannot be changed via this tool.
- [ ] `invokeTool('update_task', ...)` in `server.mjs` dispatches to `handleUpdateTask`.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `mcp/handlers.test.mjs`

Add a `describe('handleUpdateTask', ...)` block. Import `handleUpdateTask` at the top alongside existing handler imports. Reuse the existing `dir`, `seedBacklog`, `readBacklog`, `seedAgents` helpers.

```js
it('updates provided fields and leaves others unchanged', () => {
  const result = handleUpdateTask(dir, {
    task_ref: 'project/todo-one',
    title: 'Updated title',
    acceptance_criteria: ['criterion A'],
    actor_id: 'master',
  });
  expect(result.title).toBe('Updated title');
  expect(result.acceptance_criteria).toEqual(['criterion A']);
  // description was not provided — must still be absent/unchanged
  const backlog = readBacklog();
  const task = backlog.epics.flatMap((e) => e.tasks).find((t) => t.ref === 'project/todo-one');
  expect(task.title).toBe('Updated title');
  expect(task).not.toHaveProperty('description');
});

it('updates updated_at on successful call', () => {
  const before = readBacklog().epics.flatMap((e) => e.tasks)
    .find((t) => t.ref === 'project/todo-one').updated_at;
  handleUpdateTask(dir, { task_ref: 'project/todo-one', title: 'New', actor_id: 'master' });
  const after = readBacklog().epics.flatMap((e) => e.tasks)
    .find((t) => t.ref === 'project/todo-one').updated_at;
  expect(after).not.toBe(before);
});

it('appends task_updated event with correct fields list', () => {
  handleUpdateTask(dir, {
    task_ref: 'project/todo-one',
    description: 'new desc',
    depends_on: ['project/done-one'],
    actor_id: 'master',
  });
  const events = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const evt = JSON.parse(events.trim().split('\n').at(-1));
  expect(evt.event).toBe('task_updated');
  expect(evt.task_ref).toBe('project/todo-one');
  expect(evt.payload.fields).toEqual(expect.arrayContaining(['description', 'depends_on']));
  expect(evt.payload.fields).not.toContain('title');
});

it('throws when task_ref is missing', () => {
  expect(() => handleUpdateTask(dir, { actor_id: 'master' })).toThrow(/task_ref is required/);
});

it('throws when task does not exist', () => {
  expect(() => handleUpdateTask(dir, {
    task_ref: 'project/nonexistent',
    actor_id: 'master',
  })).toThrow(/Task not found/);
});

it('throws when actor_id format is invalid', () => {
  expect(() => handleUpdateTask(dir, {
    task_ref: 'project/todo-one',
    actor_id: 'INVALID',
  })).toThrow(/Invalid actor_id/);
});

it('throws when acceptance_criteria is not an array', () => {
  expect(() => handleUpdateTask(dir, {
    task_ref: 'project/todo-one',
    acceptance_criteria: 'not an array',
    actor_id: 'master',
  })).toThrow(/acceptance_criteria must be an array/);
});
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

Confirm `handleUpdateTask` tests all pass and no existing handler tests regress.

## Risk / Rollback

**Risk:** `atomicWriteJson` failure mid-lock could leave backlog in an intermediate state; however, `atomicWriteJson` writes to a temp file and renames atomically, so partial writes do not corrupt `backlog.json`.

**Rollback:** `git restore mcp/tools-list.mjs mcp/handlers.mjs mcp/server.mjs && npm test`
