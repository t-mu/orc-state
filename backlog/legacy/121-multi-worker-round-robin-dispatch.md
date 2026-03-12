---
ref: orch/task-121-multi-worker-round-robin-dispatch
epic: orch
status: done
---

# Task 121 — Multi-Worker Round-Robin Dispatch and Active Task Visibility

Depends on Task 117 (agent TTL/dead status must be excluded from candidates before balancing matters). Independent of other tasks.

## Scope

**In scope:**
- `lib/dispatchPlanner.mjs` — replace first-match `selectAutoTarget` with round-robin selection; persist last-assigned agent to `orc-state/dispatch-state.json`
- `lib/stateReader.mjs` — add `readDispatchState` / `writeDispatchState` helpers
- `mcp/handlers.mjs` — `handleListAgents`: join active claim onto each agent as `active_task_ref`
- `lib/dispatchPlanner.test.mjs` (new or extend) — unit tests for round-robin logic
- `mcp/handlers.test.mjs` — test `active_task_ref` join

**Out of scope:**
- Weighted dispatch, affinity rules, or queue-depth-based scheduling
- Changes to the worker bootstrap or task envelope
- Changing how `delegate_task` with an explicit `target_agent_id` works (still overrides)
- Persistent task affinity ("always send task X to worker Y")

---

## Context

`selectAutoTarget()` in `dispatchPlanner.mjs` currently returns the first eligible agent from `selectDispatchableAgents()`. Agent order in `agents.json` is insertion order, so worker 1 always receives tasks until it is busy, and worker 2 only receives work when worker 1 has an active claim. With two or more workers running in parallel this produces serial dispatch instead of parallel utilisation.

Round-robin selection requires tracking which agent was last assigned. This state is written to `orc-state/dispatch-state.json` (a small, non-critical file). If the file is absent or corrupt, dispatch falls back to first-match gracefully.

The second part of this task adds `active_task_ref` to `list_agents()` output. Currently the operator must call `list_active_runs()` separately and manually correlate run → agent. Joining the active claim directly onto the agent response makes the status display much more useful.

**Affected files:**
- `lib/dispatchPlanner.mjs` — round-robin logic
- `lib/stateReader.mjs` — dispatch-state read/write
- `mcp/handlers.mjs` — `handleListAgents` join
- `mcp/handlers.test.mjs` — new join test
- `lib/dispatchPlanner.test.mjs` — round-robin tests

---

## Goals

1. Must select agents in round-robin order when multiple eligible agents are available.
2. Must fall back to first-match when `dispatch-state.json` is absent, corrupt, or all previously-seen agents are gone.
3. Must persist the last-assigned `agent_id` to `dispatch-state.json` after each auto-assignment.
4. Must include `active_task_ref: string | null` on every agent object returned by `handleListAgents`.
5. Must not change behaviour when `delegate_task` is called with an explicit `target_agent_id`.
6. Must pass all existing single-worker dispatch tests unchanged.

---

## Implementation

### Step 1 — Add dispatch-state helpers

**File:** `lib/stateReader.mjs`

```js
export function readDispatchState(stateDir) {
  try {
    return readJson(stateDir, 'dispatch-state.json');
  } catch {
    return { last_assigned_agent_id: null };
  }
}

export function writeDispatchState(stateDir, state) {
  atomicWriteJson(join(stateDir, 'dispatch-state.json'), state);
}
```

### Step 2 — Round-robin selectAutoTarget

**File:** `lib/dispatchPlanner.mjs`

```js
export function selectAutoTarget({ task, taskType, allAgents, claims, stateDir }) {
  const candidates = selectDispatchableAgents(allAgents, claims)
    .filter((a) => canAgentExecuteTask({ ...task, task_type: taskType }, a));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].agent_id;

  // Round-robin: find the candidate after the last-assigned one.
  const { last_assigned_agent_id } = stateDir ? readDispatchState(stateDir) : {};
  const lastIdx = candidates.findIndex((a) => a.agent_id === last_assigned_agent_id);
  const nextIdx = (lastIdx + 1) % candidates.length;
  const chosen = candidates[nextIdx];

  if (stateDir) writeDispatchState(stateDir, { last_assigned_agent_id: chosen.agent_id });
  return chosen.agent_id;
}
```

Update all callers of `selectAutoTarget` (in `handlers.mjs` `handleDelegateTask`) to pass `stateDir`.

### Step 3 — Join active_task_ref onto list_agents response

**File:** `mcp/handlers.mjs`

```js
export function handleListAgents(stateDir, { role, include_dead = false } = {}) {
  let agents = listAgents(stateDir);
  if (!include_dead) agents = agents.filter((a) => a.status !== 'dead');
  if (role) agents = agents.filter((a) => a.role === role);

  const activeClaims = (readClaims(stateDir).claims ?? [])
    .filter((c) => ['claimed', 'in_progress'].includes(c.state));
  const claimByAgent = Object.fromEntries(
    activeClaims.map((c) => [c.agent_id, c.task_ref])
  );

  return agents.map((a) => ({
    ...a,
    active_task_ref: claimByAgent[a.agent_id] ?? null,
  }));
}
```

---

## Acceptance criteria

- [ ] With two idle eligible workers, consecutive `delegate_task` calls (auto-select) assign to worker A, then worker B, then worker A again (round-robin).
- [ ] With one eligible worker, dispatch behaves identically to current behaviour.
- [ ] `dispatch-state.json` is created in `orc-state/` after the first auto-assignment.
- [ ] If `dispatch-state.json` is deleted, dispatch falls back to first-match without error.
- [ ] `handleListAgents` response includes `active_task_ref: "<ref>"` for agents with active claims.
- [ ] `handleListAgents` response includes `active_task_ref: null` for agents with no active claim.
- [ ] Explicit `target_agent_id` in `delegate_task` is unaffected by round-robin state.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `lib/dispatchPlanner.test.mjs`:

```js
it('selectAutoTarget returns agents in round-robin order across calls');
it('selectAutoTarget falls back to first-match when dispatch-state is absent');
it('selectAutoTarget returns null when no eligible agents');
```

**File:** `mcp/handlers.test.mjs`:

```js
it('handleListAgents includes active_task_ref joined from claims');
it('handleListAgents returns active_task_ref: null for idle agents');
```

---

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

```bash
npm run orc:doctor
npm run orc:status
```

## Risk / Rollback

**Risk:** `dispatch-state.json` is a new state file. If it is written with a partial value (crash mid-write), the next read falls back to first-match — no tasks are lost.

**Rollback:** `git restore lib/dispatchPlanner.mjs lib/stateReader.mjs mcp/handlers.mjs && rm -f orc-state/dispatch-state.json && npm test`
