# Task 82 — MCP Write Tools: `create_task` and `delegate_task`

Depends on Tasks 80–81. Blocks Tasks 83–84.

## Scope

**In scope:**
- `mcp/handlers.mjs` — add `handleCreateTask` and `handleDelegateTask`
- `mcp/server.mjs` — register write tools
- `mcp/handlers.test.mjs` — add write tool tests

**Out of scope:**
- New task lifecycle operations beyond create and delegate
- `orc-start-session` integration (Task 83)
- Master bootstrap (Task 84)

---

## Context

### Why write tools via MCP instead of CLI

Master currently calls `orc-task-create --title="..." --ac="..."` via the Bash tool.
This has two problems for a planning agent:
1. **Shell escaping** — multi-line descriptions or titles with quotes/backticks break flag parsing
2. **Token cost** — master must construct exact CLI syntax each time

With MCP write tools, master passes structured JSON to `create_task`. No shell escaping.
Multi-line descriptions, quoted text, and complex acceptance criteria all work cleanly.

### Source of truth: CLI logic

The write tools replicate the validation and state-mutation logic from:
- `create_task` → mirrors `cli/task-create.mjs`
- `delegate_task` → mirrors `cli/delegate-task.mjs`

Both use the same primitives:
```js
import { withLock }            from '../lib/lock.mjs';
import { atomicWriteJson }     from '../lib/atomicWrite.mjs';
import { appendSequencedEvent } from '../lib/eventLog.mjs';
import { readJson, findTask, readClaims } from '../lib/stateReader.mjs';
import { listAgents }          from '../lib/agentRegistry.mjs';
import { selectAutoTarget }    from '../lib/dispatchPlanner.mjs';
import { canAgentExecuteTask } from '../lib/taskRouting.mjs';
```

### No new library layer

The handlers call the same library functions as the CLIs. No new abstraction is needed.
This avoids a refactor risk — the CLI tools remain as-is, the MCP handlers are an
additive layer that reads/writes state identically.

---

## Goals

1. `create_task` accepts all fields that `orc-task-create` accepts via flags.
2. `delegate_task` accepts all fields that `orc-delegate` accepts, including auto-target.
3. Both use `withLock` + `atomicWriteJson` + `appendSequencedEvent` for consistency.
4. Validation errors return `{ isError: true }` responses — never crash the server.
5. `actor_id` defaults to the calling master's `agent_id` when not provided.

---

## Implementation

### `handleCreateTask(stateDir, args)`

```
params:
  epic             — required; epic ref (e.g. 'project')
  title            — required; task title (plain text, no shell escaping needed)
  ref?             — optional slug; auto-slugified from title if absent
  task_type?       — 'implementation' | 'refactor'  (default: 'implementation')
  description?     — free-form text; may be multi-line
  acceptance_criteria?  — string[] (each criterion as a separate string)
  depends_on?      — string[] of task refs
  required_capabilities?  — string[]
  owner?           — agent_id to pre-assign
  actor_id?        — defaults to 'master' if not provided
```

Validation rules (mirror `task-create.mjs` exactly — do not skip any):
- `epic` and `title` required
- `task_type` must be `implementation` or `refactor`
- `actor_id` must match `/^[a-z0-9][a-z0-9-]*$/`
- `owner` must match same pattern if provided
- Task ref format: `{epic}/{slug}` must match `/^[a-z0-9-]+\/[a-z0-9-]+$/`
- Epic must exist in `backlog.json`
- Task ref must not already exist
- All `depends_on` refs must exist in `backlog.json` (same check as CLI lines 113–122)
- Empty arrays for `depends_on`, `acceptance_criteria`, `required_capabilities` should
  be omitted from the stored object (same as CLI lines 93–95):
  ```js
  for (const key of ['depends_on', 'acceptance_criteria', 'required_capabilities']) {
    if ((newTask[key]?.length ?? 0) === 0) delete newTask[key];
  }
  ```

`slugify` function (copy from `task-create.mjs` lines 40–46):
```js
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
```

Event emitted: `task_added` (same payload as CLI).

Returns: the created task object.

### `handleDelegateTask(stateDir, args)`

```
params:
  task_ref         — required; e.g. 'project/feat-login'
  target_agent_id? — if omitted, auto-selects via selectAutoTarget()
  task_type?       — 'implementation' | 'refactor'  (default: 'implementation')
  note?            — optional note string
  actor_id?        — defaults to 'master' if not provided
```

Validation rules (mirror `delegate-task.mjs` exactly):
- `task_ref` required
- `actor_id` must match `/^[a-z0-9][a-z0-9-]*$/`
- If `actor_id !== 'human'`: must be a registered agent (checked against `listAgents()`)
- If `target_agent_id` provided: agent must exist; must pass `canAgentExecuteTask`
- If `target_agent_id` absent: `selectAutoTarget()` picks the agent; may return null
  (no eligible worker) — return `{ warning: 'no_eligible_worker', task_ref }` in that case
- `task_type` must be `implementation` or `refactor`

Event emitted: `task_delegated` (same payload as CLI).

Returns: `{ task_ref, assigned_to: agentId | null }`.

### Add to `handlers.mjs`

```js
import { join } from 'node:path';
import { withLock } from '../lib/lock.mjs';
import { atomicWriteJson } from '../lib/atomicWrite.mjs';
import { appendSequencedEvent } from '../lib/eventLog.mjs';
import { readJson, findTask, readClaims } from '../lib/stateReader.mjs';
import { listAgents } from '../lib/agentRegistry.mjs';
import { selectAutoTarget } from '../lib/dispatchPlanner.mjs';
import { canAgentExecuteTask } from '../lib/taskRouting.mjs';

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

export function handleCreateTask(stateDir, args = {}) {
  const { epic, title, task_type = 'implementation', actor_id = 'master', ...rest } = args;
  if (!epic)  throw new Error('epic is required');
  if (!title) throw new Error('title is required');
  if (!['implementation', 'refactor'].includes(task_type)) {
    throw new Error(`Invalid task_type: ${task_type}`);
  }

  const slug    = rest.ref ?? slugify(title);
  const taskRef = `${epic}/${slug}`;
  if (!slug || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(taskRef)) {
    throw new Error(`Invalid task ref: ${taskRef}`);
  }

  const now = new Date().toISOString();

  return withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readJson(stateDir, 'backlog.json');

    const epicObj = (backlog.epics ?? []).find((e) => e.ref === epic);
    if (!epicObj) throw new Error(`Epic not found: ${epic}`);
    if ((epicObj.tasks ?? []).some((t) => t.ref === taskRef)) {
      throw new Error(`Task already exists: ${taskRef}`);
    }

    const newTask = {
      ref: taskRef, title, status: 'todo',
      task_type, planning_state: 'ready_for_dispatch',
      delegated_by: actor_id,
      created_at: now, updated_at: now,
    };
    if (rest.description)            newTask.description = rest.description;
    if (rest.acceptance_criteria?.length) newTask.acceptance_criteria = rest.acceptance_criteria;
    if (rest.depends_on?.length)     newTask.depends_on = rest.depends_on;
    if (rest.required_capabilities?.length) newTask.required_capabilities = rest.required_capabilities;
    if (rest.owner)                  newTask.owner = rest.owner;

    epicObj.tasks = [...(epicObj.tasks ?? []), newTask];
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(stateDir, {
      ts: now, event: 'task_added',
      actor_type: actor_id === 'human' ? 'human' : 'agent', actor_id,
      task_ref: taskRef,
      payload: { title, task_type, epic_ref: epic },
    }, { lockAlreadyHeld: true });

    return newTask;
  });
}

export function handleDelegateTask(stateDir, args = {}) {
  const { task_ref, target_agent_id, task_type = 'implementation',
          note = null, actor_id = 'master' } = args;
  if (!task_ref) throw new Error('task_ref is required');

  const now = new Date().toISOString();

  return withLock(join(stateDir, '.lock'), () => {
    const backlogPath = join(stateDir, 'backlog.json');
    const backlog = readJson(stateDir, 'backlog.json');
    const claims  = readClaims(stateDir).claims ?? [];

    let task = null, epicRef = null;
    for (const e of backlog.epics ?? []) {
      task = (e.tasks ?? []).find((t) => t.ref === task_ref);
      if (task) { epicRef = e.ref; break; }
    }
    if (!task) throw new Error(`Task not found: ${task_ref}`);

    const allAgents = listAgents(stateDir);
    let assignedTarget = target_agent_id;

    if (assignedTarget) {
      const target = allAgents.find((a) => a.agent_id === assignedTarget);
      if (!target) throw new Error(`Target agent not found: ${assignedTarget}`);
      if (!canAgentExecuteTask({ ...task, task_type }, target)) {
        throw new Error(`Agent ${assignedTarget} cannot execute task type ${task_type}`);
      }
    } else {
      assignedTarget = selectAutoTarget({ task, taskType: task_type, allAgents, claims });
    }

    task.task_type = task_type;
    task.planning_state = 'ready_for_dispatch';
    task.delegated_by = actor_id;
    if (assignedTarget) task.owner = assignedTarget;
    if (task.status === 'blocked') task.status = 'todo';
    task.updated_at = now;
    atomicWriteJson(backlogPath, backlog);

    appendSequencedEvent(stateDir, {
      ts: now, event: 'task_delegated',
      actor_type: actor_id === 'human' ? 'human' : 'agent', actor_id,
      task_ref, ...(assignedTarget ? { agent_id: assignedTarget } : {}),
      payload: { target_agent_id: assignedTarget ?? null, task_type, note, epic_ref: epicRef,
                 auto_assigned: !target_agent_id },
    }, { lockAlreadyHeld: true });

    if (!assignedTarget) {
      return { warning: 'no_eligible_worker', task_ref };
    }
    return { task_ref, assigned_to: assignedTarget };
  });
}
```

### Register in `server.mjs`

Add two entries to the TOOLS array (exported from server.mjs, defined in Task 81):
```js
{
  name: 'create_task',
  description: 'Create a new task in the backlog. Returns the created task object.',
  inputSchema: {
    type: 'object',
    required: ['epic', 'title'],
    properties: {
      epic:                  { type: 'string', description: 'Epic ref (must already exist)' },
      title:                 { type: 'string', description: 'Task title (plain text)' },
      ref:                   { type: 'string', description: 'Explicit slug; auto-generated from title if omitted' },
      task_type:             { type: 'string', enum: ['implementation','refactor'], description: 'Default: implementation' },
      description:           { type: 'string', description: 'Detailed description; may be multi-line' },
      acceptance_criteria:   { type: 'array', items: { type: 'string' }, description: 'Each criterion as a separate string' },
      depends_on:            { type: 'array', items: { type: 'string' }, description: 'Task refs this task depends on' },
      required_capabilities: { type: 'array', items: { type: 'string' } },
      owner:                 { type: 'string', description: 'Pre-assign to agent_id' },
      actor_id:              { type: 'string', description: 'Defaults to master agent_id' },
    },
  },
},
{
  name: 'delegate_task',
  description: 'Assign a task to a worker. Auto-selects if target_agent_id omitted.',
  inputSchema: {
    type: 'object',
    required: ['task_ref'],
    properties: {
      task_ref:         { type: 'string', description: 'Full task ref, e.g. "project/feat-login"' },
      target_agent_id:  { type: 'string', description: 'Agent to assign to; auto-selects if omitted' },
      task_type:        { type: 'string', enum: ['implementation','refactor'], description: 'Default: implementation' },
      note:             { type: 'string', description: 'Optional note for delegation context' },
      actor_id:         { type: 'string', description: 'Defaults to master agent_id' },
    },
  },
},
```

Add cases in CallToolRequestSchema handler:
```js
case 'create_task':
  return { content: [{ type: 'text', text: JSON.stringify(handlers.handleCreateTask(STATE_DIR, args)) }] };
case 'delegate_task':
  return { content: [{ type: 'text', text: JSON.stringify(handlers.handleDelegateTask(STATE_DIR, args)) }] };
```

---

## Acceptance criteria

- [ ] `create_task` creates task in backlog.json with correct fields.
- [ ] `create_task` emits `task_added` event to events.jsonl.
- [ ] `create_task` returns the created task object.
- [ ] `create_task` with missing `epic` or `title` returns `isError: true`.
- [ ] `create_task` with duplicate task_ref returns `isError: true`.
- [ ] `create_task` with non-existent epic returns `isError: true`.
- [ ] `create_task` with multi-line description stores it correctly (no shell escaping issues).
- [ ] `create_task` with `depends_on` refs that don't exist returns `isError: true`.
- [ ] `create_task` with empty `acceptance_criteria: []` does NOT store the empty array key.
- [ ] `create_task` with `actor_id` that fails regex returns `isError: true`.
- [ ] `delegate_task` updates task owner and planning_state in backlog.json.
- [ ] `delegate_task` emits `task_delegated` event to events.jsonl.
- [ ] `delegate_task` auto-selects agent when `target_agent_id` absent.
- [ ] `delegate_task` returns `{ warning: 'no_eligible_worker' }` when no agent available.
- [ ] `delegate_task` with invalid `target_agent_id` returns `isError: true`.

---

## Tests

**File:** `mcp/handlers.test.mjs` — add to existing file.

```js
describe('handleCreateTask()', () => {
  it('creates task with auto-slugified ref', () => { ... });
  it('creates task with explicit ref', () => { ... });
  it('stores multi-line description verbatim', () => { ... });
  it('throws when epic not found', () => { ... });
  it('throws when task ref already exists', () => { ... });
  it('emits task_added event', () => { ... });
});

describe('handleDelegateTask()', () => {
  it('assigns to target agent when provided', () => { ... });
  it('auto-selects agent when target_agent_id absent', () => { ... });
  it('returns warning when no eligible agent', () => { ... });
  it('emits task_delegated event', () => { ... });
  it('throws when task not found', () => { ... });
});
```

---

## Verification

```bash
cd orchestrator && npm test -- mcp/handlers
npm test
```
