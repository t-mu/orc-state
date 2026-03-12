# Task 81 — MCP Read Tools and Resources

Depends on Task 80. Blocks Tasks 83–84.

## Scope

**In scope:**
- `mcp/handlers.mjs` — pure handler functions for all read tools (no SDK dependency)
- `mcp/server.mjs` — register read tools and resources; wire to handlers
- `mcp/handlers.test.mjs` — unit tests for handler functions

**Out of scope:**
- Write tools (Task 82)
- `orc-start-session` integration (Task 83)
- Master bootstrap (Task 84)

---

## Context

### Architecture: handlers vs server

To keep the server testable without mocking MCP transports, split the logic:

```
mcp/
  server.mjs      — SDK wiring only: registerTools, registerResources, connect transport
  handlers.mjs    — pure async functions: (stateDir, args) → result object
```

Each handler function:
- Takes `(stateDir, args)` — no SDK types, no transport, no globals
- Returns a plain JS object (the tool result payload)
- Throws on validation errors (server.mjs wraps in `isError` response)

### State access pattern
All reads use `readJson` from `lib/stateReader.mjs`:
```js
import { readJson, findTask, readClaims } from '../lib/stateReader.mjs';
import { listAgents } from '../lib/agentRegistry.mjs';
```

### Events log format
`events.jsonl` — one JSON object per line. Read with `readFileSync`, split on `\n`,
filter empty lines, parse each. For `get_recent_events`, read from the end.

---

## Goals

1. Six read tools that give master structured access to all orchestrator state.
2. Two resources for passive context injection (backlog, agents).
3. All handlers are pure functions testable without MCP SDK.
4. Handler errors return structured `{ error: string }` — never crash the server.

---

## Read Tools to Implement

### 1. `list_tasks`

```
params:
  status?  — filter: 'todo' | 'claimed' | 'in_progress' | 'done' | 'blocked'
  epic?    — filter by epic ref (e.g. 'project')

returns: Task[]
  { ref, title, status, task_type, planning_state, delegated_by,
    owner?, description?, acceptance_criteria?, depends_on?,
    attempt_count?, created_at, updated_at }
```

Implementation: read `backlog.json` → flatten `epics[].tasks[]` → apply filters → return array.

### 2. `list_agents`

```
params:
  role?  — filter: 'worker' | 'reviewer' | 'master'

returns: Agent[]
  { agent_id, provider, role, status, session_handle, capabilities,
    last_heartbeat_at, registered_at }
```

Implementation: `listAgents(stateDir)` → apply role filter → return.

### 3. `list_active_runs`

```
params: (none)

returns: ActiveRun[]
  { run_id, task_ref, agent_id, state, claimed_at, started_at,
    last_heartbeat_at, lease_expires_at }
```

Implementation: `readClaims(stateDir).claims` → filter `state` in `['claimed', 'in_progress']`.

### 4. `list_stalled_runs`

```
params:
  stale_after_ms?  — ms since last heartbeat to consider stalled (default: 600000 = 10 min)

returns: StalledRun[]
  Same shape as ActiveRun, plus:
  { stale_for_ms: number }   — ms since last heartbeat (or since claimed_at if no heartbeat)
```

Implementation:
```js
const now = Date.now();
const threshold = args.stale_after_ms ?? 600_000;
claims
  .filter(c => ['claimed', 'in_progress'].includes(c.state))
  .filter(c => {
    const lastActivity = c.last_heartbeat_at ?? c.claimed_at;
    return (now - new Date(lastActivity).getTime()) > threshold;
  })
  .map(c => ({
    ...c,
    stale_for_ms: now - new Date(c.last_heartbeat_at ?? c.claimed_at).getTime(),
  }));
```

### 5. `get_task`

```
params:
  task_ref  — required, e.g. 'project/feat-login'

returns: Task | { error: 'not_found' }
```

Implementation: `readJson(stateDir, 'backlog.json')` → `findTask(backlog, task_ref)`.

### 6. `get_recent_events`

```
params:
  limit?  — number of recent events to return (default: 50, max: 200)

returns: Event[]
  Each event as parsed from events.jsonl, most-recent last.
```

Implementation: read `events.jsonl` with `readFileSync`, split on `\n`, filter empty/invalid,
parse JSON, take last `limit` entries. Malformed lines are silently skipped.

**Guard for missing file:** `events.jsonl` may not exist on a fresh state dir. Wrap in try/catch:
```js
export function handleGetRecentEvents(stateDir, { limit = 50 } = {}) {
  const cap = Math.min(limit, 200);
  let raw;
  try {
    raw = readFileSync(join(stateDir, 'events.jsonl'), 'utf8');
  } catch {
    return []; // file doesn't exist yet — normal on fresh state
  }
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .slice(-cap);
}
```

---

## Resources to Implement

### `orchestrator://state/backlog`

```
name: 'Backlog'
description: 'Full backlog.json — all epics and tasks with current status'
mimeType: 'application/json'
```

Returns full `backlog.json` content as JSON string.

### `orchestrator://state/agents`

```
name: 'Agents'
description: 'All registered agents with current status and session handles'
mimeType: 'application/json'
```

Returns full `agents.json` content as JSON string.

---

## Implementation

### Step 1 — Create `mcp/handlers.mjs`

```js
/**
 * mcp/handlers.mjs
 *
 * Pure handler functions for MCP read tools.
 * Each function takes (stateDir, args) and returns a plain object.
 * Throws on validation errors; server.mjs wraps in isError responses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, findTask, readClaims } from '../lib/stateReader.mjs';
import { listAgents } from '../lib/agentRegistry.mjs';

export function handleListTasks(stateDir, { status, epic } = {}) {
  const backlog = readJson(stateDir, 'backlog.json');
  let tasks = (backlog.epics ?? []).flatMap((e) =>
    (e.tasks ?? []).map((t) => ({ ...t, epic_ref: e.ref }))
  );
  if (status)  tasks = tasks.filter((t) => t.status === status);
  if (epic)    tasks = tasks.filter((t) => t.epic_ref === epic);
  return tasks;
}

export function handleListAgents(stateDir, { role } = {}) {
  let agents = listAgents(stateDir);
  if (role) agents = agents.filter((a) => a.role === role);
  return agents;
}

export function handleListActiveRuns(stateDir) {
  return (readClaims(stateDir).claims ?? [])
    .filter((c) => ['claimed', 'in_progress'].includes(c.state));
}

export function handleListStalledRuns(stateDir, { stale_after_ms = 600_000 } = {}) {
  const now = Date.now();
  return (readClaims(stateDir).claims ?? [])
    .filter((c) => ['claimed', 'in_progress'].includes(c.state))
    .filter((c) => {
      const ref = c.last_heartbeat_at ?? c.claimed_at;
      return (now - new Date(ref).getTime()) > stale_after_ms;
    })
    .map((c) => ({
      ...c,
      stale_for_ms: now - new Date(c.last_heartbeat_at ?? c.claimed_at).getTime(),
    }));
}

export function handleGetTask(stateDir, { task_ref } = {}) {
  if (!task_ref) throw new Error('task_ref is required');
  const backlog = readJson(stateDir, 'backlog.json');
  const task = findTask(backlog, task_ref);
  if (!task) return { error: 'not_found', task_ref };
  return task;
}

export function handleGetRecentEvents(stateDir, { limit = 50 } = {}) {
  const cap = Math.min(limit, 200);
  const raw = readFileSync(join(stateDir, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .slice(-cap);
}

export function handleReadBacklog(stateDir) {
  return readFileSync(join(stateDir, 'backlog.json'), 'utf8');
}

export function handleReadAgents(stateDir) {
  return readFileSync(join(stateDir, 'agents.json'), 'utf8');
}
```

### Step 2 — Register tools in `server.mjs`

**File:** `mcp/server.mjs`

Replace the `ping`-only TOOLS array with the full read tool list. Import handlers:
```js
import * as handlers from './handlers.mjs';
```

Full TOOLS array (copy this exactly — inputSchema is used by claude for type-checking):
```js
export const TOOLS = [
  {
    name: 'list_tasks',
    description: 'List backlog tasks. Optionally filter by status or epic.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['todo','claimed','in_progress','done','blocked'],
                  description: 'Filter by task status' },
        epic:   { type: 'string', description: 'Filter by epic ref (e.g. "project")' },
      },
    },
  },
  {
    name: 'list_agents',
    description: 'List registered agents. Optionally filter by role.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['worker','reviewer','master'],
                description: 'Filter by agent role' },
      },
    },
  },
  {
    name: 'list_active_runs',
    description: 'List currently active task claims (claimed and in_progress).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_stalled_runs',
    description: 'List active claims with no recent heartbeat.',
    inputSchema: {
      type: 'object',
      properties: {
        stale_after_ms: { type: 'number',
                          description: 'Inactivity threshold in ms. Default: 600000 (10 min)' },
      },
    },
  },
  {
    name: 'get_task',
    description: 'Get a single task by ref. Returns { error: "not_found" } if absent.',
    inputSchema: {
      type: 'object',
      required: ['task_ref'],
      properties: {
        task_ref: { type: 'string', description: 'Full task ref, e.g. "project/feat-login"' },
      },
    },
  },
  {
    name: 'get_recent_events',
    description: 'Return the most recent events from events.jsonl.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max events to return (default: 50, max: 200)' },
      },
    },
  },
];
```

Wire each tool in the `CallToolRequestSchema` switch:
```js
case 'list_tasks':          return ok(handlers.handleListTasks(STATE_DIR, args));
case 'list_agents':         return ok(handlers.handleListAgents(STATE_DIR, args));
case 'list_active_runs':    return ok(handlers.handleListActiveRuns(STATE_DIR));
case 'list_stalled_runs':   return ok(handlers.handleListStalledRuns(STATE_DIR, args));
case 'get_task':            return ok(handlers.handleGetTask(STATE_DIR, args));
case 'get_recent_events':   return ok(handlers.handleGetRecentEvents(STATE_DIR, args));
```

Where `ok` is a helper:
```js
function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
```

Update `ListResourcesRequestSchema` to return the two resources.
Wire `ReadResourceRequestSchema`:
```js
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === 'orchestrator://state/backlog') {
    return { contents: [{ uri, mimeType: 'application/json', text: handlers.handleReadBacklog(STATE_DIR) }] };
  }
  if (uri === 'orchestrator://state/agents') {
    return { contents: [{ uri, mimeType: 'application/json', text: handlers.handleReadAgents(STATE_DIR) }] };
  }
  throw new Error(`Unknown resource: ${uri}`);
});
```

Also add `epic_ref` to the `list_tasks` return type documentation — the handler adds it:
```
Each task object includes all backlog fields plus:
  epic_ref  — string, the parent epic's ref
```

---

## Acceptance criteria

- [ ] `list_tasks` returns all tasks when no filters applied.
- [ ] `list_tasks` with `status='todo'` returns only todo tasks.
- [ ] `list_tasks` with `epic='project'` returns only tasks in that epic.
- [ ] `list_agents` returns all agents; role filter works.
- [ ] `list_active_runs` returns only claimed/in_progress claims.
- [ ] `list_stalled_runs` returns claims with no recent heartbeat; includes `stale_for_ms`.
- [ ] `get_task` returns task object for valid ref; returns `{ error: 'not_found' }` for missing.
- [ ] `get_recent_events` returns last N events (most-recent last); malformed lines skipped.
- [ ] `orchestrator://state/backlog` resource returns valid JSON string.
- [ ] `orchestrator://state/agents` resource returns valid JSON string.
- [ ] All handlers are importable and callable independently of MCP SDK.

---

## Tests

**File:** `mcp/handlers.test.mjs`

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleListTasks, handleListAgents, handleListActiveRuns,
  handleListStalledRuns, handleGetTask, handleGetRecentEvents,
} from './handlers.mjs';

// Seed helpers:
function seedBacklog(dir, epics) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', epics }));
}
function seedAgents(dir, agents) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
}
function seedClaims(dir, claims) {
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
}
function seedEvents(dir, events) {
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
}
```

Test cases (one per handler):
- `handleListTasks`: all tasks, filtered by status, filtered by epic
- `handleListAgents`: all agents, filtered by role
- `handleListActiveRuns`: returns only claimed/in_progress
- `handleListStalledRuns`: stale threshold math; fresh heartbeat not included
- `handleGetTask`: found, not found
- `handleGetRecentEvents`: returns last N; skips malformed lines

---

## Verification

```bash
cd orchestrator && npm test -- mcp/handlers
npm test
```
