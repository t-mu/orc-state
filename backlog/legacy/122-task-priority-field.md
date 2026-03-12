---
ref: orch/task-122-task-priority-field
epic: orch
status: done
---

# Task 122 — Add Task Priority Field

Independent.

## Scope

**In scope:**
- `lib/taskScheduler.mjs` — sort eligible tasks by priority before selecting
- `mcp/handlers.mjs` — `handleCreateTask` and `handleUpdateTask`: accept `priority` param
- `mcp/tools-list.mjs` — add `priority` enum param to `create_task` and `update_task`
- `lib/ajvFactory.mjs` or the backlog schema file — add `priority` enum to task schema
- `mcp/handlers.mjs` — `handleListTasks` summary includes `priority`; `handleGetTask` includes `priority`
- Test files for task scheduler and handlers

**Out of scope:**
- Priority inheritance (parent epic priority propagating to tasks)
- UI for setting priority
- Changing the worker bootstrap or task envelope (workers don't need to know priority)
- Preemption of in-progress tasks based on priority

---

## Context

All tasks are currently dispatched in FIFO order determined by their position in `backlog.json`. There is no way to mark a task as urgent without manually reordering the file. As the system scales to more tasks, the inability to prioritise blocks fast-path work items.

The task scheduler in `taskScheduler.mjs` calls `nextEligibleTaskFromBacklog()` which iterates epics and tasks in order. Inserting a sort-by-priority step before selection is the minimal change needed.

Priority levels (ascending urgency): `low`, `normal`, `high`, `critical`. Omitted field defaults to `normal` at read time so existing tasks are unaffected.

**Affected files:**
- `lib/taskScheduler.mjs` — `nextEligibleTaskFromBacklog` sort
- `mcp/handlers.mjs` — `handleCreateTask`, `handleUpdateTask`, `handleListTasks`, `handleGetTask`
- `mcp/tools-list.mjs` — `create_task`, `update_task` schemas
- Backlog JSON schema (if validated by AJV at runtime)
- `lib/taskScheduler.test.mjs` — priority ordering tests
- `mcp/handlers.test.mjs` — create/update with priority

---

## Goals

1. Must dispatch `critical` tasks before `high`, `high` before `normal`, `normal` before `low` when multiple tasks are eligible.
2. Must treat tasks with no `priority` field as `normal`.
3. Must accept `priority` in `create_task` (stored on the task object).
4. Must accept `priority` in `update_task` (updates the stored field).
5. Must include `priority` in `handleListTasks` summary fields.
6. Must not reorder tasks with equal priority (preserve existing FIFO within same priority level).

---

## Implementation

### Step 1 — Add priority sort to task scheduler

**File:** `lib/taskScheduler.mjs`

```js
const PRIORITY_ORDER = { critical: 3, high: 2, normal: 1, low: 0 };

function priorityValue(task) {
  return PRIORITY_ORDER[task.priority ?? 'normal'] ?? 1;
}

// In nextEligibleTaskFromBacklog, collect all eligible candidates first,
// then sort by priority descending, then return the first:
const eligible = [];
for (const epic of backlog.epics ?? []) {
  for (const task of epic.tasks ?? []) {
    if (isEligible(task, doneSet, agentId, taskType)) {
      eligible.push(task);
    }
  }
}
eligible.sort((a, b) => priorityValue(b) - priorityValue(a));
return eligible[0]?.ref ?? null;
```

### Step 2 — Accept priority in create_task and update_task handlers

**File:** `mcp/handlers.mjs`

In `handleCreateTask`: destructure `priority = 'normal'` from args; validate it is one of `['low', 'normal', 'high', 'critical']`; store on `newTask`.

In `handleUpdateTask`: if `priority` is provided, validate and update `task.priority`.

### Step 3 — Add priority to tools-list schemas

**File:** `mcp/tools-list.mjs`

Add to both `create_task` and `update_task` `inputSchema.properties`:

```js
priority: {
  type: 'string',
  enum: ['low', 'normal', 'high', 'critical'],
  description: 'Dispatch priority. Default: normal. critical > high > normal > low.',
},
```

### Step 4 — Include priority in list_tasks summary fields

**File:** `mcp/handlers.mjs`

Add `'priority'` to `LIST_TASK_FIELDS` set so it appears in the summary projection.

### Step 5 — Update backlog schema

**File:** `lib/ajvFactory.mjs` or the inline task schema — add `priority` enum field (optional, default `"normal"`).

---

## Acceptance criteria

- [ ] A `critical` task is dispatched before a `normal` task in the same eligible set.
- [ ] A task created without `priority` is treated as `normal` in scheduler and returned as `"normal"` in `get_task`.
- [ ] `create_task({ priority: "high" })` stores `priority: "high"` on the task.
- [ ] `update_task({ priority: "critical" })` updates the field without touching status or owner.
- [ ] `list_tasks` summary includes `priority` field.
- [ ] `create_task` with an invalid priority (e.g. `"urgent"`) throws a validation error.
- [ ] Tasks with equal priority retain their original relative order (stable sort).
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `lib/taskScheduler.test.mjs`:

```js
it('nextEligibleTaskFromBacklog returns critical task before normal task');
it('nextEligibleTaskFromBacklog treats missing priority as normal');
it('nextEligibleTaskFromBacklog preserves FIFO order within same priority');
```

**File:** `mcp/handlers.test.mjs`:

```js
it('handleCreateTask stores priority field on new task');
it('handleUpdateTask updates priority field');
it('handleCreateTask throws on invalid priority value');
```

---

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

```bash
npm run orc:doctor
```

## Risk / Rollback

**Risk:** Existing tasks in `backlog.json` have no `priority` field. The scheduler and handlers default to `normal`, so no behaviour change. If the AJV schema validation is strict (no additional properties), it may reject existing tasks on next read. Ensure the schema field is `optional` with `default: "normal"`.

**Rollback:** `git restore lib/taskScheduler.mjs mcp/handlers.mjs mcp/tools-list.mjs && npm test`
