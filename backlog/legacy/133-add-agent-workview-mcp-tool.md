---
ref: orch/task-133-add-agent-workview-mcp-tool
epic: orch
status: done
---

# Task 133 — Add Agent Workview MCP Tool

Depends on Task 132. Builds on Task 123 and complements, but does not replace, existing MCP read tools.

## Scope

**In scope:**
- `mcp/tools-list.mjs` — add a compact agent-oriented read tool
- `mcp/handlers.mjs` — implement the workview handler
- `mcp/server.mjs` — wire the new tool
- `mcp/handlers.test.mjs` and `mcp/server.protocol.test.mjs` — cover handler behavior and MCP transport
- Relevant master bootstrap templates — document when to use the new tool first

**Out of scope:**
- Replacing `list_tasks`, `get_task`, or `get_status`
- Moving worker progress reporting from CLI commands to MCP
- Changing dispatch policy or claim state semantics

## Context

The MCP layer is competent but still fairly low-level. A master LLM can list tasks, list agents, and fetch status, but it still has to assemble a useful "what should this agent do next?" view manually. That increases tool round-trips, tokens, and the chance of inconsistent interpretations between sessions.

This task should add one compact read tool focused on agent actionability. It should answer whether an agent currently has assigned work, what run state applies, what blockers exist, and what the recommended next action is. It should use existing state and routing logic rather than inventing a second decision engine.

**Affected files:**
- `mcp/tools-list.mjs` — tool schema
- `mcp/handlers.mjs` — workview implementation
- `mcp/server.mjs` — MCP dispatch
- `mcp/handlers.test.mjs` — unit tests
- `mcp/server.protocol.test.mjs` — stdio protocol coverage
- `templates/master-bootstrap-v1.txt` — read-state guidance
- `templates/master-bootstrap-codex-v1.txt` — read-state guidance
- `templates/master-bootstrap-gemini-v1.txt` — read-state guidance

## Goals

1. Must provide a single MCP read tool that summarizes one agent's actionable work state.
2. Must include assigned active run information, queued owned tasks, and blocking reasons when work is not actionable.
3. Must include an explicit recommended next action such as `start_run`, `heartbeat`, `idle`, or `reassign`.
4. Must stay compact enough to replace multiple list/read tool calls in common master-agent workflows.
5. Must reuse existing status and routing semantics rather than creating divergent logic.

## Implementation

### Step 1 — Add a new tool definition

**File:** `mcp/tools-list.mjs`

```js
{
  name: 'get_agent_workview',
  description: 'Return a compact actionable work summary for one agent.',
  inputSchema: {
    type: 'object',
    required: ['agent_id'],
    properties: {
      agent_id: { type: 'string' },
    },
    additionalProperties: false,
  },
}
```

Keep the tool read-only and intentionally compact.

### Step 2 — Build the workview from existing state

**File:** `mcp/handlers.mjs`

```js
export function handleGetAgentWorkview(stateDir, { agent_id } = {}) {
  return {
    agent_id,
    active_run: null,
    queued_tasks: [],
    blockers: [],
    recommended_action: 'idle',
  };
}
```

Use existing claim state, owned tasks, dependency resolution, and routing diagnostics. Do not duplicate coordinator scheduling logic beyond what is needed for a read model.

### Step 3 — Wire and document the tool

**Files:** `mcp/server.mjs`, master bootstrap templates

Document a clear usage rule such as: "Use `get_agent_workview` first when deciding what a specific worker should do next; use `get_task` only for deep task detail."

### Step 4 — Add handler and protocol tests

**Files:** `mcp/handlers.test.mjs`, `mcp/server.protocol.test.mjs`

```js
it('returns active_run and recommended_action=start_run for a claimed task');
it('returns recommended_action=heartbeat for stale in_progress work');
it('returns blockers for queued tasks that are not yet dispatchable');
it('is available over stdio MCP protocol');
```

## Acceptance criteria

- [ ] `get_agent_workview` is listed as an MCP tool and works over the stdio MCP server.
- [ ] The tool returns a compact object for one agent including current run context, queued tasks, blockers, and `recommended_action`.
- [ ] The tool distinguishes at least: no work, claimed work awaiting start, in-progress work, and queued-but-blocked work.
- [ ] The tool reuses current routing/dependency semantics rather than inventing conflicting dispatch logic.
- [ ] Master bootstrap templates document when to prefer the new tool.
- [ ] No changes to files outside the stated scope.

## Tests

Add to `mcp/handlers.test.mjs`:

```js
it('returns an idle workview when the agent has no assigned work', () => { ... });
it('returns start_run recommendation for claimed work', () => { ... });
it('returns heartbeat recommendation for stale in_progress work', () => { ... });
it('includes blockers for owned tasks that are not actionable', () => { ... });
```

Add to `mcp/server.protocol.test.mjs`:

```js
it('lists and executes get_agent_workview over JSON-RPC', async () => { ... });
```

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

**Risk:** A new high-level read tool can become a second source of truth if it drifts from existing status/routing semantics, especially around blocked or stale work.
**Rollback:** `git restore mcp/tools-list.mjs mcp/handlers.mjs mcp/server.mjs mcp/handlers.test.mjs mcp/server.protocol.test.mjs templates/master-bootstrap-v1.txt templates/master-bootstrap-codex-v1.txt templates/master-bootstrap-gemini-v1.txt && nvm use 24 && npm run test:orc`
