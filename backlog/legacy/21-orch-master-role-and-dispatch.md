# Task 21 — Orchestrator: Master Agent Role and Dispatcher Exclusion

> **Part D — Master Agent, Step 3 of 4.** Requires Tasks 19 and 20 to be complete first.

## Context

The orchestrator currently has two roles: `worker` and `reviewer`. The master agent is a third
kind of participant: it creates and delegates tasks but must never *receive* a task itself. If
the coordinator dispatches a task to the master agent it will break — the master agent is
not listening for `TASK_START` blocks.

Two places enforce dispatch eligibility:

1. `lib/dispatchPlanner.mjs` — `selectDispatchableAgents()` filters the candidate pool.
2. `lib/taskRouting.mjs` — `canAgentExecuteTaskType()` gates by role and capabilities.

The simplest fix is to exclude `role: 'master'` agents in `selectDispatchableAgents`. This
is a one-line change plus a schema update.

---

## Goals

1. Add `'master'` to the `role` enum in `schemas/agents.schema.json`.
2. Exclude agents with `role: 'master'` from `selectDispatchableAgents`.
3. Register the master agent in `state/agents.json` with the new role.

---

## Step-by-Step Instructions

### Step 1 — Update `schemas/agents.schema.json`

Find the `role` property definition inside the `Agent` definition:

```json
"role": {
  "type": "string",
  "enum": ["worker", "reviewer"],
  "description": "Primary orchestration role. Workers execute implementation tasks; planners delegate/specify work."
}
```

Change to:

```json
"role": {
  "type": "string",
  "enum": ["worker", "reviewer", "master"],
  "description": "Primary orchestration role. Workers and reviewers execute tasks; master creates and delegates tasks only."
}
```

### Step 2 — Update `lib/dispatchPlanner.mjs`

In `selectDispatchableAgents`, add one condition to the filter:

```js
// BEFORE:
export function selectDispatchableAgents(agents, { busyAgents = new Set() } = {}) {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && a.session_handle != null
      && !busyAgents.has(a.agent_id),
  );
}

// AFTER:
export function selectDispatchableAgents(agents, { busyAgents = new Set() } = {}) {
  return (agents ?? []).filter(
    (a) => a.status !== 'offline'
      && a.session_handle != null
      && a.role !== 'master'
      && !busyAgents.has(a.agent_id),
  );
}
```

### Step 3 — Register the master agent in `state/agents.json`

Add the master agent entry to the `agents` array. The `agent_id` can be any valid kebab-case
string; `master` or `master-01` are recommended. Use `provider: 'claude'` unless the operator
prefers a different provider.

```json
{
  "agent_id": "master",
  "provider": "claude",
  "role": "master",
  "status": "offline",
  "session_handle": null,
  "provider_ref": null,
  "registered_at": "<current ISO timestamp>"
}
```

> **Note:** `status: 'offline'` and `session_handle: null` are correct for a freshly registered
> agent that has not yet been started. The coordinator will start a session when it ticks, or
> the operator can call `npm run orc:worker:start-session -- master`.

### Step 4 — Update `dispatchPlanner.test.mjs`

The test file at `lib/dispatchPlanner.test.mjs` tests `selectDispatchableAgents`.
Add a test case:

```js
it('excludes master-role agents from dispatch', () => {
  const agents = [
    { agent_id: 'worker-01', role: 'worker',  status: 'running', session_handle: 'h1' },
    { agent_id: 'master',    role: 'master',  status: 'running', session_handle: 'h2' },
  ];
  const result = selectDispatchableAgents(agents);
  expect(result.map((a) => a.agent_id)).toEqual(['worker-01']);
});
```

### Step 5 — Run tests

```
nvm use 22 && npm run test:orch
```

Also run `npm run orc:doctor` and verify it reports no validation errors for the updated
`agents.json`.

---

## Acceptance Criteria

- [ ] `schemas/agents.schema.json` accepts `role: 'master'`.
- [ ] `selectDispatchableAgents` never returns an agent with `role: 'master'`.
- [ ] `state/agents.json` contains a master agent entry.
- [ ] New test in `dispatchPlanner.test.mjs` passes.
- [ ] `npm run orc:doctor` reports no errors.
- [ ] All orchestrator tests pass.
