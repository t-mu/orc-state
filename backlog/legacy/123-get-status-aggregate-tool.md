---
ref: orch/task-123-get-status-aggregate-tool
epic: orch
status: done
---

# Task 123 — Add get_status Aggregate MCP Tool

Independent. Best implemented after Task 117 (agent TTL) and Task 121 (active_task_ref on agents) so the status response is maximally useful, but can be done in any order.

## Scope

**In scope:**
- `mcp/handlers.mjs` — new `handleGetStatus` export
- `mcp/tools-list.mjs` — new `get_status` tool schema
- `mcp/server.mjs` — wire `get_status` tool to handler
- `mcp/handlers.test.mjs` — unit tests
- All three master bootstrap templates — add `get_status` to READ STATE section; update "show me status" flow to use it first

**Out of scope:**
- Replacing `list_tasks`, `list_agents`, or `list_active_runs` (they remain available for detail queries)
- Historical task counts (e.g. how many done tasks this week)
- Changing the notify-queue or claim structure

---

## Context

A typical "show me status" workflow currently requires three sequential MCP tool calls: `list_agents`, `list_tasks`, and `list_active_runs`. Each call is a separate round-trip with its own token overhead. For an interactive session this is slow and wasteful — the operator wants a single snapshot.

`get_status` is a read-only aggregation of existing state. It reads `agents.json`, `backlog.json`, `claims.json`, and `master-notify-queue.jsonl` in one handler and returns a compact summary JSON guaranteed to be under 2 KB for typical deployments.

**Affected files:**
- `mcp/handlers.mjs` — new handler
- `mcp/tools-list.mjs` — new tool
- `mcp/server.mjs` — dispatch wiring
- `mcp/handlers.test.mjs` — tests
- All three `templates/master-bootstrap-*-v1.txt`

---

## Goals

1. Must return agents summary, task counts by status, active task list, pending notification count, and stalled run count in a single call.
2. Must always return a response under 2 KB for deployments with ≤ 5 workers and ≤ 20 active tasks.
3. Must count pending (unconsumed) master-notify-queue entries without reading full entries.
4. Must count stalled runs (no heartbeat in last 10 minutes) using the same logic as `list_stalled_runs`.
5. Must not return `done` or `released` task details (counts only, and only if `include_done_count: true`).

---

## Implementation

### Step 1 — Add handleGetStatus handler

**File:** `mcp/handlers.mjs`

```js
export function handleGetStatus(stateDir, { include_done_count = false } = {}) {
  const agents = listAgents(stateDir).filter((a) => a.status !== 'dead');
  const claims = readClaims(stateDir).claims ?? [];
  const backlog = readJson(stateDir, 'backlog.json');
  const now = Date.now();

  // Active claim lookup for agent join
  const claimByAgent = Object.fromEntries(
    claims
      .filter((c) => ['claimed', 'in_progress'].includes(c.state))
      .map((c) => [c.agent_id, c.task_ref])
  );

  // Stalled: active claims with no heartbeat in last 10 minutes
  const STALE_MS = 10 * 60 * 1000;
  const stalledRuns = claims.filter((c) => {
    if (!['claimed', 'in_progress'].includes(c.state)) return false;
    const ts = c.last_heartbeat_at ?? c.claimed_at;
    return (now - new Date(ts).getTime()) > STALE_MS;
  }).length;

  // Task counts and active task list
  const ACTIVE_STATUSES = new Set(['todo', 'claimed', 'in_progress', 'blocked']);
  const counts = { todo: 0, claimed: 0, in_progress: 0, blocked: 0 };
  if (include_done_count) { counts.done = 0; counts.released = 0; }
  const activeTasks = [];

  for (const epic of backlog.epics ?? []) {
    for (const task of epic.tasks ?? []) {
      if (counts[task.status] !== undefined) counts[task.status]++;
      if (ACTIVE_STATUSES.has(task.status)) {
        activeTasks.push({
          ref: task.ref,
          title: task.title,
          status: task.status,
          epic_ref: epic.ref,
          owner: task.owner ?? null,
        });
      }
    }
  }

  // Pending notifications count
  let pendingNotifications = 0;
  try {
    const queueLines = readFileSync(join(stateDir, 'master-notify-queue.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    pendingNotifications = queueLines.filter((line) => {
      try { return !JSON.parse(line).consumed; } catch { return false; }
    }).length;
  } catch { /* file absent */ }

  return {
    agents: agents.map((a) => ({
      agent_id: a.agent_id,
      role: a.role,
      status: a.status,
      provider: a.provider,
      active_task_ref: claimByAgent[a.agent_id] ?? null,
    })),
    task_counts: counts,
    active_tasks: activeTasks,
    pending_notifications: pendingNotifications,
    stalled_runs: stalledRuns,
  };
}
```

### Step 2 — Register in tools-list.mjs

**File:** `mcp/tools-list.mjs`

```js
{
  name: 'get_status',
  description: 'Single-call status snapshot: agents, task counts by status, active tasks, pending notifications, stalled runs. Prefer this over separate list_agents/list_tasks/list_active_runs calls for status overviews.',
  inputSchema: {
    type: 'object',
    properties: {
      include_done_count: {
        type: 'boolean',
        description: 'Include done/released counts in task_counts (default: false)',
      },
    },
    additionalProperties: false,
  },
}
```

### Step 3 — Wire in server.mjs

**File:** `mcp/server.mjs` — import `handleGetStatus` and add dispatch case for `'get_status'`.

### Step 4 — Update master bootstrap templates

**Files:** all three `master-bootstrap-*-v1.txt`

Add to READ STATE section (before `list_tasks`):

```
get_status(include_done_count?)
  Single-call snapshot: agents, task_counts, active_tasks, pending_notifications,
  stalled_runs. Use this for status overviews instead of separate list_* calls.
  include_done_count: include done/released in task_counts (default false).
```

Update STATUS DISPLAY FORMAT section to note: call `get_status()` first; use `list_tasks`, `list_agents`, `get_task` only for detail queries.

---

## Acceptance criteria

- [ ] `get_status()` returns an object with keys: `agents`, `task_counts`, `active_tasks`, `pending_notifications`, `stalled_runs`.
- [ ] `agents` array contains `{ agent_id, role, status, provider, active_task_ref }` for all non-dead agents.
- [ ] `task_counts` contains counts for `todo`, `claimed`, `in_progress`, `blocked` at minimum.
- [ ] `active_tasks` contains only non-terminal tasks with `{ ref, title, status, epic_ref, owner }`.
- [ ] `pending_notifications` is the count of unconsumed entries in `master-notify-queue.jsonl` (0 when file absent).
- [ ] `stalled_runs` counts active claims with no heartbeat for >10 minutes.
- [ ] `include_done_count: true` adds `done` and `released` keys to `task_counts`.
- [ ] Response JSON is ≤ 2 KB for a deployment with 3 workers and 10 active tasks.
- [ ] `nvm use 24 && npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

**File:** `mcp/handlers.test.mjs`:

```js
it('handleGetStatus returns correct agent summary with active_task_ref');
it('handleGetStatus counts tasks by status correctly');
it('handleGetStatus counts pending notifications from queue file');
it('handleGetStatus counts stalled runs');
it('handleGetStatus include_done_count adds done/released keys');
it('handleGetStatus returns empty active_tasks when all tasks are done');
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
