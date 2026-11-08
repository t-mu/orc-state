# Contracts & Invariants

State files, task and run lifecycle, events, the local control API and the invariants that hold across them.

---

## State Files

Project state directory: `<data-home>/projects/<project_id>/` (sessions receive it as `ORC_STATE_DIR`). Agents never write it directly; every change goes through `orc` commands, MCP tools or the coordinator.

### Authoritative stores

| File | Format | Contents |
|------|--------|----------|
| `runtime.db` | SQLite | Project task store: `tasks`, `task_spec_revisions`, `task_dependencies`, `task_transitions`, `task_runs`, `task_imports`, `plan_documents` |
| `events.db` | SQLite (WAL), schema v8 | Append-only `events` (+ FTS index) and operational tables: `runs` (authoritative claims), `sessions`, `commands`, `messages`, `input_requests`, `offsets`, `control_leases`, `terminals` |
| `memory.db` | SQLite (FTS5) | Agent memory drawers; independent of the operational stores |
| `agents.json` | JSON | Agent registry; session fields are overlaid from `events.db` `sessions` |

### Projections (never read back as truth)

| File | Projection of |
|------|---------------|
| `backlog.json` | `runtime.db` tasks (features + tasks) |
| `claims.json` | `events.db` `runs` |

### Auxiliary files

| Path | Purpose |
|------|---------|
| `project.json` | Project descriptor (id, name, target root); lets a worker resolve its project without the registry |
| `coordinator.pid` | Coordinator pid lock (pid + process start) |
| `control.json` | Control API descriptor (protocol version, transport, socket path, daemon pid) |
| `control.token` | Control API bearer token, `0600`, rotated on each daemon start |
| `control.sock` | Control API Unix socket, `0600` (under the OS temp dir when the path is too long) |
| `operator.token` | Operator token, rewritten on every coordinator start |
| `run-worktrees.json` | Run → worktree/branch mapping |
| `worktrees/<run_id>/` | Run worktrees (git worktrees of the target repo; `ORC_WORKTREES_DIR` overrides) |
| `run-specs/<run_id>.md` | Pinned task revision body, read-only (`0444`), the worker's `task_spec_path` |
| `event-checkpoint.json` | Coordinator event-processing checkpoint (`last_processed_seq`, processed ids) |
| `run-activity.json` | Coordinator per-run activity: label, source, last tool, tool calls in flight, last turn end, `review_read_at` (`lib/runSignals.ts`) |
| `pty-hook-events/<agent_id>.ndjson` | Hook records (`permission`, `tool_start`, `tool`, `activity`, `turn_end`); drained only by the coordinator tick via `.processing` rename; name kept for compatibility; see [adapters.md](./adapters.md) |
| `pty-hook-events/<agent_id>.ndjson.tasks.json` | Claude hook sidecar: to-do labels by id + active id |
| `pty-logs/<agent_id>.log` | tmux output capture (output tails); `pty-` directory names are kept for compatibility |
| `pty-settings/<agent_id>.json` | Per-session provider settings (hooks, sandbox); name kept for compatibility |
| `mcp-config.json` | Master MCP config written by `orc start-session` (references `${ORC_MASTER_SECRET}`, never its value) |
| `.lock` | Advisory lock serializing JSON state writes |

### Schemas

| Schema | Enums |
|--------|-------|
| [backlog.schema.json](../schemas/backlog.schema.json) | `status`: `todo\|claimed\|in_progress\|blocked\|done\|released\|cancelled`; `task_type`: `implementation\|refactor`; `priority`: `low\|normal\|high\|critical`; `planning_state`: `ready_for_dispatch\|archived`; `review_level`: `none\|light\|full`; `merge_strategy`: `direct\|pr`; `required_provider`: `codex\|claude\|gemini` |
| [agents.schema.json](../schemas/agents.schema.json) | `status`: `idle\|running\|offline\|dead` (`dead` is never set; such records are removed); `role`: `worker\|reviewer\|master\|scout`; `provider`: `codex\|claude\|gemini\|human` |
| [claims.schema.json](../schemas/claims.schema.json) | `state`: `claimed\|in_progress\|done\|failed`; `finalization_state`: `awaiting_finalize\|finalize_rebase_requested\|finalize_rebase_in_progress\|ready_to_merge\|blocked_finalize\|pr_created\|pr_review_in_progress\|pr_merged\|pr_failed\|null`; `input_state`: `awaiting_input\|null` |
| [event.schema.json](../schemas/event.schema.json) | see **Events** |
| [run-worktrees.schema.json](../schemas/run-worktrees.schema.json), [event-checkpoint.schema.json](../schemas/event-checkpoint.schema.json), [snapshot.schema.json](../schemas/snapshot.schema.json) | — |

Task refs: `<feature>/<slug>`. Run ids: `run-<timestamp>-<hex>`. Worker agent ids: random orc-themed two-word names, unique among active workers.

---

## Task Lifecycle

```
todo → claimed → in_progress → done → released
          ↓           ↓
         todo (requeue) / blocked
todo/claimed/in_progress/blocked → cancelled
```

| Transition | Cause and owner |
|---|---|
| `todo → claimed` | Coordinator atomically verifies readiness and creates a run pinned to the latest revision |
| `claimed → in_progress` | Worker `orc run-start` |
| `in_progress → done` | Coordinator after a confirmed merge (`merge_succeeded`), once. `run-work-complete` changes only the run's finalization state. Recovery: `orc task-mark-done` |
| `done → released` | Coordinator post-merge release. Both satisfy dependencies |
| `claimed/in_progress → todo` | Failed run requeued (`run-fail` default policy, lease expiry, dead session not resumed); counts an attempt and sets `requeue_eligible_after` |
| `claimed/in_progress → blocked` | `run-fail --policy=block` (reason required), or 5 failed attempts |
| `blocked → todo` | Operator `orc task-unblock` / master `unblock_task` |
| `non-todo → todo` | Operator `orc task-reset` / master `reset_task`, including a done or cancelled task |
| `todo/claimed/in_progress/blocked → cancelled` | Master `cancel_task` / operator `orc task-cancel` |

- Every status change is a `task_transitions` row (cause, run, actor) written in the same transaction as the task and run binding; the `events.db` event follows, and startup reconciliation repairs a crash between them.
- Infrastructure failures (dispatch, session start, run-start timeout) do not count an attempt.
- A run that ends after its task was reset or cancelled leaves the task alone.
- Status is never edited through a spec or `update_task`; imports never apply status.
- A `todo` task with an unfinished dependency stays `todo`; `blocked` means an explicit decision or failure.

### Dispatch eligibility

Derived at claim time, never stored:

- `status == todo`, every `depends_on` ref `done`/`released` in the same project
- `requeue_eligible_after` null or past
- `planning_state` absent or `ready_for_dispatch`
- `owner` absent or the claiming agent
- agent can run the task (`required_provider`)
- capacity: `max_workers` − agents with an active claim > 0

---

## Run Lifecycle

| Command | Precondition | Effect |
|---------|--------------|--------|
| `orc run-start` | claim `claimed`, agent matches | claim + task → `in_progress` |
| `orc progress --event=<e>` | claim `in_progress` (`phase_*` need `--phase`; `blocked`/`need_input` need `--reason`) | event recorded |
| `orc run-work-complete` | claim `in_progress`, `finalization_state` null or `finalize_rebase_in_progress` | `work_complete` (→ `awaiting_finalize`) or `ready_to_merge` (after a finalize rebase) |
| `orc run-finish` | claim `in_progress`, task `done`/`released` (refused before the merge) | claim → `done` |
| `orc run-fail [--policy=requeue\|block]` | claim `claimed`/`in_progress` | claim → `failed`; task requeued or blocked |
| `orc run-input-request` | claim `in_progress` | `input_state → awaiting_input`; blocks until `run-input-respond` |

Direct mode: after work-complete the coordinator merges, or requests a finalize rebase (`finalize_rebase_requested` → worker `finalize_rebase_started` → rebase → `run-work-complete` again), then sends FINALIZE_SUCCESS; the worker calls `run-finish`. PR mode: the coordinator sends PR_REVIEW, the worker runs the PR loop and calls `run-work-complete`; the coordinator merges the PR. The worker workflow is in `templates/worker-bootstrap-v2.txt`.

### Lease and liveness

- Lease: `leases.default_ms` (30 min); `leases.finalize_ms` (60 min) once work is complete; `coordinator.pr_finalize_lease_ms` (24 h) for PR finalization.
- Renewal: the coordinator extends the lease when it processes the run's lifecycle/phase events. Claude hook activity renews only when newer than `last_heartbeat_at` and the lease is half used or the heartbeat half a lease old (`shouldRenewFromHookActivity`, `lib/runActivity.ts`); otherwise it only updates `run-activity.json`. Workers send no periodic heartbeat.
- Expiry: claim → `failed` (`ERR_LEASE_EXPIRED`), task requeued with backoff, blocked after 5 attempts; `claim_expired` emitted. A run whose task is already `done` (finalize window) is skipped. An input wait over 1 h expires with `ERR_INPUT_TIMEOUT`.
- Liveness: each tick probes the session — `tmux:` asks the private tmux server for the pane process; a legacy `pty:` handle from an older orc always probes dead. A dead process goes through one resume-or-requeue decision (`resumeOrRequeue` in `coordinator.ts`, rules in `lib/sessionResume.ts`):
  - Resumed in place when all hold: `sessions.resume` is `auto`; the provider supports resume (Claude CLI, Codex `app:`); a provider conversation id was recorded; the exit was a crash (a signal or a non-zero exit code); the run worktree exists; the run has resumed fewer than 2 times. The claim, `session_id`, worktree, env, `--settings` and MCP isolation are kept; the secret rotates (the old one is rejected); `generation` and `resume_count` go up by 1; `session_resumed` is emitted. The bootstrap is not resent: the worker gets a `SESSION_RESUMED` nudge with its phase and last progress time.
  - Otherwise the session is cleared, the claim expires and the task is requeued, as before. A spent budget or a failed relaunch also emits `session_resume_failed`.
  - The exit cause is stored in `sessions.exit_reason`: `crash`; `finished` (clean exit after `run-work-complete`); `user_exit` (clean exit before it, e.g. `/exit`); `unknown` (no exit status was observed, e.g. the tmux session was killed, the session was a legacy `pty:` one, or the session was cleared before `report-for-duty`). An `unknown` exit is always requeued.
- Idle: `worker_stale_soft_ms` / `worker_stale_nudge_ms` / `worker_stale_force_fail_ms`; runs that deliver hook events use `hook_idle_nudge_ms` / `hook_idle_escalate_ms`. A run with a tool call in flight is never stalled (`isStalled`, `lib/runSignals.ts`). A `Stop` hook (`turn_end`) closes tool calls that never reported back. Defaults: [configuration.md](./configuration.md).
- Progress ≠ liveness. Progress = a phase change (reported or inferred), a `git commit` seen in a hook event, or `run_started`, `review_submitted`, `work_complete`, `finalize_rebase_started`, `ready_to_merge`, `input_requested`, `input_provided`, `input_response`. No progress for `run_no_progress_escalate_ms` (60 min) → one `worker_needs_attention {reason: no_progress}`; new progress re-arms it. Runs awaiting input or in finalization are not checked.
- Stop hook: a Claude worker's `Stop` is refused while its run is unfinished (`stop_blocked`), at most 3 per run per 10 min and 9 per run.
- Coordinator restart: tmux sessions are adopted, unwritable sessions become `recoverable`, `app:` sessions end and their runs are requeued.

### Phase inference

The coordinator emits `phase_started {inferred: true, evidence, evidence_ts}` (`lib/phaseInference.ts`):

| Phase | Inferred when (first of) |
|-------|--------------------------|
| `explore` | TASK_START delivered |
| `implement` | `run-start` accepted, or a file edit after an explicit `explore` |
| `review` | a reviewer sub-agent spawned (`critic`, `integrator`, or a description mentioning `review`), or the first `review_submitted` |
| `complete` | after review, `git rebase main`/`origin/main` following an `orc review-read`, else `run-work-complete` |
| `finalize` | `run-work-complete` accepted |

- Commits are not evidence. Inference only moves forward; a newer explicit `phase_started` wins.
- Events are stamped at emission; phases are ordered by `seq` everywhere; a run that ended in the tick's batch gets no inferred phase.
- `review_read_at` in `run-activity.json` survives a coordinator restart.
- Inferred phases count as progress but do not reset the nudge count.

---

## Events

Stored in `events.db` (`seq`, `event_id`, `ts`, `event`, `agent_id`, `run_id`, `task_ref`, `payload`). Fields and per-event payloads: [schemas/event.schema.json](../schemas/event.schema.json) plus `lib/eventValidation.ts`. `event_id` is optional; `actor_type` is `agent|coordinator|human`.

| Event | Emitter | Note |
|-------|---------|------|
| `claim_created` | Coordinator | Task claimed for a worker |
| `claim_expired` | Coordinator / operator | Lease or input timeout, dead session, `orc run-expire` |
| `task_envelope_sent` | Coordinator | TASK_START delivered |
| `run_started` | Worker | `orc run-start` |
| `heartbeat` | Worker | `orc progress --event=heartbeat [--note]`; `payload.note` feeds `orc watch` |
| `phase_started` | Worker / Coordinator | `--phase`; inferred ones carry `inferred`, `evidence`, `evidence_ts` |
| `phase_finished` | Worker | `orc progress` |
| `review_submitted` | Reviewer (worker's agent_id) | `orc review-submit --outcome --reason [--reviewer]` |
| `work_complete` | Worker | `orc run-work-complete` |
| `finalize_rebase_started` | Worker | after `finalize_rebase_requested` |
| `ready_to_merge` | Worker | `run-work-complete` after a finalize rebase |
| `run_finished` | Worker | `orc run-finish` |
| `run_failed` | Worker | `orc run-fail` |
| `run_cancelled` | Coordinator / operator | cancel, reset, `kill-all` |
| `blocked`, `unblocked` | Worker | only via `orc progress` |
| `need_input` | Coordinator / Worker | run-start or in-progress nudge sent; validates `run-input-request` |
| `input_provided` | Master | legacy, via `orc progress` |
| `input_requested` | Worker | `orc run-input-request` |
| `input_response` | Master | `orc run-input-respond` / `respond_input` |
| `agent_online` | Coordinator | session confirmed alive |
| `reported_for_duty` | Worker | session ready |
| `agent_offline` | Coordinator | session lost, or unclaimed record removed (`reason: worker_record_removed`, `code`) |
| `agent_marked_dead` | Coordinator | unclaimed worker past the dead TTL; record removed |
| `agent_registered` | — | in schema, not emitted |
| `session_started`, `session_start_failed` | Coordinator | provider session launch |
| `session_reconciled` | Coordinator | restart reconciliation (`session_id`, `state`, `outcome`, `reason`) |
| `session_resumed`, `session_resume_failed` | Coordinator; `start-session` (master resume) | provider session resumed under the same `session_id` (`session_id`, `agent_id`, `run_id?`, `generation`, `provider_conversation_id?`, `reason?`; `reason` required on failure) |
| `task_added`, `task_updated` | Master / operator / Coordinator | task created / changed |
| `task_cancelled`, `task_delegated` | Master / operator | `cancel_task`, `delegate_task` |
| `task_dispatch_blocked` | Coordinator | dispatch refused (deps, no agent) |
| `command_queued` … `command_outcome_unknown` | Coordinator | durable command states: `queued`, `dispatching`, `send_started`, `sent`, `accepted`, `running`, `completed`, `failed`, `cancelled`, `outcome_unknown` |
| `coordinator_started`, `coordinator_stopped` | Coordinator | process start/stop |
| `worker_needs_attention` | Coordinator | `reason`: `stale` or `no_progress` |
| `remediation_applied` | Coordinator | automatic remediation |
| `activity_note` | Coordinator | to-do/note label changed (`label`, `source`); ≤ 1 per 30 s per run |
| `stop_blocked` | Coordinator | `Stop` hook refused (`phase`, `count`, `stop_hook_active`) |

- Notification events (master polling): `run_finished`, `run_failed`, `run_cancelled`, `worker_needs_attention`, `input_requested`, `input_response`.
- Query: `orc events-tail`, MCP `query_events` (filters `run_id`, `agent_id`, `event_type`, `after_seq`, free text; ≤ 500 rows).

---

## Local Control API

- The coordinator serves HTTP/JSON over the Unix socket in `control.json`. A project coordinator refuses to start without it (`ORC_CONTROL_API=off` or an unservable socket).
- Every request: `x-orc-protocol: 1` and `Authorization: Bearer <control.token>`.
- Callers identify with `x-orc-session: <session secret>` or `x-orc-operator: <operator.token>`. Actor and recipient names in a body are never trusted.
- Responses: `{ protocol_version, ok: true, result }` or `{ protocol_version, ok: false, error: { code, message } }`, `code` ∈ `unsupported_protocol_version|unauthenticated|forbidden|not_found|conflict|bad_request|unavailable|internal|busy`. `unavailable` = daemon stopping, stopped or crashed; `busy` = retry (the coordinator is sending to the terminal).
- Snapshot then subscribe: read `/v1/snapshot`, stream `/v1/events/stream?after=<cursor>`; reconnect from the last processed `seq`. An `event: null` frame is a corrupt row; its `seq` still advances.

### Credentials

| Credential | Held by | Notes |
|---|---|---|
| Bearer `control.token` | any process that can read the state dir | reaches the daemon only; names no caller |
| `ORC_SESSION_SECRET` | each worker/scout session's environment | state keeps its SHA-256 hash; a session id authenticates nobody |
| `ORC_MASTER_SECRET` | master provider environment (`orc start-session`) | MCP config references `${ORC_MASTER_SECRET}`; needed for `respond_input` / `run-input-respond` |
| `operator.token` | a shell with no session | acts as operator, recorded as `--actor-id` (`human` or a registered agent) or `human` |

- `ORC_SESSION_ID` names the session (e.g. `report-for-duty`); it is not a credential. `ORC_CONTROL_SOCKET` gives workers the socket path.
- Session states: `running`, `recoverable`, `unknown`, `offline`. Commands and messages need `running`; every other route accepts any non-`offline` session, so a `recoverable` worker can still report.
- An MCP server without `ORC_MASTER_SECRET` refuses every write tool and points at the CLI; read tools work.
- Limit: secrets are as private as the sandbox. A `full-access` process of the same user, or a sandbox without its own process namespace (Codex), can read `/proc/<pid>/environ`, `control.token` and `operator.token`; only Claude's sandbox hides `operator.token`. Sandboxed workers get only their worktree, the target `.git` write subtrees and the socket, and reach the socket on Linux/Codex only with `worker_pool.sandbox_network: open`.

### Routing and direct fallback

| Command group | While the coordinator runs | No coordinator |
|---|---|---|
| Worker lifecycle: `run-start`, `progress`, `run-work-complete`, `run-fail`, `run-finish`, `run-input-request`, `review-submit`, `report-for-duty` | `POST /v1/lifecycle` with the session secret; must be the run's own session | retried up to 2 min (`ORC_CONTROL_RETRY_MS`), then fail; no direct write |
| `memory-record` | `POST /v1/lifecycle` | operator shell (no secret) writes directly |
| Master/operator mutations: `task-cancel`, `task-reset`, `task-unblock`, `delegate`, `run-input-respond`, `run-expire`, `run-close`, `task-mark-done`; MCP `cancel_task`, `reset_task`, `unblock_task`, `delegate_task`, `close_run`, `respond_input` | `POST /v1/operator` | direct write under the state lock after the same authorization; prints `coordinator is not running; applying <op> directly` |
| Task authoring: `orc project task create\|edit\|import`, MCP `create_task`/`update_task` | `/v1/tasks…` | direct write, same message |
| Reads by a worker: `review-read`, `memory-wake-up` | `GET /v1/runs/<id>/reviews`, `GET /v1/memory/wake-up` | read state directly (read-only for a worker session; fails when no process holds the WAL files) |
| Always direct: `orc project plan import`, `worker-remove`, `worker-gc`, `kill-all`, `request_scout`, `remove_scout` | — | — |

A coordinator that holds the pid lock but does not answer gets a retryable `unavailable`, never a direct write.

### Routes

| Method | Path | Caller | Result |
|--------|------|--------|--------|
| `GET` | `/v1/status?events=<0-200>` | master, operator | The `orc status --json` view (`StatusView`) with `cursor` (highest event seq it read, in one read transaction; continue with `/v1/events/stream?after=cursor`) and `waiting_input` (questions are read just after the event window, so one may be newer than `cursor`). `events` sets `recentEvents` length (default 20, `0` → `[]`); out of range → `400 bad_request`. Reads only events from the latest session boundary, those of active runs, and the recent ones |
| `GET` | `/v1/snapshot` | master, operator | `{ project, cursor, generated_at, runs, sessions }` from one read transaction; runs carry `task_status`, `spec_revision` |
| `GET` | `/v1/events?after=&limit=` | master, operator | `{ events: [{ seq, event }], cursor }`, `limit` 1-1000 |
| `GET` | `/v1/events/stream?after=` | master, operator | NDJSON `{type:'event',seq,event}` / `{type:'heartbeat',cursor}` |
| `GET` | `/v1/runs/<run_id>/reviews` | own-run worker, master, operator | `{ reviews }`, latest per agent + reviewer label |
| `GET` | `/v1/memory/wake-up?wing=&budget=` | any session, operator | `{ initialized, text }`; `budget` 800 |
| `POST` | `/v1/stop-check` | worker session only | `{ allow, reason? }`; appends `turn_end` first |
| `POST` | `/v1/lifecycle` | worker session for that run | `{ op, agent_id, run_id?, ... }`; `op`: `run-start`, `run-fail`, `run-finish`, `run-work-complete`, `progress`, `review-submit`, `input-request`, `input-poll`, `input-timeout`, `memory-record`, `report-for-duty`. An offline session may still `input-poll` and repeat `run-finish` on a done run |
| `POST` | `/v1/operator` | master, operator | `{ op, actor_id?, ... }`; `op`: `cancel-task`, `reset-task`, `unblock-task`, `delegate-task`, `run-expire`, `run-close`, `task-mark-done`, `respond-input` (master only). The master's `actor_id` is ignored |
| `POST` | `/v1/commands` | `running` session | **Experimental.** Enqueue `{ run_id, recipient_session_id, idempotency_key, kind, payload }` → `202 { command }`. Delivered to `app:` sessions by `CommandDispatcher` |
| `POST` | `/v1/commands/<id>/ack` | `running` session | **Experimental.** `{ state }`: `accepted\|running\|completed\|failed` → `{ command }` |
| `GET`, `POST` | `/v1/messages` | `running` session | **Experimental.** `GET`: mailbox `{ messages }` (`include_consumed=1`). `POST`: send `{ run_id, recipient_session_id \| recipient_agent_id, idempotency_key, kind, text }` (exactly one recipient, else `bad_request`; an agent resolves to its running session, else `conflict`) → `202 { message }`. Kinds: `message`, `question`, `review_request` (needs artifact refs), `feedback`, `result` (needs parent id) |
| `POST` | `/v1/messages/<id>/consume` | `running` session | **Experimental.** → `{ message }` |
| `POST` | `/v1/terminals/provider`, `/v1/terminals/shell` | master, operator | `{ run_id }` → `{ terminal }` (tmux provider view / worktree shell outside any sandbox); id `provider:<session_id>` / `shell:<session_id>` of the run's latest session; a run with no session gets `conflict`. A newer session retires the old id |
| `GET` | `/v1/sessions` | master, operator | `{ sessions: [{ session_id, agent_id, run_id, provider, transport, terminal_id }] }`, running sessions; `terminal_id` (`provider:<session_id>`) is null when there is no live tmux terminal (`app:` sessions) |
| `GET` | `/v1/terminals/<id>/stream?columns=&rows=&lease_id=` | master, operator | NDJSON `{type:'snapshot',screen,cursor_x,cursor_y,columns,rows}` first, then `{type:'output',data}` (base64 pane bytes) and `{type:'heartbeat'}`, `{type:'exit',reason}` last; no reconnect, the viewer reopens. One `tmux -C` client per viewed terminal, shared by its viewers and stopped with the last. The size is applied for the `lease_id` holder, or the first viewer when no one holds the lease. A `provider:` id opens without a prior `POST`; a session with no terminal gets `not_found` |
| `POST` | `/v1/terminals/<id>/lease`, `/v1/terminals/<id>/input`, `/v1/terminals/<id>/resize` | master, operator (input/resize need the lease) | `acquire\|renew\|release`; `{ lease_id, data }`; `{ lease_id, columns, rows }`. A coordinator send never waits for the lease: it holds a `terminal_send` row in `control_leases` meanwhile, and operator input then gets a retryable `409 busy` |
| `GET` | `/v1/tasks`, `/v1/tasks/<ref>`, `/v1/tasks/<ref>/revisions` | master, operator | tasks with `spec_revision`, `content_hash`, `body_markdown`; encode the ref (`app%2Flogin`) |
| `POST` | `/v1/tasks`, `/v1/tasks/<ref>/revisions`, `/v1/tasks/import` | master, operator | create → `201`; edit needs `expected_revision` (stale → `409`; `status` → `400`); import `{ files: [{ path, text }], strict? }`, atomic, ≤ 32 MiB |

One row per method and full path; `lib/controlRoutes.test.ts` fails when a route the server matches is missing here, a listed method is not served, or an unlisted one (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) is served. **Experimental** routes are outside the semver contract and may change in a minor release.

Status codes: no or wrong credential `401`; wrong principal (e.g. a worker on a master route, another run) `403`; missing task/agent `404`; bad input `400`; refused transition `409`; unexpected `500`.

---

## Session Handles

Format `<transport>:<agent_id>` (`tmux:broken-nose`, `tmux:master`, `app:…`). Every terminal session runs in tmux (≥ 3.2). A `pty:` handle left by an older orc is treated as offline: the coordinator clears it and requeues its run.

| Transport | Owner | Survives coordinator exit |
|-----------|-------|---------------------------|
| `tmux` | private tmux server `tmux -L orc-<hash>` | yes; writable by any orc process of the user |
| `app` | the coordinator (structured runtime stdio) | no; run requeued |

### Session supervision

Each session is a `sessions` row in `events.db` (own id, transport, pid + `process_start`, `owner_id`, `owner_expires_at` renewed each tick).

Session identity (schema v8):

| Table | Column | Meaning |
|-------|--------|---------|
| `sessions` | `session_id` | stable across a resume; a resume rotates only `credential_hash` and bumps `generation` |
| `sessions` | `provider_conversation_id` | provider's conversation id, used to resume (nullable) |
| `sessions` | `generation`, `resume_count` | integers, default `0` |
| `sessions` | `exit_reason` | `crash`, `finished`, `user_exit`, `killed`, `unknown`, or null |
| `terminals` | `session_id`, `run_id` | keyed by session; `run_id` null for run-less sessions (master, scouts). Rows from before v8 keep their `<kind>:<run_id>` id but the migration marks them `offline` and drops their leases; the next open creates the session-keyed row |
| `messages` | `run_id` | null for run-less messages |
| `messages` | `recipient_session_id`, `recipient_agent_id` | exactly one is set (CHECK); `recipient_id` always names the recipient agent |

| State | Meaning |
|-------|---------|
| `running` | live and writable by the current owner |
| `recoverable` | alive, but this coordinator cannot write to it |
| `unknown` | live process does not match the recorded pid/start, or no identity recorded |
| `offline` | exited, supervisor gone, or replaced |

- Startup reconciles every non-offline session and records `session_reconciled` (`adopted`, `recoverable`, `unknown`, `exited`, `superseded`); it never kills one.
- Every direct write to a session (envelope, nudge, PR review) requires `running` and a matching pid/start; a mismatch moves it to `unknown`.
- Shutdown stops `app:` sessions and leaves tmux sessions for the next coordinator.
- `orc sessions` lists them; recovery: [recovery.md](./recovery.md#recoverable-or-unknown-sessions).

---

## Public surface (semver)

Everything in this section follows semver from 1.0: a breaking change needs a major release. Anything not listed (other modules under `dist/`, state file layout beyond the schemas) is internal, and anything marked **Experimental** may change in a minor release.

### Package exports

| Specifier | Resolves to | Why it is public |
|---|---|---|
| `orc-state` | `dist/index.js` + `dist/index.d.ts` | The library entry point (below) |
| `orc-state/schemas/<name>.json` | `dist/schemas/<name>.json` | JSON Schemas of the state files and events, for external validators |
| `orc` (bin) | `dist/cli/orc.js` | The CLI |

`package-contract.test.ts` fails when `exports` gains another entry or a path stops resolving.

### Root exports (`orc-state`)

| Export | Kind | Contract |
|---|---|---|
| `ControlClient` | class | Client for the control API (protocol v1), typed results per route (`status({ events? })` returns `StatusView`); `streamTerminal` and `subscribe` yield NDJSON frames |
| `ControlError` | class | `{ code: ControlErrorCode, status, message }` for every refused request |
| `CONTROL_PROTOCOL_VERSION` | const | `1` |
| `createAdapter`, `assertAdapterContract` | functions | Provider adapter factory + contract check |
| `validateAgents` | function | `agents.json` validator (an authoritative file; projections have no public validator) |
| `validateEventObject` | function | Event validator (`schemas/event.schema.json` + `lib/eventValidation.ts` rules) |
| `getWorkerBootstrap`, `getMasterBootstrap` | functions | Package bootstrap templates |
| `ControlClientOptions`, `EventRow`, `OperatorResult`, `OperatorResults`, `OperatorOp`, `OperatorRequest` | types | Client options, event rows, `/v1/operator` request and per-`op` results |
| `ControlResponse`, `ControlErrorBody`, `ControlErrorCode`, `ControlEndpoint`, `StreamFrame`, `TerminalFrame`, `SessionTerminalView` | types | Protocol envelope, endpoint descriptor and frames |
| `ControlSnapshot`, `StatusView`, `LifecycleRequest`, `LifecycleResult`, `ProjectTaskView`, `TaskAuthoringInput`, `TaskImportResult`, `TaskMarkdownSource`, `ReviewSubmittedEvent`, `TerminalRecord` | types | Route bodies and results |
| `SubmitCommandRequest`, `AckState`, `DurableCommand`, `SemanticMessage`, `SendMessageInput` | types | **Experimental**, like the `/v1/commands…` and `/v1/messages…` routes they serve |

### Control API protocol v1

| Element | Contract |
|---|---|
| Transport | HTTP/JSON over the Unix socket named in `control.json` (`protocol_version: 1`, `transport: "unix"`) |
| Headers | `x-orc-protocol: 1`; `Authorization: Bearer <control.token>`; `x-orc-session` or `x-orc-operator` |
| Envelope | `{ protocol_version, ok: true, result }` / `{ protocol_version, ok: false, error: { code, message } }` |
| Error codes | `unsupported_protocol_version`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `bad_request`, `unavailable`, `internal`, `busy` |
| Routes | The [Routes](#routes) table, except rows marked **Experimental** (`/v1/messages…`, `/v1/commands…`) |
| Event stream frames | `{ type: "event", seq, event }`, `{ type: "heartbeat", cursor }` |
| Terminal stream frames | `{ type: "snapshot", screen, cursor_x, cursor_y, columns, rows }`, `{ type: "output", data }`, `{ type: "heartbeat" }`, `{ type: "exit", reason }` |

### CLI commands

| Group | Commands |
|---|---|
| Session and setup | `start-session`, `init`, `install`, `install-agents`, `install-skills`, `project`, `mcp-server` |
| Inspection | `status`, `watch`, `attach`, `doctor`, `preflight`, `runs-active`, `run-info`, `sessions`, `events-tail`, `events-filter`, `event-cursor`, `waiting-input`, `worker-status`, `terminal`, `memory-status`, `memory-search` |
| Master / operator | `delegate`, `task-mark-done`, `task-reset`, `task-unblock`, `task-cancel`, `run-expire`, `run-close`, `run-input-respond`, `worker-remove`, `worker-gc`, `kill-all`, `pr-diff`, `pr-review`, `pr-merge`, `pr-status` |
| Worker lifecycle (flags below) | `report-for-duty`, `run-start`, `progress`, `review-submit`, `review-read`, `run-work-complete`, `run-finish`, `run-fail`, `run-input-request`, `memory-wake-up`, `memory-record` |
| Hooks and debug | `stop-check` (Claude Stop hook), `control` (debug; its `command`, `ack`, `message`, `messages` and `consume` subcommands are **Experimental**, like the routes they call), `run-heartbeat` (deprecated no-op) |

Flags are those in `cli/usage.ts` (`orc <command> --help`); `--project=<id>` selects a project for any command.

### CLI `--json` output

| Command | Shape |
|---|---|
| `orc status --json [--events=<0-200>]` | `{ cursor, project, agents, master, worker_capacity, scouts, tasks, claims, finalization, failures, waiting_input, recentEvents, eventReadError }`; `--events` sets the `recentEvents` length (default 20, `0` → `[]`) |
| `orc status --mine --json` | `{ agent, assigned_tasks, queued_tasks }` |
| `orc doctor --json` | `{ ok, registered_workers, active_claims, checks }`; exit 1 when not `ok` |
| `orc preflight --json` | `{ ok, project, checks, warnings, details }`; exit 1 when not `ok` |
| `orc runs-active --json` | `{ project, total, runs, event_read_error }` |
| `orc run-info <run_id> --json` | the run's claim fields + `task_title`, `worktree_path`, `task_spec_revision_status` |
| `orc sessions --json` | `{ total, sessions }` |
| `orc events-tail --json` | `{ total, events }` |
| `orc events-filter --json` | array of events |
| `orc review-read --json` | `{ count, reviews }` |
| `orc waiting-input --json` | array of `{ run_id, agent_id, task_ref, question, waiting_seconds, input_requested_at }` |
| `orc worker-status --json` | array of agent records + `active_task_ref`, `heartbeat_seconds_ago`; one record when given an `agent_id` |

### Worker lifecycle commands

| Command | Required flags |
|---|---|
| `orc report-for-duty` | `--agent-id`, `--session-id` |
| `orc run-start` | `--run-id`, `--agent-id` |
| `orc progress` | `--event`, `--run-id`, `--agent-id` (`--phase` for `phase_*`) |
| `orc review-submit` | `--run-id`, `--agent-id`, `--outcome=approved\|findings`, `--reason` |
| `orc review-read` | `--run-id` |
| `orc run-work-complete` | `--run-id`, `--agent-id` |
| `orc run-finish` | `--run-id`, `--agent-id` |
| `orc run-fail` | `--run-id`, `--agent-id` (`--policy=requeue\|block`) |
| `orc run-input-request` | `--run-id`, `--agent-id`, `--question` |
| `orc memory-wake-up`, `orc memory-record` | `--content` for `memory-record` |

### MCP tools

| Group | Tool names |
|---|---|
| Reads | `list_tasks`, `get_task`, `list_agents`, `list_active_runs`, `list_stalled_runs`, `get_run`, `get_status`, `get_agent_workview`, `get_recent_events`, `query_events`, `list_waiting_input`, `list_worktrees`, `get_notifications` |
| Task authoring and control | `create_task`, `update_task`, `delegate_task`, `cancel_task`, `reset_task`, `unblock_task`, `close_run`, `respond_input` |
| Scouts | `request_scout`, `get_scout_report`, `remove_scout` |
| Memory | `memory_wake_up`, `memory_recall`, `memory_search`, `memory_store`, `memory_status` |

### Config keys

| Section | Keys (defaults and meaning: [configuration.md](./configuration.md#settings)) |
|---|---|
| top level | `default_provider`, `default_execution_mode` |
| `master` | `provider`, `model`, `execution_mode` |
| `worker_pool` | `max_workers`, `provider`, `model`, `provider_models`, `execution_mode`, `runtime`, `sandbox_network` |
| `sessions` | `resume` |
| `coordinator` | `mode`, `tick_interval_ms`, `concurrency_limit`, `run_start_timeout_ms`, `session_ready_timeout_ms`, `session_ready_nudge_ms`, `session_ready_nudge_interval_ms`, `run_inactive_nudge_ms`, `run_inactive_nudge_interval_ms`, `worker_stale_soft_ms`, `worker_stale_nudge_ms`, `worker_stale_force_fail_ms`, `hook_idle_nudge_ms`, `hook_idle_escalate_ms`, `run_no_progress_escalate_ms`, `memory_prune_interval_ms`, `merge_strategy`, `pr_provider`, `pr_push_remote`, `pr_finalize_lease_ms` |
| `leases` | `default_ms`, `finalize_ms` |
| environment | the `ORC_*` variables in [configuration.md](./configuration.md#environment-variables) |

### Event types

| Contract | Source |
|---|---|
| Event names and payloads | the [Events](#events) table and [schemas/event.schema.json](../schemas/event.schema.json); a new event type is a minor change, removing or renaming one is major |
| Notification events | `run_finished`, `run_failed`, `run_cancelled`, `worker_needs_attention`, `input_requested`, `input_response` |

---

## Invariants

1. **One active claim per task**: at most one run in `claimed`/`in_progress` per `task_ref`.
2. **Referential integrity**: every run's `task_ref` exists in `runtime.db`; its `agent_id` in `agents.json` while active.
3. **Status consistency**: a task's `runtime.db` status agrees with its active run in `events.db` `runs` — `claimed` ↔ one `claimed` run, `in_progress` ↔ one `in_progress` run, `todo` ↔ none; a `done` task may still have its run in finalization. `reconcile` repairs drift.
4. **Pinned spec**: a run keeps the revision it was claimed with; later edits affect only future runs.
5. **Single terminal outcome**: completion and failure retries are idempotent; `done` is recorded once per run.
6. **Forward-only finalization**: `finalization_state` never moves backwards.
7. **Event compliance**: events satisfy `schemas/event.schema.json` and `lib/eventValidation.ts`; `seq` strictly increases.
8. **Lease enforcement**: no expired claim stays `claimed`/`in_progress` outside the finalize window.
9. **Write exclusivity**: state changes only through `orc` commands, MCP tools or the coordinator; one coordinator owns a project's writes at a time.
