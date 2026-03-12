# Task 98 — Fix delegate-task CLI Stale-Owner Divergence from MCP Handler

Independent. Can run in parallel with Tasks 94–97.

## Scope

**In scope:**
- `cli/delegate-task.mjs` — add stale-owner clearing when no eligible target is found (mirrors `mcp/handlers.mjs` behaviour)
- `cli/delegate-task.test.mjs` — add regression test for the stale-owner path

**Out of scope:**
- `mcp/handlers.mjs` — already correct; do not touch
- Any schema or state file changes

---

## Context

`cli/delegate-task.mjs` and `mcp/handlers.mjs` both implement task delegation but diverge on
one branch: when auto-selection finds no eligible target agent.

**`mcp/handlers.mjs` (correct, lines 284–285):**
```js
} else if (task.owner) {
  delete task.owner; // clear stale owner when no target found
}
```

**`cli/delegate-task.mjs` (bug, lines 93–99):**
```js
const autoTarget = selectAutoTarget(agents, task);
if (autoTarget) {
  task.owner = autoTarget.agent_id;
} else {
  // ← stale task.owner is NOT cleared here
}
```

A task delegated via the CLI to an agent that goes offline retains its stale `owner` field.
On the next delegation attempt with no explicit `--target-agent-id`, the scheduler sees the
stale owner and may skip the task or wait for a specific agent that will never come back.

**Affected files:**
- `cli/delegate-task.mjs` — lines 93–99
- `cli/delegate-task.test.mjs` — regression test

---

## Goals

1. Must clear `task.owner` when `selectAutoTarget` returns null and `task.owner` is set.
2. Must preserve `task.owner` when `selectAutoTarget` returns a valid target (existing behaviour).
3. Must add a regression test that verifies the stale owner is absent after a failed auto-selection.
4. Must not change any other behaviour in `delegate-task.mjs`.

---

## Implementation

### Step 1 — Fix the else branch in `delegate-task.mjs`

**File:** `cli/delegate-task.mjs`

Find and replace the auto-target block:

```js
// BEFORE
const autoTarget = selectAutoTarget(agents, task);
if (autoTarget) {
  task.owner = autoTarget.agent_id;
}
```

```js
// AFTER
const autoTarget = selectAutoTarget(agents, task);
if (autoTarget) {
  task.owner = autoTarget.agent_id;
} else if (task.owner) {
  delete task.owner; // clear stale owner; mirrors mcp/handlers.mjs:284-285
}
```

No other changes in this file.

### Step 2 — Add regression test

**File:** `cli/delegate-task.test.mjs`

Add inside the existing describe block:

```js
it('clears stale task.owner when no eligible agent is found', () => {
  // Seed a task with a stale owner referencing an offline agent
  const stateDir = makeStateDir();
  seedTask(stateDir, { ref: 'orch/stale', owner: 'dead-worker', status: 'todo' });
  // No agents registered → selectAutoTarget returns null

  const result = spawnSync(process.execPath, [DELEGATE_TASK_PATH,
    '--task-ref=orch/stale'], {
    env: { ...process.env, ORCH_STATE_DIR: stateDir },
    encoding: 'utf8',
  });

  const backlog = readJson(stateDir, 'backlog.json');
  const task = findTask(backlog, 'orch/stale');
  expect(task.owner).toBeUndefined();
  expect(result.stdout).toContain('no eligible worker');
});
```

Adapt helper names to match existing `delegate-task.test.mjs` scaffolding.

---

## Acceptance criteria

- [ ] When `selectAutoTarget` returns null and `task.owner` is set, `task.owner` is deleted before writing backlog.
- [ ] When `selectAutoTarget` returns a valid agent, `task.owner` is set to that agent's ID (no change to existing behaviour).
- [ ] Regression test confirms `task.owner` is absent after a failed auto-selection.
- [ ] All existing `delegate-task.test.mjs` tests still pass.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs cli/delegate-task.test.mjs
```

---

## Verification

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** None — the fix brings the CLI into alignment with the MCP handler; no existing tests exercise the missing branch.
**Rollback:** `git restore cli/delegate-task.mjs`
