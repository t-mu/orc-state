---
ref: orch/task-117-agent-ttl-deregistration
epic: orch
status: done
---

# Task 117 — Add Agent TTL and Deregistration

Independent. Blocks Task 121 (multi-worker dispatch improvements depend on accurate agent liveness).

## Scope

**In scope:**
- `coordinator.mjs` — add TTL tick step that marks agents `dead` when heartbeat is absent beyond threshold
- `lib/agentRegistry.mjs` — add `markAgentDead(stateDir, agentId)` and `deregisterAgent(stateDir, agentId)` helpers
- `lib/dispatchPlanner.mjs` — exclude `dead` agents from candidate list
- `mcp/handlers.mjs` — `handleListAgents`: exclude `dead` by default; add `include_dead` param
- `mcp/tools-list.mjs` — add `include_dead` boolean param to `list_agents` schema
- `cli/deregister-agent.mjs` — new CLI command `orc-deregister <agent_id>`
- `orchestrator/package.json` — register `orc-deregister` bin entry
- Test files for agentRegistry, coordinator tick, and CLI

**Out of scope:**
- Changes to worker heartbeat intervals or the heartbeat event schema
- Changes to `claims.json` structure
- Automatic PTY termination of dead agents (operator responsibility)

---

## Context

Agents are registered in `agents.json` on first connect and never removed. When a PTY session dies, the coordinator sets `status: idle` (commit 17b847e) but never advances to a terminal state. After a long absence the agent remains `status: running` or `status: idle` in the registry indefinitely.

This produces three failure modes observed in production:
1. `list_agents()` shows stale workers as `running`, misleading the operator
2. `selectAutoTarget()` in `dispatchPlanner.mjs` may select a dead agent, causing tasks to be dispatched into a black hole until the lease expires
3. The status overview always warns about missing heartbeats even when the worker was intentionally shut down

The coordinator already reads `last_heartbeat_at` and `registered_at` per agent. Adding a TTL check on each tick is low-risk: it only writes to `agents.json` (lock-protected) and does not touch `claims.json` or the event log.

**Affected files:**
- `lib/agentRegistry.mjs` — agent read/write helpers
- `coordinator.mjs` — main tick loop
- `lib/dispatchPlanner.mjs` — `selectDispatchableAgents`
- `mcp/handlers.mjs` — `handleListAgents`
- `mcp/tools-list.mjs` — `list_agents` schema
- `cli/deregister-agent.mjs` — new file
- `orchestrator/package.json` — bin entries

---

## Goals

1. Must mark agents `dead` when `last_heartbeat_at` (or `registered_at` if no heartbeat ever received) is older than `AGENT_TTL_MS` (default 2 hours).
2. Must exclude `dead` agents from auto-dispatch candidates in `selectDispatchableAgents`.
3. Must exclude `dead` agents from `handleListAgents` by default; expose them with `include_dead: true`.
4. Must provide `orc-deregister <agent_id>` CLI that removes an agent from `agents.json` only when it has no active claim.
5. Must emit an `agent_marked_dead` event to `events.jsonl` when TTL expires.
6. Must not mark an agent dead if it currently holds an active claim (coordinator skips TTL check for agents with `claimed` or `in_progress` claim state).

---

## Implementation

### Step 1 — Add markAgentDead helper

**File:** `lib/agentRegistry.mjs`

```js
export function markAgentDead(stateDir, agentId) {
  return withLock(join(stateDir, '.lock'), () => {
    const data = readJson(stateDir, 'agents.json');
    const agent = data.agents.find((a) => a.agent_id === agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    agent.status = 'dead';
    agent.last_status_change_at = new Date().toISOString();
    atomicWriteJson(join(stateDir, 'agents.json'), data);
  });
}

export function deregisterAgent(stateDir, agentId) {
  // Only call after confirming no active claim exists.
  return withLock(join(stateDir, '.lock'), () => {
    const data = readJson(stateDir, 'agents.json');
    const idx = data.agents.findIndex((a) => a.agent_id === agentId);
    if (idx === -1) throw new Error(`Agent not found: ${agentId}`);
    data.agents.splice(idx, 1);
    atomicWriteJson(join(stateDir, 'agents.json'), data);
  });
}
```

### Step 2 — Add TTL tick step to coordinator

**File:** `coordinator.mjs`

Add `enforceAgentTtl(stateDir, activeClaims)` called once per tick after lease expiration, before dispatch. The function:
- Reads all agents
- Skips agents with `role: 'master'`
- Skips agents with an active claim (`claimed` or `in_progress`)
- For each remaining agent: computes elapsed ms since `last_heartbeat_at ?? registered_at`
- If elapsed > `AGENT_TTL_MS` (2 * 60 * 60 * 1000) and `status !== 'dead'`: calls `markAgentDead` and appends `agent_marked_dead` event

```js
const AGENT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
```

### Step 3 — Exclude dead agents from dispatch

**File:** `lib/dispatchPlanner.mjs`

```js
// Before:
agents.filter((a) => a.role !== 'master' && a.status !== 'offline')

// After:
agents.filter((a) => a.role !== 'master' && a.status !== 'offline' && a.status !== 'dead')
```

### Step 4 — Filter dead from handleListAgents

**File:** `mcp/handlers.mjs`

```js
export function handleListAgents(stateDir, { role, include_dead = false } = {}) {
  let agents = listAgents(stateDir);
  if (!include_dead) agents = agents.filter((a) => a.status !== 'dead');
  if (role) agents = agents.filter((a) => a.role === role);
  return agents;
}
```

**File:** `mcp/tools-list.mjs` — add to `list_agents` inputSchema properties:
```js
include_dead: {
  type: 'boolean',
  description: 'Include dead agents in results (default: false)',
}
```

### Step 5 — CLI deregister command

**File:** `cli/deregister-agent.mjs`

```js
// Usage: orc-deregister <agent_id>
// Guards: agent must exist; agent must have no active claim
// On success: calls deregisterAgent(), prints confirmation
// On failure: prints error and exits 1
```

**File:** `orchestrator/package.json` — add bin entry:
```json
"orc-deregister": "./cli/deregister-agent.mjs"
```

---

## Acceptance criteria

- [ ] An agent with `last_heartbeat_at` older than 2 hours and no active claim is marked `dead` on the next coordinator tick.
- [ ] An agent with an active claim is never marked `dead` regardless of heartbeat age.
- [ ] `handleListAgents()` without `include_dead` omits agents with `status: dead`.
- [ ] `handleListAgents({ include_dead: true })` includes dead agents.
- [ ] `orc-deregister <agent_id>` removes an agent that has no active claim and exits 0.
- [ ] `orc-deregister <agent_id>` exits 1 with a descriptive error when the agent has an active claim.
- [ ] `orc-deregister <agent_id>` exits 1 when the agent does not exist.
- [ ] An `agent_marked_dead` event is appended to `events.jsonl` with `agent_id` and `elapsed_ms`.
- [ ] `selectDispatchableAgents` never returns a `dead` agent.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `lib/agentRegistry.test.mjs` (new or extend existing):

```js
it('markAgentDead sets status to dead and updates last_status_change_at');
it('deregisterAgent removes agent from agents.json');
it('deregisterAgent throws when agent not found');
```

**File:** `orchestrator/coordinator.test.mjs`:

```js
it('enforceAgentTtl marks agent dead when heartbeat older than TTL');
it('enforceAgentTtl skips agent with active claim even if heartbeat is stale');
it('enforceAgentTtl skips master agent');
it('enforceAgentTtl emits agent_marked_dead event');
```

**File:** `mcp/handlers.test.mjs`:

```js
it('handleListAgents excludes dead agents by default');
it('handleListAgents includes dead agents when include_dead=true');
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

**Risk:** If the TTL threshold is too aggressive, legitimate idle workers could be prematurely marked dead during a coordinator restart or a worker pause. The 2-hour default is conservative; workers heartbeat every ~60s normally.

**Rollback:** `git restore lib/agentRegistry.mjs coordinator.mjs lib/dispatchPlanner.mjs && npm test`; manually reset any incorrectly-dead agents in `agents.json` by setting `status` back to `idle`.
