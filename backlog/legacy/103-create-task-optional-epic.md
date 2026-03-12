---
ref: orch/task-103-create-task-optional-epic
epic: orch
status: done
---

# Task 103 — Make epic Optional in create_task MCP, Default to "general"

Independent. Blocks Task 104, Task 105.

## Scope

**In scope:**
- `mcp/tools-list.mjs` — remove `epic` from `required`; update description
- `mcp/handlers.mjs` `handleCreateTask` — default `epic` to `"general"`; auto-create `"general"` epic when absent
- `mcp/handlers.test.mjs` — add tests for the optional-epic path

**Out of scope:**
- Changes to `delegate_task`, `update_task`, `list_tasks`, or any other MCP tool
- Changes to `backlog.json` schema structure beyond auto-creating the "general" epic at runtime
- Changes to the create-task skill

## Context

Currently `epic` is in the `required` array of `create_task`. Any call that omits it fails with a validation error. This forces every caller — including the create-task skill — to resolve an epic before calling the tool, making it impossible to register a task quickly without first knowing which epic it belongs to.

Defaulting to `"general"` removes this friction: the tool stays backward-compatible (explicit epic still works), while callers that don't care about epic placement get a sensible home automatically.

The `"general"` epic must be auto-created if absent so the first call with a missing epic doesn't fail on `Epic not found`.

**Affected files:**
- `mcp/tools-list.mjs` — tool schema
- `mcp/handlers.mjs` — `handleCreateTask` business logic
- `mcp/handlers.test.mjs` — handler unit tests

## Goals

1. Must accept `create_task` calls where `epic` is omitted entirely.
2. Must default the epic to `"general"` when `epic` is omitted or an empty string.
3. Must auto-create a `"general"` epic (`{ ref: "general", title: "General", tasks: [] }`) in `backlog.json` when it does not already exist, inside the same lock as the task insertion.
4. Must continue to accept and use an explicit `epic` value when provided.
5. Must update `tools-list.mjs` description to document the default.

## Implementation

### Step 1 — Remove epic from required and update description

**File:** `mcp/tools-list.mjs`

```js
// Before:
required: ['epic', 'title'],
properties: {
  epic: { type: 'string', description: 'Epic ref (must already exist)' },

// After:
required: ['title'],
properties: {
  epic: { type: 'string', description: 'Epic ref. Defaults to "general" if omitted; the "general" epic is created automatically.' },
```

### Step 2 — Default epic and auto-create "general"

**File:** `mcp/handlers.mjs`

In `handleCreateTask`, after destructuring `args`:

```js
// Before:
if (!epic) throw new Error('epic is required');

// After:
const resolvedEpic = epic || 'general';
```

Then inside `withLock`, replace all uses of `epic` with `resolvedEpic`. Before the existing `epicObj` lookup, add:

```js
// Auto-create "general" epic if needed
if (resolvedEpic === 'general' && !(backlog.epics ?? []).find((e) => e.ref === 'general')) {
  backlog.epics = [...(backlog.epics ?? []), { ref: 'general', title: 'General', tasks: [] }];
}

const epicObj = (backlog.epics ?? []).find((candidate) => candidate.ref === resolvedEpic);
if (!epicObj) throw new Error(`Epic not found: ${resolvedEpic}`);
```

Invariant: the auto-create only runs inside the existing `withLock` block — no separate lock acquisition.

### Step 3 — Add handler tests

**File:** `mcp/handlers.test.mjs`

Add to the existing `describe` block:

```js
it('handleCreateTask defaults to "general" epic when epic is omitted', () => {
  const created = handleCreateTask(dir, { title: 'No epic task', actor_id: 'master' });
  expect(created.ref).toBe('general/no-epic-task');
  const backlog = readBacklog();
  const general = backlog.epics.find((e) => e.ref === 'general');
  expect(general).toBeDefined();
  expect(general.tasks.some((t) => t.ref === 'general/no-epic-task')).toBe(true);
});

it('handleCreateTask auto-creates "general" epic when absent', () => {
  // seed has no "general" epic
  const before = readBacklog();
  expect(before.epics.find((e) => e.ref === 'general')).toBeUndefined();
  handleCreateTask(dir, { title: 'Auto epic task', actor_id: 'master' });
  expect(readBacklog().epics.find((e) => e.ref === 'general')).toBeDefined();
});

it('handleCreateTask uses explicit epic when provided', () => {
  const created = handleCreateTask(dir, {
    epic: 'project',
    title: 'Explicit epic task',
    actor_id: 'master',
  });
  expect(created.ref).toMatch(/^project\//);
});
```

## Acceptance criteria

- [ ] `epic` is not in the `required` array of the `create_task` tool schema.
- [ ] Calling `create_task` without `epic` creates the task under the `"general"` epic.
- [ ] Calling `create_task` without `epic` when `"general"` does not exist in `backlog.json` auto-creates it and then creates the task.
- [ ] Calling `create_task` with an explicit `epic` still routes the task to that epic.
- [ ] Calling `create_task` with an explicit epic that does not exist still throws `Epic not found`.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `mcp/handlers.test.mjs` — three new `it(...)` cases as shown in Implementation Step 3.

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

## Risk / Rollback

**Risk:** Auto-creating the `"general"` epic mutates `backlog.json` on the first call that omits `epic`. If the write fails mid-lock the file could be left in a partial state; however `atomicWriteJson` uses rename-into-place so partial writes do not corrupt the file.

**Rollback:** `git restore mcp/tools-list.mjs mcp/handlers.mjs && npm test`
