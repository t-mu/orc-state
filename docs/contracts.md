# Contracts & Invariants

Runtime contracts, state schemas, and lifecycle invariants for the orc-state
orchestration framework. This is a reference for people building on, extending,
or debugging the system.

---

## State Directory

All runtime state lives under `ORC_STATE_DIR` (default: `<repo-root>/.orc-state/`).
State files are never written directly by agents or external tools -- all mutations
go through `orc` CLI commands or MCP tool handlers, which hold appropriate locks.

| File | Format | Contents |
|------|--------|----------|
| `backlog.json` | JSON | Features and tasks (the full backlog) |
| `agents.json` | JSON | Registered agents and their session metadata |
| `claims.json` | JSON | Active and historical run claims |
| `events.db` | SQLite (WAL mode) | Append-only event log with FTS index |

Auxiliary runtime files (not orchestrator state):

| Path | Purpose |
|------|---------|
| `pty-pids/<agent_id>.pid` | Cross-process heartbeat probing for PTY sessions |
| `pty-logs/<agent_id>.log` | PTY output capture for `orc attach` |

### Concurrency model

JSON state files use filesystem advisory locking (`withLock`) to serialize
writes. The SQLite event store uses WAL mode, which allows concurrent readers
with a single writer. Agents must never call locking primitives directly --
the CLI and MCP handlers manage this.

---

## Backlog State (`backlog.json`)

```
{
  version: "1",
  next_task_seq?: number,
  features: Feature[]
}
```

### Feature

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ref` | string | yes | Unique feature identifier |
| `title` | string | yes | Human-readable name |
| `description` | string | no | Longer description |
| `tasks` | Task[] | yes | Ordered list of tasks within this feature |
| `created_at` | ISO 8601 | no | Creation timestamp |

### Task

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ref` | string | yes | Unique task identifier (`<feature>/<slug>`) |
| `title` | string | yes | Human-readable name |
| `status` | TaskStatus | yes | Current lifecycle state |
| `description` | string | no | Detailed description |
| `task_type` | `"implementation"` \| `"refactor"` | no | Classification |
| `priority` | `"low"` \| `"normal"` \| `"high"` \| `"critical"` | no | Scheduling priority |
| `planning_state` | `"ready_for_dispatch"` \| `"archived"` | no | Planning metadata |
| `depends_on` | TaskRef[] | no | Refs that must be `done` or `released` before dispatch |
| `acceptance_criteria` | string[] | no | Criteria for review |
| `attempt_count` | number | no | How many times this task has been attempted |
| `requeue_eligible_after` | ISO 8601 | no | Earliest time a requeued task can be re-claimed |
| `blocked_reason` | string | no | Why the task is blocked |
| `required_capabilities` | string[] | no | Capabilities the assigned agent must have |
| `required_provider` | ProviderName | no | Force dispatch to a specific provider |
| `parent_task_ref` | TaskRef | no | Parent task for subtask relationships |
| `delegated_by` | string | no | Who delegated this task |
| `owner` | string | no | Current owner agent |
| `created_at` | ISO 8601 | no | Creation timestamp |
| `updated_at` | ISO 8601 | no | Last modification timestamp |

### TaskStatus values

```
"todo" | "claimed" | "in_progress" | "blocked" | "done" | "released" | "cancelled"
```

---

## Task Lifecycle

```
                        +------------------+
                        |                  |
                        v                  |
  +------+  delegate  +---------+  run-start  +-------------+
  | todo | ---------> | claimed | ----------> | in_progress |
  +------+            +---------+             +-------------+
     ^                                          |         |
     |          task-reset                      |         |
     +------------------------------------------+         |
     |          (from claimed/in_progress/blocked)        |
     |                                                    |
     |                                          +---------+--------+
     |                                          |                  |
     |                            task-mark-done|  run-fail        |
     |                                          |  --policy=block  |
     |                                          v                  v
     |                                       +------+        +---------+
     |                                       | done |        | blocked |
     |                                       +------+        +---------+
     |                                          |
     |                            coordinator   |
     |                            merge         |
     |                                          v
     |                                      +----------+
     |                                      | released |
     |                                      +----------+
```

### Transition table

| Transition | Trigger | Who |
|------------|---------|-----|
| `todo` -> `claimed` | `orc delegate` | Coordinator |
| `claimed` -> `in_progress` | `orc run-start` | Worker |
| `in_progress` -> `done` | Post-merge runtime completion (`orc task-mark-done <ref>`) | Coordinator |
| `done` -> `released` | Post-merge release | Coordinator |
| `any` -> `blocked` | `orc run-fail --policy=block` | Worker |
| `blocked/claimed/in_progress` -> `todo` | `orc task-reset <ref>` | Operator |
| `any` -> `cancelled` | MCP `cancel_task` | Coordinator |

### Dispatch eligibility

A task is eligible for dispatch when all of:
- `status == "todo"`
- Every ref in `depends_on` has status `done` or `released`
- `requeue_eligible_after` is null or in the past

---

## Agent State (`agents.json`)

```
{
  version: "1",
  agents: Agent[]
}
```

### Agent

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent_id` | string | yes | Unique identifier (e.g. `orc-1`, `master`) |
| `provider` | `"claude"` \| `"codex"` \| `"gemini"` \| `"human"` | yes | Provider backend |
| `model` | string | no | Specific model variant |
| `status` | AgentStatus | yes | Current agent state |
| `role` | `"worker"` \| `"reviewer"` \| `"master"` \| `"scout"` | no | Agent role |
| `dispatch_mode` | `"autonomous"` \| `"supervised"` \| `"human-commanded"` | no | How tasks are dispatched |
| `capabilities` | string[] | no | Declared capabilities for capability-based routing |
| `session_handle` | string | no | PTY session handle (`pty:<agent_id>`) |
| `session_token` | string | no | Provider session token |
| `session_started_at` | ISO 8601 | no | When the PTY session was created |
| `session_ready_at` | ISO 8601 | no | When the session became ready for commands |
| `provider_ref` | object | no | Provider-specific metadata |
| `registered_at` | ISO 8601 | yes | Registration timestamp |
| `last_heartbeat_at` | ISO 8601 | no | Last successful heartbeat probe |
| `last_status_change_at` | ISO 8601 | no | Last status transition |

### AgentStatus values

```
"idle" | "running" | "offline" | "dead"
```

- **idle** -- registered and session alive, no active run
- **running** -- actively executing a claimed task
- **offline** -- session unreachable or shut down gracefully
- **dead** -- marked dead by `worker-gc` after sustained unreachability

---

## Claims State (`claims.json`)

```
{
  version: "1",
  claims: Claim[]
}
```

A claim binds a task to an agent for the duration of a run. Claims are never
deleted -- completed and failed claims remain in the array as historical records.

### Claim

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `run_id` | string | yes | Unique run identifier (`run-<timestamp>-<hex>`) |
| `task_ref` | string | yes | The claimed task |
| `agent_id` | string | yes | The agent executing this run |
| `state` | ClaimState | yes | Current claim state |
| `claimed_at` | ISO 8601 | yes | When the claim was created |
| `lease_expires_at` | ISO 8601 | yes | When the lease expires without activity |
| `task_envelope_sent_at` | ISO 8601 | no | When the TASK_START envelope was sent |
| `last_heartbeat_at` | ISO 8601 | no | Last activity timestamp from worker |
| `started_at` | ISO 8601 | no | When `run-start` was called |
| `finished_at` | ISO 8601 | no | When the run reached a terminal state |
| `failure_reason` | string | no | Reason for failure (on `run-fail`) |
| `finalization_state` | FinalizationState | no | Post-work-complete finalization progress |
| `finalization_retry_count` | number | no | How many finalize rebases have been attempted |
| `finalization_blocked_reason` | string | no | Why finalization is blocked |
| `input_state` | InputState | no | Whether the worker is awaiting master input |
| `input_requested_at` | ISO 8601 | no | When input was requested |
| `session_start_retry_count` | number | no | Session start retry attempts |
| `session_start_retry_next_at` | ISO 8601 | no | Next session start retry time |
| `session_start_last_error` | string | no | Last session start error |
| `escalation_notified_at` | ISO 8601 | no | When an escalation notification was sent |

### ClaimState values

```
"claimed" | "in_progress" | "done" | "failed"
```

### FinalizationState values

```
"awaiting_finalize"              -- work-complete received, waiting for coordinator
"finalize_rebase_requested"      -- coordinator asked worker to rebase
"finalize_rebase_in_progress"    -- worker is rebasing
"ready_to_merge"                 -- rebase complete, coordinator can merge
"blocked_finalize"               -- finalization hit an unrecoverable problem
null                             -- not in finalization (pre-work-complete or terminal)
```

### InputState values

```
"awaiting_input"    -- worker blocked on master input
null                -- not waiting for input
```

---

## Claim Lifecycle and Lease Management

```
  delegate           run-start         work-complete       run-finish
  +--------+  ack   +-----------+  wc  +-----------+  fin +---------+
  | claimed | ----> | in_progress| --> | in_progress| --> |  done   |
  +--------+       +-----------+      | (finalize) |     +---------+
                                       +-----------+
                          |
                     run-fail
                          |
                          v
                      +--------+
                      | failed |
                      +--------+
```

### Lease mechanism

Every claim has a `lease_expires_at` timestamp. The lease duration is **30 minutes** by default.

- **Creation**: `lease_expires_at` is set to `now + 30m` when the claim is created.
- **Renewal**: The coordinator automatically extends the lease whenever phase events
  (`phase_started`, `phase_finished`, `review_submitted`, etc.) are processed.
- **Expiry**: The coordinator periodically checks for claims where
  `lease_expires_at < now`. Expired claims are released, and the task is
  requeued (`status` -> `todo`) or blocked depending on policy.

### Worker liveness

Liveness is determined by the coordinator: on each tick it probes the worker's
PTY PID via `process.kill(pid, 0)`. If the PID is dead, the coordinator clears
the agent session, expires the claim, and requeues the task.

Lease renewal is automatic — the coordinator extends the lease whenever phase events
are processed. Workers do not need to emit periodic heartbeats.

### Invariants

- **Single active claim per task**: At most one claim with state `claimed` or
  `in_progress` may exist for a given `task_ref` at any time.
- **Agent existence**: `claim.agent_id` must reference an agent in `agents.json`.
- **Task existence**: `claim.task_ref` must reference a task in `backlog.json`.
- **Monotonic finalization**: Finalization state transitions only move forward
  (e.g., `awaiting_finalize` -> `ready_to_merge`, never backwards).

---

## Worker Lifecycle

The worker lifecycle is the sequence of `orc run-*` commands a worker emits
during task execution. These commands mutate claim state and emit events.

```
  TASK_START envelope received
         |
         v
  orc run-start                  claimed -> in_progress
         |
         v
  [implement + test + review]
         |
         v
  worker updates task markdown in worktree to status: done
         |
         v
  orc run-work-complete          finalization_state -> awaiting_finalize
         |
         v
  [coordinator merge + optional finalize rebase]
         |
         v
  orc task-mark-done <ref>       runtime task status -> done
         |
         v
  orc run-finish                 claim state -> done (terminal)


  At any point:
  orc run-fail                   claim state -> failed (terminal)
                                 task -> requeued (default) or blocked
```

### Command preconditions

| Command | Precondition |
|---------|-------------|
| `run-start` | Claim exists with `state == "claimed"`, agent matches |
| `run-work-complete` | Claim `state == "in_progress"`, task status is `done` |
| `run-finish` | Claim `state == "in_progress"` or `"done"`, work-complete was called |
| `run-fail` | Claim `state == "claimed"` or `"in_progress"` |
| `run-input-request` | Claim `state == "in_progress"` |

### Failure policies

`orc run-fail` accepts `--policy=<requeue|block>` (default: `requeue`):

- **requeue**: Task status reverts to `todo`. `attempt_count` is incremented.
  The task becomes eligible for re-dispatch after any `requeue_eligible_after` delay.
- **block**: Task status becomes `blocked` with the provided `--reason`.
  Requires manual `orc task-unblock` or `orc task-reset` to re-enter the queue.

### Input request flow

When a worker is blocked on ambiguous requirements or external dependencies:

```
  Worker                              Master
    |                                   |
    |-- run-input-request ----------->  |
    |   (claim.input_state =            |
    |    "awaiting_input")              |
    |                                   |
    |   (blocks, waiting)               |
    |                                   |
    |  <--------- run-input-respond ----|
    |   (claim.input_state = null)      |
    |                                   |
    |-- resumes work --------->         |
```

The `run-input-request` command blocks until a matching `run-input-respond`
is received. The claim lease remains active while the worker process is alive.

---

## Event Log (`events.db`)

All state transitions and lifecycle events are recorded in an append-only
SQLite database. Events are the audit trail -- they are never modified or
deleted during normal operation.

### Storage schema

```sql
CREATE TABLE events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id  TEXT    NOT NULL UNIQUE,
  ts        TEXT    NOT NULL,           -- ISO 8601 UTC
  event     TEXT    NOT NULL,           -- event type discriminator
  agent_id  TEXT,                       -- agent-scoped events
  run_id    TEXT,                       -- run-scoped events
  task_ref  TEXT,                       -- task-scoped events
  payload   TEXT    NOT NULL            -- full JSON event object
);
```

A full-text search index (`events_fts`) is maintained via trigger for
free-text queries across event, agent_id, run_id, task_ref, and payload.

### Event fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `seq` | integer | yes | Monotonically increasing sequence number |
| `event_id` | string (UUID) | yes | Durable identity for replay-safe deduplication |
| `ts` | ISO 8601 | yes | Wall-clock UTC timestamp |
| `event` | string (enum) | yes | Event type discriminator |
| `actor_type` | `"agent"` \| `"coordinator"` \| `"human"` | yes | Who emitted the event |
| `actor_id` | string | yes | agent_id, `"coordinator"`, or human handle |
| `run_id` | string | no | Present on run/claim/phase events |
| `task_ref` | string | no | Present on task and run events |
| `agent_id` | string | no | Present on agent-scoped events |
| `phase` | string | no | Phase name for phase_started/phase_finished |
| `payload` | object | no | Event-specific data (schema varies by type) |

### Event types

#### Run lifecycle events

| Event | Emitted by | When |
|-------|-----------|------|
| `run_started` | Worker | `orc run-start` acknowledged |
| `heartbeat` | Worker/Coordinator | Phase event processed (lease renewal) |
| `work_complete` | Worker | `orc run-work-complete` |
| `run_finished` | Worker | `orc run-finish` (terminal success) |
| `run_failed` | Worker | `orc run-fail` (terminal failure) |
| `run_cancelled` | Coordinator | Run forcibly cancelled |

#### Claim events

| Event | Emitted by | When |
|-------|-----------|------|
| `claim_created` | Coordinator | Task claimed for a worker |
| `claim_renewed` | Coordinator | Phase event extended the lease |
| `claim_expired` | Coordinator | Lease expired (no recent activity) |
| `claim_released` | Coordinator | Claim released after completion |

#### Task events

| Event | Emitted by | When |
|-------|-----------|------|
| `task_added` | Operator/Coordinator | New task registered |
| `task_updated` | Various | Task metadata changed |
| `task_cancelled` | Operator | Task cancelled |
| `task_released` | Coordinator | Task released after merge |
| `task_delegated` | Coordinator | Task assigned to a worker |
| `task_dispatch_blocked` | Coordinator | Dispatch failed (deps unmet, no agent) |
| `task_envelope_sent` | Coordinator | TASK_START envelope delivered |

#### Phase tracking events

| Event | Emitted by | When |
|-------|-----------|------|
| `phase_started` | Worker | Entering a new phase (explore, implement, review, complete, finalize) |
| `phase_finished` | Worker | Phase completed |
| `finalize_rebase_started` | Worker | Finalize rebase underway |
| `ready_to_merge` | Worker/Coordinator | Rebase done, ready for merge |

#### Agent events

| Event | Emitted by | When |
|-------|-----------|------|
| `agent_registered` | Coordinator | New agent registered |
| `agent_online` | Coordinator | Agent session confirmed alive |
| `reported_for_duty` | Worker | Worker reports ready |
| `agent_offline` | Coordinator | Agent session lost |
| `agent_marked_dead` | Coordinator | Agent marked dead by GC |
| `session_start_failed` | Coordinator | PTY session failed to start |
| `session_started` | Coordinator | PTY session launched successfully |

#### Blocking and input events

| Event | Emitted by | When |
|-------|-----------|------|
| `blocked` | Worker | Task blocked (`run-fail --policy=block`) |
| `unblocked` | Operator | Task unblocked (`task-unblock`) |
| `need_input` | Worker | Legacy input-needed signal |
| `input_provided` | Master | Legacy input-provided signal |
| `input_requested` | Worker | `run-input-request` (current) |
| `input_response` | Master | `run-input-respond` (current) |

#### Coordinator events

| Event | Emitted by | When |
|-------|-----------|------|
| `coordinator_started` | Coordinator | Coordinator process started |
| `coordinator_stopped` | Coordinator | Coordinator process stopped |
| `worker_needs_attention` | Coordinator | Escalation: worker stalled or errored |
| `remediation_applied` | Coordinator | Automatic remediation action taken |

### Notification events

A subset of events are classified as "notification events" for the master
agent's notification polling. These are:

- `run_finished`
- `run_failed`
- `run_cancelled`
- `worker_needs_attention`
- `input_requested`
- `input_response`

### Querying events

Events can be queried via `orc events-tail` (CLI) or `query_events` (MCP tool)
with filters on `run_id`, `agent_id`, `event_type`, `after_seq`, and free-text
search. Results are capped at 500 per query.

---

## Session Handles

Worker and master session handles use the format `pty:<agent_id>`.

Examples: `pty:master`, `pty:orc-1`, `pty:worker-01`

The handle identifies a local PTY process owned by the coordinator. Handles are
deterministic within the active PTY runtime. If a session is restarted, the
coordinator recreates the PTY and rewrites `session_handle` in `agents.json`.

---

## Cross-cutting Invariants

These invariants hold across all state files and must never be violated:

1. **Single active claim per task**: At most one claim with state `claimed` or
   `in_progress` exists per `task_ref`.

2. **Referential integrity**: Every `claim.agent_id` maps to an agent in
   `agents.json`. Every `claim.task_ref` maps to a task in `backlog.json`.

3. **Event schema compliance**: All events satisfy `schemas/event.schema.json`
   plus runtime validation in `lib/eventValidation.ts`.

4. **Monotonic event sequence**: `seq` values in `events.db` are strictly
   increasing (enforced by SQLite `AUTOINCREMENT`).

5. **Lease enforcement**: No claim with an expired lease should remain in
   `claimed` or `in_progress` state indefinitely. The coordinator sweeps
   for expired leases and transitions them.

6. **Task status consistency**: A task's `status` in `backlog.json` must agree
   with the state of its active claim in `claims.json`:
   - `claimed` task has exactly one `claimed` claim
   - `in_progress` task has exactly one `in_progress` claim
   - `done` task may have a `done` claim
   - `todo` task has no active (`claimed`/`in_progress`) claims

7. **Write exclusivity**: State files are modified only through `orc` CLI
   commands or MCP tool handlers. Direct file writes by agents are forbidden.

## See also

- [Getting started](./getting-started.md)
- [Architecture overview](./architecture.md)
- [Configuration](./configuration.md)
