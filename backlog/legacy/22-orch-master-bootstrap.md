# Task 22 — Orchestrator: Master Agent Bootstrap Prompt

> **Part D — Master Agent, Step 4 of 4.** Requires Task 21 to be complete first.

## Context

When an agent session starts, `cli/start-worker-session.mjs` sends a bootstrap prompt that
orients the agent and tells it how to behave. Workers receive `worker-bootstrap-v2.txt`.
The master agent needs a different prompt: it must not behave like a task executor. It is a
planner — it waits for user direction (Phase 1) and creates/delegates work via CLI commands.

This task creates the master bootstrap template and makes `start-worker-session.mjs` select
the right template based on agent role.

---

## Goals

1. Create `templates/master-bootstrap-v1.txt`.
2. Update `cli/start-worker-session.mjs` to send the master bootstrap to `role: 'master'` agents.

---

## Step-by-Step Instructions

### Step 1 — Create `templates/master-bootstrap-v1.txt`

Create the file with the following content. The `{{agent_id}}` and `{{provider}}` placeholders
are substituted by `renderTemplate()` at send time, using the same mechanism as the worker
bootstrap.

```
MASTER_BOOTSTRAP v1
agent_id: {{agent_id}}
provider: {{provider}}

You are the orchestration master agent. Your role is to translate user intent
into concrete tasks and assign them to worker agents. You do not execute tasks
yourself.

RESPONSIBILITIES
  - Listen for user direction (prompts you receive in this session).
  - Create tasks in the backlog using orc:task:create.
  - Assign tasks to workers using orc:delegate.
  - Monitor the system state and report back to the user.
  - Do not emit run lifecycle events (run_started, run_finished, etc.).
    Those are for worker agents only.

READ STATE
  npm run orc:status              — agent/task/claim summary table
  npm run orc:runs:active         — active runs with last activity
  npm run orc:events:tail         — recent events log

CREATE A TASK
  npm run orc:task:create -- \
    --epic=<epic-ref> \
    --title="<title>" \
    --task-type=<implementation|refactor> \
    --description="<description>" \
    --ac="<criterion 1>" \
    --ac="<criterion 2>" \
    --actor-id={{agent_id}}

DELEGATE A TASK
  npm run orc:delegate -- \
    --task-ref=<epic/task> \
    --task-type=<implementation|refactor> \
    --actor-id={{agent_id}} \
    [--target-agent-id=<agent_id>]

  Omit --target-agent-id to let the system auto-assign to the first eligible worker.

CREATE AND IMMEDIATELY DELEGATE (typical flow)
  Run orc:task:create first, then orc:delegate with the same task-ref.

TASK LIFECYCLE
  todo → claimed (coordinator assigns) → in_progress (worker acknowledges)
       → done (worker finishes) / blocked / failed (requeued automatically)

EPICS
  Check current epics in orchestrator/state/backlog.json before creating tasks.
  Tasks must belong to an existing epic. Valid epic refs are the top-level
  "ref" values in the epics array.

WAIT FOR USER PROMPTS
  Do not create tasks speculatively. Wait for the user to tell you what to build.
  When the user gives direction, translate it into one or more tasks, create them,
  delegate them, then report back: task refs created, assigned workers, next step.

MASTER_BOOTSTRAP_END
```

### Step 2 — Update `cli/start-worker-session.mjs`

The file currently calls `buildSessionBootstrap(worker.agent_id, worker.provider)` which always
renders `worker-bootstrap-v2.txt`. Add role detection so master agents get the master template.

Find `buildSessionBootstrap`:

```js
function buildSessionBootstrap(agentId, workerProvider) {
  return renderTemplate('worker-bootstrap-v2.txt', {
    agent_id: agentId,
    provider: workerProvider,
  });
}
```

Replace with:

```js
function buildSessionBootstrap(agentId, workerProvider, role) {
  const template = role === 'master' ? 'master-bootstrap-v1.txt' : 'worker-bootstrap-v2.txt';
  return renderTemplate(template, {
    agent_id: agentId,
    provider: workerProvider,
  });
}
```

Find the call site where `buildSessionBootstrap` is invoked and pass `worker.role`:

```js
// BEFORE:
await adapter.send(session_handle, buildSessionBootstrap(worker.agent_id, worker.provider));

// AFTER:
await adapter.send(session_handle, buildSessionBootstrap(worker.agent_id, worker.provider, worker.role));
```

There may be a second call site inside the same file (for the no-session-handle branch). Update
both occurrences.

### Step 3 — Verify with a dry run

Start the master session and confirm the bootstrap is sent:

```
npm run orc:worker:start-session -- master --no-attach
```

Check the tmux session for the `MASTER_BOOTSTRAP v1` header. The agent should be ready to
receive user prompts.

### Step 4 — Run tests

```
nvm use 22 && npm run test:orch
```

There are no automated tests for the template content itself, but the existing session tests
should still pass since only the master agent's branch changed.

---

## Acceptance Criteria

- [ ] `templates/master-bootstrap-v1.txt` exists with `MASTER_BOOTSTRAP v1` header
      and `MASTER_BOOTSTRAP_END` footer.
- [ ] `cli/start-worker-session.mjs` sends `master-bootstrap-v1.txt` to agents with `role: 'master'`.
- [ ] Workers (role `worker` or `reviewer`) still receive `worker-bootstrap-v2.txt`.
- [ ] `npm run orc:worker:start-session -- master --no-attach` starts without error.
- [ ] All orchestrator tests pass.

---

## Phase 2 Extension Note (not part of this task)

In Phase 2, the master agent bootstrap will gain an additional section:

```
AUTONOMOUS SCANNING (Phase 2)
  Poll orc:status every N minutes. When todo_count < THRESHOLD, scan the repo
  and generate improvement tasks autonomously across: test coverage, tech debt,
  accessibility, UX consistency, performance, maintenance.
```

This is not implemented here. The template format (header / body / footer) deliberately
leaves room for it to be appended without structural changes.
