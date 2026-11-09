# Contracts & Invariants

State files, task and run lifecycle, events, the local control API and the invariants that hold across them.

---

## State Files

Project state directory: `<data-home>/projects/<project_id>/` (sessions receive it as `ORC_STATE_DIR`). Agents never write it directly; every change goes through `orc` commands, MCP tools or the coordinator.

### Authoritative stores

| File | Format | Contents |
|------|--------|----------|
| `runtime.db` | SQLite | Project task store: `tasks`, `task_spec_revisions`, `task_dependencies`, `task_transitions`, `task_runs`, `task_imports`, `plan_documents` |
| `events.db` | SQLite (WAL), schema v10 | Append-only `events` (+ FTS index) and operational tables: `runs` (authoritative claims), `sessions`, `commands`, `messages`, `input_requests`, `offsets`, `control_leases`, `terminals`, `pending_session_starts` (session-start hook records waiting for their launch to be recorded) |
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
| `coordinator.pid` | Coordinator pid lock (pid + process start + `schemas`, the schema range it supports) |
| `control.json` | Control API descriptor (protocol version, transport, socket path, daemon pid, `schemas`) |
| `control.token` | Control API bearer token, `0600`, rotated on each daemon start |
| `control.sock` | Control API Unix socket, `0600` (when the path is too long: `~/.orc/run/` on macOS, else the OS temp dir) |
| `operator.token` | Operator token, rewritten on every coordinator start |
| `run-worktrees.json` | Run → worktree/branch mapping |
| `worktrees/<run_id>/` | Run worktrees (git worktrees of the target repo; `ORC_WORKTREES_DIR` overrides) |
| `run-specs/<run_id>.md` | Pinned task revision body, read-only (`0444`), the worker's `task_spec_path` |
| `event-checkpoint.json` | Coordinator event-processing checkpoint (`last_processed_seq`, processed ids) |
| `run-activity.json` | Coordinator per-run activity: label, source, last tool, tool calls in flight, last turn end, `review_read_at`, `last_commit_ts` (newest hook-seen `git commit`) (`lib/runSignals.ts`) |
| `pty-hook-events/<agent_id>.ndjson` | Hook records (`permission`, `tool_start`, `tool`, `activity`, `turn_end`); drained only by the coordinator tick via `.processing` rename; name kept for compatibility; see [adapters.md](./adapters.md) |
| `pty-hook-events/<agent_id>.ndjson.tasks.json` | Claude hook sidecar: to-do labels by id + active id |
| `pty-logs/<agent_id>.log` | tmux output capture (output tails); `pty-` directory names are kept for compatibility |
| `pty-settings/<agent_id>.json` | Per-session provider settings (hooks, sandbox); name kept for compatibility |
| `app-server/<agent_id>.{sock,exit,turn.json}` | Codex app-server session: its listening socket (a symlink when the path is too long), the exit status its wrapper writes, and the latest turn with the command that started it; see [adapters.md](./adapters.md#codex-app-server-sessions) |
| `mcp-config.json` | Master MCP config written by `orc start-session` (references `${ORC_MASTER_SECRET}`, never its value) |
| `.lock` | Advisory lock serializing JSON state writes |

### Schemas

| Schema | Enums |
|--------|-------|
| [backlog.schema.json](../schemas/backlog.schema.json) | `status`: `todo\|claimed\|in_progress\|blocked\|done\|cancelled`; `task_type`: `implementation\|refactor`; `priority`: `low\|normal\|high\|critical`; `planning_state`: `ready_for_dispatch\|archived`; `review_level`: `none\|light\|full`; `merge_strategy`: `direct\|pr`; `required_provider`: `codex\|claude\|gemini` |
| [agents.schema.json](../schemas/agents.schema.json) | `status`: `idle\|running\|offline\|dead` (`dead` is never set; such records are removed); `role`: `worker\|reviewer\|master\|scout`; `provider`: `codex\|claude\|gemini\|human` |
| [claims.schema.json](../schemas/claims.schema.json) | `state`: `claimed\|in_progress\|done\|failed`; `finalization_state`: `awaiting_finalize\|finalize_rebase_requested\|finalize_rebase_in_progress\|ready_to_merge\|blocked_finalize\|pr_created\|pr_review_in_progress\|pr_merged\|pr_failed\|null`; `input_state`: `awaiting_input\|null` |
| [event.schema.json](../schemas/event.schema.json) | see **Events** |
| [run-worktrees.schema.json](../schemas/run-worktrees.schema.json), [event-checkpoint.schema.json](../schemas/event-checkpoint.schema.json), [snapshot.schema.json](../schemas/snapshot.schema.json) | — |

Task refs: `<feature>/<slug>`. Run ids: `run-<timestamp>-<16 hex>` (64 random bits); a run is never deleted or reassigned to another task/agent, and `cancel_task` keeps its runs as `failed` with reason `cancelled`. Worker agent ids: random orc-themed two-word names, unique among active workers.

---

## Task Lifecycle

```
todo → claimed → in_progress → done
          ↓           ↓
         todo (requeue) / blocked
todo/claimed/in_progress/blocked → cancelled
```

| Transition | Cause and owner |
|---|---|
| `todo → claimed` | Coordinator atomically verifies readiness and creates a run pinned to the latest revision |
| `claimed → in_progress` | Worker `orc run-start` |
| `in_progress → done` | Coordinator after a confirmed merge (`merge_succeeded`), once. `run-work-complete` changes only the run's finalization state. Recovery: `orc task-mark-done` |
| `claimed/in_progress → todo` | Failed run requeued (`run-fail` default policy, lease expiry, dead session not resumed); counts an attempt and sets `requeue_eligible_after` |
| `claimed/in_progress → blocked` | `run-fail --policy=block` (reason required), or 5 failed attempts |
| `blocked → todo` | Operator `orc task-unblock` / master `unblock_task` |
| `non-todo → todo` | Operator `orc task-reset` / master `reset_task`, including a done or cancelled task |
| `todo/claimed/in_progress/blocked → cancelled` | Master `cancel_task` / operator `orc task-cancel` |

- Every status change is a `task_transitions` row (cause, run, actor) written in the same transaction as the task and run binding. `runtime.db` commits first; the `events.db` run row and event follow in every path that writes both, and startup reconciliation repairs a crash between them. A snapshot's task `status` may therefore be ahead of its `cursor` for a moment.
- Infrastructure failures (dispatch, session start, run-start timeout) do not count an attempt.
- A run that ends after its task was reset or cancelled leaves the task alone.
- Status is never edited through a spec or `update_task`; imports never apply status.
- A `todo` task with an unfinished dependency stays `todo`; `blocked` means an explicit decision or failure.

### Dispatch eligibility

Derived at claim time, never stored:

- `status == todo`, every `depends_on` ref `done` in the same project
- `requeue_eligible_after` null or past
- `planning_state` absent or `ready_for_dispatch`
- `owner` absent or the claiming agent
- agent can run the task (`required_provider`)
- capacity: `max_workers` − agents with an active claim > 0

---

## Run Lifecycle

Readiness comes before the run starts: the coordinator sends TASK_START once the worker's session is ready, meaning a `reported_for_duty` event for its current `session_token`. A Claude or `full-access` Codex CLI session's `SessionStart` hook produces it (`payload.source: 'hook'`); Gemini and sandboxed Codex CLI sessions run `orc report-for-duty` and are nudged with `SESSION_NUDGE`; an `app:` session is ready after its handshake. A session that is not ready within `coordinator.session_ready_timeout_ms` is requeued (`ERR_SESSION_READY_TIMEOUT`). Per provider: [adapters.md → Session readiness](./adapters.md#session-readiness).

| Command | Precondition | Effect |
|---------|--------------|--------|
| `orc run-start` | claim `claimed`, agent matches | claim + task → `in_progress` |
| `orc progress --event=<e>` | claim `in_progress` (`phase_*` need `--phase`; `blocked`/`need_input` need `--reason`) | event recorded |
| `orc run-work-complete` | claim `in_progress`, `finalization_state` null or `finalize_rebase_in_progress` | `work_complete` (→ `awaiting_finalize`) or `ready_to_merge` (after a finalize rebase) |
| `orc run-finish` | claim `in_progress`, task `done` (refused before the merge) | claim → `done` |
| `orc run-fail [--policy=requeue\|block]` | claim `claimed`/`in_progress` | claim → `failed`; task requeued or blocked |
| `orc run-input-request` | claim `in_progress` | `input_state → awaiting_input`; blocks until `run-input-respond` |

Direct mode: after work-complete the coordinator merges, or requests a finalize rebase (`finalize_rebase_requested` → worker `finalize_rebase_started` → rebase → `run-work-complete` again), then sends FINALIZE_SUCCESS; the worker calls `run-finish`. PR mode: the coordinator sends PR_REVIEW, which carries the PR loop for the task's current review level; the worker runs it and calls `run-work-complete`; the coordinator merges the PR. The worker workflow is `templates/worker-bootstrap-v2.txt`, rendered by `lib/sessionBootstrap.ts` with only the run's merge-mode and review-level steps (the PR loop rides in PR_REVIEW).

### Lease and liveness

- Lease: `leases.default_ms` (30 min); `leases.finalize_ms` (60 min) once work is complete; `coordinator.pr_finalize_lease_ms` (24 h) for PR finalization.
- Renewal: the coordinator extends the lease when it processes the run's lifecycle/phase events. Claude hook activity renews only when newer than `last_heartbeat_at` and the lease is half used or the heartbeat half a lease old (`shouldRenewFromHookActivity`, `lib/runActivity.ts`); otherwise it only updates `run-activity.json`. Workers send no periodic heartbeat.
- Expiry: claim → `failed` (`ERR_LEASE_EXPIRED`), task requeued with backoff, blocked after 5 attempts; `claim_expired` emitted. A run whose task is already `done` (finalize window) is skipped. An input wait over 1 h expires with `ERR_INPUT_TIMEOUT`.
- Liveness: each tick probes the session (`adapterProbeLiveness`) — `tmux:` asks the private tmux server for the pane process; a legacy `pty:` handle from an older orc always probes dead. A probe is `alive`, `dead` (no tmux server, no such session, or the pane process exited) or `indeterminate` (tmux spawn error, its 10 s timeout, any other tmux error, or a probe that throws). A run is treated as dead only after 2 dead probes in a row (`CONSECUTIVE_DEAD_PROBES`, `countDeadProbe` in `lib/sessionSupervisor.ts`, the same rule as the master); a live probe resets the count, an indeterminate one neither counts nor resets, so tmux trouble never ends a run. This check is the only dead-session path for a run with a session; the `session_dead` remediation acts only on an offline or handle-less worker. The lease is renewed on a live probe only while the run's session is `running`: a `recoverable` or `unknown` session gets no renewals and, after `SESSION_OWNER_TTL_MS` (2 min) in that state, one `worker_needs_attention {reason: session_not_running}`; if the worker stays silent its lease then expires (`ERR_LEASE_EXPIRED`). A dead process goes through one resume-or-requeue decision (`resumeOrRequeue` in `coordinator.ts`, rules in `lib/sessionResume.ts`):
  - Resumed in place when all hold: `sessions.resume` is `auto`; the provider supports resume (Claude CLI, Codex `app:`); a provider conversation id was recorded; the exit was a crash (a signal or a non-zero exit code); the run worktree exists; the run has resumed fewer than 2 times. The claim, `session_id`, worktree, env, `--settings` and MCP isolation are kept; the secret rotates (the old one is rejected); `generation` and `resume_count` go up by 1; `session_resumed` is emitted. The bootstrap is not resent: the worker gets a `SESSION_RESUMED` nudge with its phase and last progress time.
  - Otherwise the session is cleared, the claim expires and the task is requeued, as before. A spent budget or a failed relaunch also emits `session_resume_failed`.
  - The exit cause is stored in `sessions.exit_reason`: `crash`; `finished` (clean exit after `run-work-complete`); `user_exit` (clean exit before it, e.g. `/exit`); `unknown` (no exit status was observed, e.g. the tmux session was killed, the session was a legacy `pty:` one, or the session was cleared before it was ready). An `unknown` exit is always requeued.
- Idle: `worker_stale_soft_ms` / `worker_stale_nudge_ms` / `worker_stale_force_fail_ms`; runs that deliver hook events use `hook_idle_nudge_ms` / `hook_idle_escalate_ms`. A run with a tool call in flight is never stalled (`isStalled`, `lib/runSignals.ts`). A `Stop` hook (`turn_end`) closes tool calls that never reported back. Defaults: [configuration.md](./configuration.md).
- Progress ≠ liveness. Progress = a phase change (reported or inferred), a `git commit` seen in a hook event, or `run_started`, `review_submitted`, `work_complete`, `finalize_rebase_started`, `ready_to_merge`, `input_requested`, `input_provided`, `input_response`. No progress for `run_no_progress_escalate_ms` (60 min) → one `worker_needs_attention {reason: no_progress}`; new progress re-arms it. Runs awaiting input or in finalization are not checked.
- Stop hook: a Claude worker's `Stop` is refused while its run is unfinished (`stop_blocked`), at most 3 per run per 10 min and 9 per run.
- Coordinator restart: tmux sessions are adopted, unwritable sessions become `recoverable`. Live `app:` (Codex app-server) sessions are adopted after the PID + start-time check, reconnected and their thread reattached; an `app:` session that cannot be adopted is reconciled `exited` with the reason, then resumed (after a crash) or requeued ([adapters.md → Codex app-server sessions](./adapters.md#codex-app-server-sessions)).

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

Worker identity: `run_id` is the stable key for one piece of a worker's work. Agent names (`surly-mire`) are reused across runs, and a session keeps its `session_id` across resumes, so neither keys a run on its own; `session_id` + `generation` identify one live process. Run events (`RUN_SESSION_EVENTS` in `lib/eventValidation.ts`: the run, phase, finalization, input, blocking, heartbeat, review and attention events below) get the run's latest session stamped into `payload.session_id` and `payload.generation` when the event is written, if the run has a session; a caller-supplied `session_id` is kept. Runs without a session, and events written before this, carry neither.

| Event | Emitter | Note |
|-------|---------|------|
| `claim_created` | Coordinator | Task claimed for a worker |
| `claim_expired` | Coordinator / operator | Lease or input timeout, dead session, `orc run-expire`; always carries `agent_id`; payload `policy`, `code` (`ERR_LEASE_EXPIRED`, `ERR_INPUT_TIMEOUT`, `ERR_MANUAL_EXPIRE`), `reason`, plus the task outcome fields below |
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
| `run_failed` | Worker | `orc run-fail`; payload `policy`, `reason?`, `code?`, plus the task outcome fields below |
| `finalization_changed` | Coordinator | a run's finalization fields changed (`setRunFinalizationState`), same transaction as the run row; payload `from`, `to`, `retry_count`, `blocked_reason`, `pr_ref`, `pr_created_at`; a write that changes nothing emits none |
| `run_cancelled` | Coordinator / operator | cancel, reset, `kill-all` |
| `blocked`, `unblocked` | Worker | only via `orc progress` |
| `need_input` | Coordinator / Worker | run-start or in-progress nudge sent; validates `run-input-request` |
| `input_provided` | Master | legacy, via `orc progress` |
| `input_requested` | Worker | `orc run-input-request` |
| `input_response` | Master, operator | `orc run-input-respond` / `respond_input` |
| `agent_online` | Coordinator | session confirmed alive |
| `reported_for_duty` | Worker (`report-for-duty`) or coordinator (session-start hook) | session ready; `payload`: `session_token`, and from the hook `source: 'hook'` and `provider_conversation_id` |
| `agent_offline` | Coordinator | session lost, or unclaimed record removed (`reason: worker_record_removed`, `code`) |
| `agent_marked_dead` | Coordinator | unclaimed worker past the dead TTL; record removed |
| `agent_registered` | — | in schema, not emitted |
| `session_started`, `session_start_failed` | Coordinator | provider session launch |
| `scout_launched`, `scout_launch_failed` | Coordinator (`request-scout`) | a requested scout is up and briefed (`requested_by`, `provider`, `working_directory`, `session_handle`), or could not be launched or briefed and was removed (`requested_by`, `provider`, `reason`, `hint?`); carry the scout's `agent_id` |
| `session_opened` | Coordinator; `start-session` (master) | a session row was inserted (`session_id`, `agent_id`, `run_id?`, `state`, `transport`, `generation`) |
| `session_state_changed` | Coordinator; `start-session`, `kill-all` (`actor_type: human`) | any other session-row write: close, supersede, exit, resume start, reset rollback (`session_id`, `agent_id`, `run_id?`, `from`, `to`, `reason?`, `generation`); `from` equals `to` when only metadata changed (a resume starting) |
| `session_reconciled` | Coordinator; `start-session` (master repair) | restart reconciliation (`session_id`, `state`, `previous_state`, `outcome`, `reason`, `generation?`); `outcome: restored` when `start-session` reopens a live master's closed session |
| `master_retired` | Coordinator; `start-session` (attached master ended) | master went offline and its session closed (`session_handle`, `session_id`, `probe: { alive, reason, pid }`, `consecutive_failures`) |
| `session_resumed`, `session_resume_failed` | Coordinator; `start-session` (master resume) | provider session resumed under the same `session_id` (`session_id`, `agent_id`, `run_id?`, `generation`, `provider_conversation_id?`, `reason?`; `reason` required on failure) |
| `task_added`, `task_updated` | Master / operator / Coordinator | task created / changed |
| `task_cancelled`, `task_delegated` | Master / operator | `cancel_task`, `delegate_task`; `task_cancelled` payload lists every cancelled run in `cancelled_run_ids` |
| `task_dispatch_blocked` | Coordinator | dispatch refused (deps, no agent) |
| `command_queued` … `command_outcome_unknown` | Coordinator | durable command states: `queued`, `dispatching`, `send_started`, `sent`, `accepted`, `running`, `completed`, `failed`, `cancelled`, `outcome_unknown` |
| `coordinator_started`, `coordinator_stopped` | Coordinator | process start/stop |
| `worker_needs_attention` | Coordinator | `reason`: `stale` or `no_progress` (with `idle_ms`), or `session_not_running` (`session_id`, `session_state`, `not_running_ms`, `state_reason?`) |
| `remediation_applied` | Coordinator | automatic remediation |
| `activity_note` | Coordinator | to-do/note label changed (`label`, `source`); ≤ 1 per 30 s per run |
| `stop_blocked` | Coordinator | `Stop` hook refused (`phase`, `count`, `stop_hook_active`) |

- Notification events (master polling): `run_finished`, `run_failed`, `run_cancelled`, `worker_needs_attention`, `input_requested`, `input_response`.
- Task outcome fields on `run_failed` and `claim_expired`: `task_status` (resulting status: `todo` when requeued, `blocked` after `--policy=block` or the fifth attempt, unchanged when an operator already moved the task), `attempt_count`, `requeue_eligible_after`, `blocked_reason` (only when `blocked`). `policy` is what was asked for; `task_status` is what happened. Events written before these fields existed lack them, and a stored `claim_expired` from before `agent_id` was required still reads back (the rule applies on append).
- A terminal run event (`run_finished`, `run_failed`, `run_cancelled`, `claim_expired`) also clears the run's finalization fields; no `finalization_changed` is emitted for that.
- Lease renewals are snapshot-only: a renewal without a `heartbeat` event (coordinator phase-signal or PID-probe renewal, finalize lease) changes `lease_expires_at` with no event; read it from `/v1/snapshot`.
- Query: `orc events --json` and MCP `query_events` share one handler and return `{ events, last_seq, has_more }`. Filters: `run_id`, `agent_id`, `task_ref`, `event_type`, `notifications_only`, `fts_query` (FTS5). `limit` defaults to 25, max 100 (larger is an error). With `after_seq`: the oldest `limit` matching events after it, ascending; `last_seq` is the highest seq returned (`after_seq` when empty), `has_more` when more follow. Without: the newest `limit` matching events, ascending; `last_seq` is the newest matching seq (0 when none), `has_more` when older ones exist. Events are compact (`event_id`, `actor_type`, `actor_id` dropped; `input_response` loses `payload.question`) unless `verbose`. A master starts its notification cursor at `get_status.last_notification_seq`.

---

## Local Control API

- The coordinator serves HTTP/JSON over the Unix socket in `control.json`. A project coordinator refuses to start without it (`ORC_CONTROL_API=off` or an unservable socket).
- Every request: `x-orc-protocol: <version>` (a version in the coordinator's `[min, max]` range, today `[1, 1]`) and `Authorization: Bearer <control.token>`. `GET /v1/health` needs only the bearer token and reports `protocol_versions: [min, max]`, so a client of any version can ask what the coordinator speaks; any other route answers a missing or out-of-range header with `400 unsupported_protocol_version`.
- Callers identify with `x-orc-session: <session secret>` or `x-orc-operator: <operator.token>`. Actor and recipient names in a body are never trusted.
- Responses: `{ protocol_version, ok: true, result }` or `{ protocol_version, ok: false, error: { code, message } }`, `code` ∈ `unsupported_protocol_version|unauthenticated|forbidden|not_found|conflict|bad_request|unavailable|internal|busy`. `unavailable` = daemon stopping, stopped or crashed; `busy` = retry (the coordinator is sending to the terminal). `ControlClient` adds two client-side codes: `aborted` (the caller's signal fired) and `timeout` (no answer in time; the coordinator may still have applied the request, so it is never retried automatically). A body that is not a control envelope (non-JSON, empty) becomes a `ControlError` with the HTTP status and a body excerpt: `internal` for a request (it reached a server, so it is never treated as unsent), and for a stream open `unavailable` on 5xx, else `internal`.
- Snapshot then subscribe: read `/v1/snapshot`, stream `/v1/events/stream?after=<cursor>`; reconnect from the last processed `seq`. An `event: null` frame is a corrupt row; its `seq` still advances.

### Credentials

| Credential | Held by | Notes |
|---|---|---|
| Bearer `control.token` | any process that can read the state dir | reaches the daemon only; names no caller |
| `ORC_SESSION_SECRET` | each worker/scout session's environment | state keeps its SHA-256 hash; a session id authenticates nobody |
| `ORC_MASTER_SECRET` | master provider environment (`orc start-session`) | MCP config references `${ORC_MASTER_SECRET}`; needed for `respond_input`; `run-input-respond` also works with the operator token |
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
| Scouts: MCP `request_scout`, `remove_scout` (ops `request-scout`, `remove-scout`), `get_scout_report` | `POST /v1/operator`, `GET /v1/scouts/<agent_id>/report`; `request_scout` returns `{ agent_id }` at once and the coordinator launches and briefs the scout, ending in `scout_launched` or `scout_launch_failed` | `remove_scout` and `get_scout_report` direct, same message; `request_scout` is refused with `unavailable` "coordinator not running; restart_coordinator first" (no unsupervised scout session) |
| Task authoring: `orc project task create\|edit\|import`, MCP `create_task`/`update_task` | `/v1/tasks…` | direct write, same message |
| Plan import: `orc project plan import` | `POST /v1/plans/import` | direct write, same message |
| Reads by a worker: `review-read`, `memory-wake-up` | `GET /v1/runs/<id>/reviews`, `GET /v1/memory/wake-up` | read state directly (read-only for a worker session; fails when no process holds the WAL files) |
| Always direct: `worker-remove`, `worker-gc`, `kill-all` | — | — |

A coordinator that holds the pid lock but does not answer gets a retryable `unavailable`, never a direct write.

### Routes

| Method | Path | Caller | Result |
|--------|------|--------|--------|
| `GET` | `/v1/health` | any authenticated caller (worker session, master, operator); no protocol header needed | `{ version, protocol_version, protocol_versions, schema_version, schemas, started_at, code_root, code_mtime, build_id }`: what the running coordinator loaded; `protocol_versions` is the `[min, max]` protocol range it accepts (`protocol_version` is the max). `schemas` is `{ events, runtime }`, each `{ version, min_compatible }`: the schema this coordinator writes for `events.db` / `runtime.db` and the oldest code that can read it; it can open a database at a newer version whose recorded `min_compatible` is at or below its own (`schema_version` is `schemas.events.version`; `lib/schemaCompat.ts`). `version` and `build_id` are the staleness signal: `build_id` is the content hash `scripts/build.ts` writes to `dist/build-id` (`git-<sha>` in a source checkout, null when unknown), so it survives npm normalising tarball mtimes. `orc doctor` and `orc start-session` warn when either differs from the code on disk; a source checkout also compares `code_mtime` (ISO, newest mtime among its entry module and `lib/` files at startup). An app compares `version`/`build_id` with the installed package the same way |
| `GET` | `/v1/status?events=<0-200>` | master, operator | The `orc status --json` view (`StatusView`, without the `coordinator` field the CLI adds) with `cursor` (highest event seq, read before claims, backlog and agents, so an event committed during the build has seq above `cursor` and the view may already show it; continue with `/v1/events/stream?after=cursor`) and `waiting_input` (questions are read just after the event window, so one may be newer than `cursor`). `events` sets `recentEvents` length (default 20, `0` → `[]`); out of range → `400 bad_request`. Reads only events from the latest session boundary, those of active runs, and the recent ones |
| `GET` | `/v1/snapshot` | master, operator | `{ project, cursor, generated_at, runs, sessions }` from one read transaction; runs carry `task_status`, `spec_revision` |
| `GET` | `/v1/runs?state=&stale_after_ms=` | master, operator | `{ runs }`: the `orc runs --json` / MCP `list_runs` view; `state` is `active` (default), `stalled` or `waiting_input`, anything else `bad_request` |
| `GET` | `/v1/events?after=&limit=&run_id=&agent_id=&event_type=` | master, operator | `{ events: [{ seq, event }], cursor }`, `limit` 1-1000; the optional `run_id`, `agent_id` and `event_type` filters combine with AND (an empty value → `400 bad_request`). `cursor` is the last returned `seq`, so a filtered page continues from it. `event` is an `OrcEvent`, or `null` for a corrupt row |
| `GET` | `/v1/runs/<run_id>` | master, operator | `{ run }`: the run's claim plus `task_title`, `worktree_path` (null once the worktree is gone) and `session` (the running `SessionTerminalView`, null when none); unknown id → `404 not_found` |
| `GET` | `/v1/events/stream?after=` | master, operator | NDJSON `{type:'event',seq,event}` / `{type:'heartbeat',cursor}` |
| `GET` | `/v1/runs/<run_id>/reviews` | own-run worker, master, operator | `{ reviews }`, latest per agent + reviewer label |
| `GET` | `/v1/memory/wake-up?wing=&budget=` | any session, operator | `{ initialized, text }`; `budget` 800 |
| `POST` | `/v1/stop-check` | worker session only | `{ allow, reason? }`; appends `turn_end` first |
| `POST` | `/v1/lifecycle` | worker session for that run | `{ op, agent_id, run_id?, ... }`; `op`: `run-start`, `run-fail`, `run-finish`, `run-work-complete`, `progress`, `review-submit`, `input-request`, `input-poll`, `input-timeout`, `memory-record`, `report-for-duty`. An offline session may still `input-poll` and repeat `run-finish` on a done run |
| `POST` | `/v1/operator` | master, operator | `{ op, actor_id?, ... }`; `op`: `cancel-task`, `reset-task`, `unblock-task`, `delegate-task`, `run-expire`, `run-close`, `task-mark-done`, `request-scout` (`{ objective, provider?, run_id?, task_ref?, scope_paths?, use_web? }` → `202 { agent_id }`; the launch continues in the background and the outcome is a `scout_launched` or `scout_launch_failed` event), `remove-scout` (`{ agent_id }` → `{ agent_id, removed }`), `respond-input` (`{ run_id, agent_id, response, request_id? }`; a `request_id` that is not the pending one → `409 conflict`). The master's `actor_id` is ignored |
| `POST` | `/v1/plans/import` | master, operator | import `{ files: [{ path, text }] }` → `{ imported: [{ path, plan_id, changed }] }`; atomic (an invalid plan changes nothing), ≤ 32 MiB; stores what `orc project plan import` stores |
| `GET` | `/v1/scouts/<agent_id>/report` | master, operator | `{ agent_id, status: running\|reported\|truncated\|ended, report, launched_at }`, as MCP `get_scout_report`; an unknown id gets `404`, a non-scout `400` |
| `POST` | `/v1/commands` | `running` session | **Experimental.** Enqueue `{ run_id, recipient_session_id, idempotency_key, kind, payload }` → `202 { command }`. Delivered to `app:` sessions by `CommandDispatcher` |
| `POST` | `/v1/commands/<id>/ack` | `running` session | **Experimental.** `{ state }`: `accepted\|running\|completed\|failed` → `{ command }` |
| `GET`, `POST` | `/v1/messages` | `running` session | **Experimental.** `GET`: mailbox `{ messages }` (`include_consumed=1`). `POST`: send `{ run_id, recipient_session_id \| recipient_agent_id, idempotency_key, kind, text }` (exactly one recipient, else `bad_request`; an agent resolves to its running session, else `conflict`) → `202 { message }`. Kinds: `message`, `question`, `review_request` (needs artifact refs), `feedback`, `result` (needs parent id) |
| `POST` | `/v1/messages/<id>/consume` | `running` session | **Experimental.** → `{ message }` |
| `POST` | `/v1/terminals/provider`, `/v1/terminals/shell` | master, operator | `{ run_id }` → `{ terminal }` (tmux provider view / worktree shell outside any sandbox); id `provider:<session_id>` / `shell:<session_id>` of the run's latest session; a run with no session gets `conflict`. A newer session retires the old id. `provider` takes `{ agent_id }` instead of `run_id` (exactly one, else `400`): the provider terminal of that agent's latest session when it is `running` (a worker, a scout or the master; a session with no run has `run_id: null` and `worktree_path: ''`); an unknown agent or one whose latest session is not running → `404 not_found`; a non-tmux session → `409 conflict`. Opening never resizes the pane |
| `GET` | `/v1/sessions` | master, operator | `{ sessions: [{ session_id, agent_id, run_id, provider, transport, state, state_reason, terminal_id, writer, capabilities }] }`, every session not `offline` (`running`, `recoverable`, `unknown`) with why it is in that state; `terminal_id` (`provider:<session_id>`, for run-less master and scout sessions too) is null when there is no live tmux terminal (`app:` sessions); `writer` is `{ owner_id, expires_at }` of the live input lease, or null; `capabilities` is the session's row of the [session capability table](./adapters.md#session-capabilities) |
| `GET` | `/v1/terminals/<id>/stream?columns=&rows=&lease_id=` | master, operator | NDJSON `{type:'snapshot',screen,cursor_x,cursor_y,columns,rows}` first, then `{type:'output',data}` (base64 pane bytes) and `{type:'heartbeat'}`, `{type:'exit',reason}` last; no reconnect, the viewer reopens. One `tmux -C` client per viewed terminal, shared by its viewers and stopped with the last. The size is applied for the `lease_id` holder, or the first viewer when no one holds the lease. A `provider:` id opens without a prior `POST`; a session with no terminal gets `not_found` |
| `POST` | `/v1/terminals/<id>/lease`, `/v1/terminals/<id>/input`, `/v1/terminals/<id>/resize` | master, operator (input/resize need the lease) | `{ action: 'acquire'\|'takeover', owner_id, ttl_ms? }` → `{ lease_id, expires_at }` (`ttl_ms` 1000–120000, default 30000; `acquire` on a live lease is `409 conflict` naming its owner; `takeover`, operator only, replaces it and the old holder gets `403`); `{ action: 'renew'\|'release', lease_id }`; renew and input extend the lease by its own `ttl_ms`. Input `{ lease_id, data }` (≤ 8192 chars) checks the lease in a short transaction, then sends it outside the transaction as one tmux command list (`tmux source-file -`), which a coordinator send never splits, and answers once sent; concurrent input requests may arrive out of order, so a caller sends one at a time per terminal (`ControlClient.inputTerminal` queues them per terminal: [terminal-streaming.md](terminal-streaming.md)). `{ lease_id, columns, rows }` resizes. A coordinator send never waits for the lease: it holds a `terminal_send` row in `control_leases` meanwhile, and operator input then gets a retryable `409 busy` |
| `GET` | `/v1/tasks?status=&fields=`, `/v1/tasks/<ref>`, `/v1/tasks/<ref>/revisions` | master, operator | tasks with `spec_revision`, `content_hash`, `body_markdown`; encode the ref (`app%2Flogin`). The list takes `status` (one task status) and `fields=summary`, which omits `body_markdown`; any other value → `400 bad_request`. Revisions omit their bodies |
| `POST` | `/v1/tasks`, `/v1/tasks/<ref>/revisions`, `/v1/tasks/import` | master, operator | create → `201`; edit needs `expected_revision` (stale → `409`; `status` → `400`); import `{ files: [{ path, text }], strict? }`, atomic, ≤ 32 MiB |

One row per method and full path; `lib/controlRoutes.test.ts` fails when a route the server matches is missing here, a listed method is not served, or an unlisted one (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`) is served. **Experimental** routes are outside the semver contract and may change in a minor release.

Status codes: no or wrong credential `401`; wrong principal (e.g. a worker on a master route, another run) `403`; missing task/agent `404`; bad input `400`; refused transition `409`; unexpected `500`.

---

## Session Handles

Format `<transport>:<agent_id>` (`tmux:broken-nose`, `tmux:master`, `app:…`). Every terminal session runs in tmux (≥ 3.2). A `pty:` handle left by an older orc is treated as offline: the coordinator clears it and requeues its run.

| Transport | Owner | Survives coordinator exit |
|-----------|-------|---------------------------|
| `tmux` | private tmux server `tmux -L orc-<hash>` | yes; writable by any orc process of the user |
| `app` | detached `codex app-server` on `<state>/app-server/<agent>.sock` | yes; the next coordinator adopts it after a PID + start-time check, else the run is resumed or requeued |

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

- Every session-row write appends exactly one event in the same transaction: `session_opened` on insert, `session_resumed` or `session_reconciled` where listed above, `reported_for_duty` when the session-start hook records the provider conversation id, `session_state_changed` otherwise (one per session a write supersedes or closes). Following events is enough to track every session's state. The one exception is the coordinator's per-tick owner-lease renewal, which changes no state.
- The session row answers whether a session is alive: agent reads report its state. A `running` agent whose latest session is `offline` reads as `offline` with no `session_token`; its `session_handle` stays, since cleanup still stops that terminal. A launch whose run vanished meanwhile (cancelled) records no row, stops the session it started and fails.
- Startup reconciles every non-offline session and records `session_reconciled` (`adopted`, `recoverable`, `unknown`, `exited`, `superseded`); it never kills one.
- `orc start-session` keeps runtime state by default, so a coordinator started after a crash adopts the live sessions. Only `--reset` (or the interactive "Start fresh (reset)") resets, and never while a master runs: it stops the coordinator and every non-master session first, then fails their runs (`session_reset`) and closes their rows. `orc kill-all --keep-sessions` keeps, under the state lock, the agent records, non-offline session rows, active runs and worktrees of agents with a session.
- The master is probed each tick. It is retired (offline, handle cleared, session closed so its secret stops authenticating, `master_retired` with the failed probe) only after 2 dead probes in a row; an indeterminate probe (tmux error or timeout) neither counts nor resets, and a failure within one tick interval of its `session_started_at` is not counted. Workers follow the same rule ([Lease and liveness](#lease-and-liveness)). `orc start-session` retires an attached master that ended only after 2 failed probes too.
- `orc start-session` repairs a master marked offline whose tmux pane still runs: it reopens the closed session whose pid/start match the live pane (`session_reconciled`, `outcome: restored`) and restores the agent record, so the master's secret authenticates again. No matching session: it starts a master as usual.
- Every direct write to a session (envelope, nudge, PR review) requires `running` and a matching pid/start; a mismatch moves it to `unknown`.
- A run whose session is `recoverable` or `unknown` gets no probe-based lease renewal; after 2 min in that state the master gets `worker_needs_attention {reason: session_not_running}`.
- Shutdown stops `app:` sessions and leaves tmux sessions for the next coordinator.
- `orc sessions` lists them; recovery: [recovery.md](./recovery.md#recoverable-or-unknown-sessions).

---

## Public surface (semver)

Everything in this section follows semver from 1.0: a breaking change needs a major release. Anything not listed (other modules under `dist/`, state file layout beyond the schemas) is internal, and anything marked **Experimental** may change in a minor release.

### Package exports

| Specifier | Resolves to | Why it is public |
|---|---|---|
| `orc-state` | `dist/index.js` + `dist/index.d.ts` | The library entry point (below) |
| `orc-state/client` | `dist/client.js` + `dist/client.d.ts` | The side-effect-free client entry for apps and TUIs (below) |
| `orc-state/schemas/<name>.json` | `dist/schemas/<name>.json` | JSON Schemas of the state files and events, for external validators |
| `orc` (bin) | `dist/cli/orc.js` | The CLI |

`package-contract.test.ts` fails when `exports` gains another entry or a path stops resolving.

### Root exports (`orc-state`)

| Export | Kind | Contract |
|---|---|---|
| `ControlClient` | class | Client for the control API (protocol v1), typed results per route (`status({ events? })` returns `StatusView`, `health()` returns `ControlHealth`; `events(after, limit, { runId?, agentId?, eventType? })`, `run(runId)`, `listTasks({ status?, fields?: 'summary' })` and `taskRevisions(ref)` serve the event filter, run detail, task list and revision routes; `importPlans(files)` and `scoutReport(agentId)` serve the plan and scout routes; `openTerminal(kind, runId)` and `openAgentTerminal(agentId)` serve `POST /v1/terminals/provider\|shell`; scouts are requested and removed with `operator({ op: 'request-scout' \| 'remove-scout', ... })`); `streamTerminal` and `subscribe` yield NDJSON frames. Every method takes `CallOptions` `{ signal?, timeoutMs? }` as its last argument (streams also accept a bare `AbortSignal`): abort rejects with `ControlError('aborted')` (a stream ends quietly instead), `timeoutMs` (0 = none) rejects with `ControlError('timeout')`. Defaults: the client's `timeoutMs` (10 s); `importTasks`/`importPlans` at least 5 min; a stream has no overall timeout, its `timeoutMs` bounds opening it (default `streamIdleMs`). `inputTerminal` calls to one terminal are sent one at a time in call order. A version refusal makes the client read `/v1/health` and fail with `unsupported_protocol_version` naming both sides' ranges |
| `ControlError` | class | `{ code: ControlErrorCode, status, message }` for every refused request |
| `CONTROL_PROTOCOL_VERSION` | const | `1` |
| `createAdapter`, `assertAdapterContract` | functions | Provider adapter factory + contract check |
| `validateAgents` | function | `agents.json` validator (an authoritative file; projections have no public validator) |
| `validateEventObject` | function | Event validator (`schemas/event.schema.json` + `lib/eventValidation.ts` rules) |
| `getWorkerBootstrap`, `getMasterBootstrap` | functions | Package bootstrap templates |
| `listProjects` | function | `listProjects({ env? })`: every registered project as `ProjectListEntry[]`, read from the registry under the data home. Opens `registry.db` read-only with `node:sqlite`: no DDL or migrations, and it never creates the data home or `registry.db` (SQLite may leave the WAL's `registry.db-shm`/`-wal` beside it); `[]` when there is no registry; throws `RegistrySchemaError` (exported from `orc-state/client`) for a newer registry schema |
| `ProjectListEntry` | type | `{ id, name, target_repo_root, state_dir, repo_present, control_socket, coordinator_running }`; `repo_present` is whether `target_repo_root` exists; `control_socket` is the `control.json` path only while a coordinator runs, `null` when none runs or the state directory or endpoint is missing or unreadable; `coordinator_running` is `true` when a live coordinator is found by its pid lock or `control.json` (the check `orc start-session` and `orc kill-all` use), independent of `control_socket` |
| `CallOptions` | type | `{ signal?, timeoutMs? }`, the last argument of every `ControlClient` method |
| `ControlClientOptions` | type | `{ credential?, timeoutMs?, streamIdleMs?, socketPath? }`; `timeoutMs` is the default per-request timeout (10 s); `socketPath` overrides the socket in `control.json` (the bearer token still comes from the state directory). The client never reads `ORC_CONTROL_SOCKET`; only the CLI passes it on for workers |
| `EventRow`, `OperatorResult`, `OperatorResults`, `OperatorOp`, `OperatorRequest` | types | Client options, event rows, `/v1/operator` request and per-`op` results |
| `ControlResponse`, `ControlErrorBody`, `ControlErrorCode`, `ControlEndpoint`, `StreamFrame`, `TerminalFrame`, `SessionTerminalView` | types | Protocol envelope, endpoint descriptor and frames |
| `ControlSnapshot`, `StatusView`, `ControlHealth`, `LifecycleRequest`, `LifecycleResult`, `SlotSummary`, `ScoutSummary`, `RunDetail`, `EventFilter`, `EventRow`, `OrcEvent`, `ProjectTaskView`, `ProjectTaskSummary`, `TaskRevisionSummary`, `TaskAuthoringInput`, `TaskImportResult`, `PlanImportResult`, `ScoutReportView`, `TaskMarkdownSource`, `ReviewSubmittedEvent`, `TerminalRecord` | types | Route bodies and results. `EventRow.event` is `OrcEvent \| null` (null: corrupt row); `OrcEvent` is the discriminated union of events. `StatusView` keeps `recentEvents` and `eventReadError` in camelCase (renaming would break consumers, and a duplicate snake_case copy would double the events payload); every other field is snake_case |
| `SubmitCommandRequest`, `AckState`, `DurableCommand`, `SemanticMessage`, `SendMessageInput` | types | **Experimental**, like the `/v1/commands…` and `/v1/messages…` routes they serve |

### Client exports (`orc-state/client`)

The root's client half, for an app (Electron main, a Node sidecar) or TUI: `ControlClient`, `ControlError`, `CONTROL_PROTOCOL_VERSION`, `listProjects`, every type in the rows above except the adapter ones, `RegistrySchemaError` and `ProjectWatcher`.

| Export | Kind | Contract |
|---|---|---|
| `RegistrySchemaError` | class | Thrown by `listProjects` when `registry.db` has a newer schema (`{ version, supportedVersion }`); other calls are unaffected |
| `ProjectWatcher` | class | `new ProjectWatcher(options?)`, `start()`, `stop(): Promise<void>` (closes every stream and timer), `projects(): ProjectWatchState[]`, `onUpdate(listener) → unsubscribe`. Watches every registered project with one `ControlClient` each; reconnects with bounded backoff from the last event cursor; re-reads the registry every `registryPollMs`. Behaviour: [embedding.md → Watching every project](embedding.md#watching-every-project) |
| `ProjectWatchState`, `ProjectWatchUpdate`, `ProjectConnectionState`, `ProjectWatcherOptions`, `ProjectWatchClient`, `WatcherTimers` | types | `ProjectWatchState` is `{ project: ProjectListEntry, connection, error, status: StatusView \| null, cursor }`; `ProjectConnectionState` is `connecting \| running \| stopped \| unreachable \| incompatible`; `ProjectWatchUpdate` is `added`, `removed`, `connection`, `status`, `event` (one `EventRow`) or `registry_error` (once per distinct registry read error, the watched set kept) |

Importing it has no side effects: no project resolution, registry access, git call, file write or environment check. Its module graph uses Node built-ins only (no `better-sqlite3`, `ajv`, `ink` or `react`; checked by `client.test.ts`). `listProjects` needs `node:sqlite` (Node ≥ 22.13; Node 24 prints an `ExperimentalWarning` on its first call).

**Embedding orc** ([embedding.md](embedding.md)): an app imports `orc-state/client`, calls `listProjects()`, and opens `new ControlClient(project.state_dir)` per project. Import the root `orc-state` only to run orc in process (adapters, validators, bootstrap templates): it resolves the active project on import and loads native modules.

### Control API protocol v1

| Element | Contract |
|---|---|
| Transport | HTTP/JSON over the Unix socket named in `control.json` (`protocol_version: 1`, `transport: "unix"`; the client checks only the transport and negotiates the version per request) |
| Version negotiation | Supported range `[1, 1]`. `GET /v1/health` answers without the protocol header and reports `protocol_versions: [min, max]`; other routes refuse a header outside the range with `unsupported_protocol_version` |
| Headers | `x-orc-protocol: 1`; `Authorization: Bearer <control.token>`; `x-orc-session` or `x-orc-operator` |
| Envelope | `{ protocol_version, ok: true, result }` / `{ protocol_version, ok: false, error: { code, message } }` |
| Error codes | `unsupported_protocol_version`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `bad_request`, `unavailable`, `internal`, `busy`; client-side only: `aborted`, `timeout` |
| Routes | The [Routes](#routes) table, except rows marked **Experimental** (`/v1/messages…`, `/v1/commands…`) |
| Event stream frames | `{ type: "event", seq, event }`, `{ type: "heartbeat", cursor }`, `{ type: "closed", reason }` (last frame when the daemon shuts down) |
| Terminal stream frames | `{ type: "snapshot", screen, cursor_x, cursor_y, columns, rows }`, `{ type: "output", data }`, `{ type: "resize", columns, rows }` (pane resized: repaint), `{ type: "heartbeat" }`, `{ type: "exit", reason }` (last frame; `reason: "backlog"` when the viewer was dropped for reading too slowly) |
| Forward compatibility | Clients ignore frame types and fields they do not know. Streams heartbeat about every 10 s; `ControlClient` fails a stream silent for 3 heartbeats (30 s) with `ControlError("unavailable")`, and maps a reset or cut stream to the same error. |

### Agent attention

`attention` in the status view (`orc status --json`, `GET /v1/status`, both from `buildStatus` in `lib/statusView.ts`) says what a worker's run needs from a human. It is `null`, or `{ kind, run_id, since, detail, request_id }`, derived from current state on every read (claims, `run-activity.json`, the run's events), never stored. When several conditions hold, the first kind below wins (`ATTENTION_PRECEDENCE`):

| `kind` | When | `since` | `detail` | Clears when |
|---|---|---|---|---|
| `permission_prompt` | waiting for input the coordinator recorded for a provider permission or interactive prompt (`input_requested` with `actor_type: coordinator`) and the worker shows no hook activity after it | the request | prompt text | the worker acts again (hook activity after the request) or the input is answered |
| `question` | waiting for an answer to the worker's `run-input-request` | the request | question text; `request_id` set | `run-input-respond` / `respond_input` |
| `stalled` | the run's `stalled` flag (`isStalled`, the same test as `claims.stalled`) | the run's idle anchor (last activity) | `null` | any activity |
| `no_progress` | the coordinator sent `worker_needs_attention {reason: no_progress}` and the run has not progressed since its `progress_at` (a change of phase at its evidence time, a progress lifecycle event, or a hook-seen `git commit`, kept as `last_commit_ts` in `run-activity.json`); not while waiting for input or finalizing | `progress_at` | the phase in the alert | progress |

A run that ends drops out of `claims.active`, so its attention goes with it. `request_id` is null except for `question`. MCP `get_status` builds its own shape and does not carry `attention` yet; read it from `orc status --json` or `/v1/status`. The `orc watch` NEEDS INPUT badge still reads `waiting_input`.

### CLI commands

| Group | Commands |
|---|---|
| Session and setup | `start-session`, `init`, `install`, `install-agents`, `install-skills`, `project`, `mcp-server` |
| Inspection | `status`, `watch`, `attach`, `doctor`, `preflight`, `runs`, `run-info`, `sessions`, `events`, `event-cursor`, `worker-status`, `terminal`, `memory-status`, `memory-search` |
| Master / operator | `delegate`, `task-mark-done`, `task-reset`, `task-unblock`, `task-cancel`, `run-expire`, `run-close`, `run-input-respond`, `worker-remove`, `worker-gc`, `kill-all`, `pr-diff`, `pr-review`, `pr-merge`, `pr-status` |
| Worker lifecycle (flags below) | `report-for-duty`, `run-start`, `progress`, `review-submit`, `review-read`, `run-work-complete`, `run-finish`, `run-fail`, `run-input-request`, `memory-wake-up`, `memory-record` |
| Hooks and debug | `stop-check` (Claude Stop hook), `control` (debug; its `command`, `ack`, `message`, `messages` and `consume` subcommands are **Experimental**, like the routes they call), `run-heartbeat` (deprecated no-op) |

Flags are those in `cli/usage.ts` (`orc <command> --help`); `--project=<id>` selects a project for any command.

### CLI `--json` output

| Command | Shape |
|---|---|
| `orc project list --json` | `listProjects()`: `[{ id, name, target_repo_root, state_dir, repo_present, control_socket, coordinator_running }]` (without `--json`, the registry records) |
| `orc status --json [--events=<0-200>]` | `{ cursor, project, agents, master, worker_capacity, scouts, tasks, claims, finalization, failures, waiting_input, recentEvents, eventReadError, coordinator }`; `claims.waiting_input` counts the `waiting_input` rows; each `claims.active[]` run and each `worker_capacity.slots[]` slot (from its active run; `null` without one) carries `attention` (see [Agent attention](#agent-attention)); `coordinator` is `{ running, pid, version, started_at, stale }`, added by the CLI and absent from `/v1/status` (MCP `get_status` carries the same, with a `waiting_input` count); `--events` sets the `recentEvents` length (default 20, `0` → `[]`) |
| `orc status --mine --json` | `{ agent, assigned_tasks, queued_tasks }` |
| `orc doctor --json` | `{ ok, registered_workers, active_claims, checks }`; exit 1 when not `ok`. `checks.coordinatorCode.warning` is a restart hint (string) when the running coordinator's code is older than the code on disk, else `null`; it never changes `ok` or the exit code |
| `orc preflight --json` | `{ ok, project, checks, warnings, details }`; exit 1 when not `ok` |
| `orc runs --json` | `{ runs }` (same as MCP `list_runs`); rows `{ run_id, task_ref, agent_id, state, phase, age_seconds, idle_seconds, stalled }`, plus `question`, `request_id`, `waiting_seconds` on a run waiting for input |
| `orc run-info <run_id> --json` | the run's claim fields + `task_title`, `worktree_path`, `task_spec_revision_status` |
| `orc sessions --json` | `{ total, sessions }`; each session carries `capabilities` ([adapters.md](./adapters.md#session-capabilities)) |
| `orc events --json` | `{ events, last_seq, has_more }` (same as MCP `query_events`) |
| `orc review-read --json` | `{ count, reviews }` |
| `orc worker-status --json` | array of agent records + `active_task_ref`, `heartbeat_seconds_ago`; one record when given an `agent_id` |

#### Operator commands

With `--json`, `task-cancel`, `task-reset`, `task-unblock`, `task-mark-done`, `delegate`, `run-close`, `run-expire` and `run-input-respond` print the `/v1/operator` result for their op (the same object the MCP tool returns). A refused request prints `{ "error": { "code", "message" } }` on stdout. Exit codes: 0 success, 1 failure, **75** a retryable failure (`code` is `unavailable` or `busy`: the coordinator holds the project but is not answering, or is sending to the terminal). `task-cancel` of an already-terminal task is `conflict`. Codes are the control API's `ControlErrorCode`, plus the client-side `timeout` (exit 1, never retried: the coordinator may already have applied the request); the direct (no-coordinator) path maps `NotFoundError`, `ConflictError` and `InputError` to `not_found`, `conflict` and `bad_request`.

| Command | `--json` success shape |
|---|---|
| `orc worker-remove <id> --json` | `{ worker_id, removed: true, session_stopped }`; refusals are `not_found` (unknown worker) or `conflict` (master, scout, active claim) |
| `orc worker-gc --json` | `{ removed_workers, removed_hook_files }` |
| `orc kill-all --json` | `{ coordinator: 'stopped'\|'already_stopped'\|'not_running'\|'signal_failed', coordinator_pid, sessions_stopped, agents_cleared, agents_kept, tasks_reset, claims_cancelled, runs_kept, worktrees_removed }` |
| `orc coordinator start\|stop\|restart\|status --json` (MCP `restart_coordinator` returns the `restart` shape) | `{ action, changed, running, pid, version, socket, started_at, stale }`, plus `previous_pid` for `restart` (the stopped coordinator's pid, `null` when none ran). `pid` is `null` when not running; `version`, `started_at` and `stale` (a restart hint, as `checks.coordinatorCode.warning`) come from the coordinator's `/v1/health` and are `null` when it does not answer; `socket` is the control socket path; `changed` is true when `start` started it, `stop` stopped it, or `restart` ran. `start`, `stop` and `restart` exit 75 (`unavailable`) when the coordinator does not appear or stop within 2 s; `stop` and `restart` exit 1 (`conflict`) when `coordinator.pid` records no `started_at`. `stop` and `restart` never change tasks, claims, agents or worktrees |

#### `orc project …` output

`orc project …` always prints JSON on stdout (no `--json` flag, except `project list`, whose plain form is the registry records) and reports failures as `Error` text on stderr with exit 1. Documented shapes: `task list` → rows from the task store; `task show <ref>` → a task (`describeProjectTask`: the backlog task fields + `feature_ref`, `content_hash`, `body_markdown`), or with `--revision=<n>` that revision; `task create` → the same task view; `task edit` → the task view + `changed`; `task import <path>` → `{ imported: [{ path, ref, action: 'created'\|'revised'\|'unchanged', revision, ignored_fields }], skipped }`; `plan import <path>` → `{ plan_id, changed }`; `config get` → `{ key, value }`; `config set` → `{ key, value, scope }`; `config unset` → `{ key, scope, unset: true }`. **Unstable** (may change in a minor release): `task list` row fields, `task revisions`, `plan list`/`show`/`export`, `config list`, `project add`/`select`/`show`.

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
| Reads | `list_tasks`, `get_task`, `list_agents`, `list_runs`, `get_run`, `get_status`, `get_agent_workview`, `query_events`, `list_worktrees`, `doctor` (the `orc doctor` checks as `{ ok, checks: [{ name, ok, detail }] }`), `terminal_snapshot` (`{ run_id, lines, screen }`: the last `lines` lines, default 40, max 200, of a run's tmux provider terminal, ANSI stripped, as `orc terminal provider --once`; never takes the input lease; needs the coordinator) |
| Task authoring and control | `create_task`, `update_task`, `delegate_task`, `cancel_task`, `reset_task`, `unblock_task`, `close_run`, `respond_input` |
| Coordinator | `restart_coordinator` (master secret; checked against the state, not sent to the coordinator it replaces) |
| Scouts | `request_scout`, `get_scout_report`, `remove_scout` |
| Memory | `memory_wake_up`, `memory_search` (browses `wing`/`room` without `query`), `memory_store`, `memory_status` |

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
6. **Finalization graph**: `setRunFinalizationState` only allows these moves (`FINALIZATION_TRANSITIONS` in `lib/claimStateManager.ts`); any other throws, and a write of the current state (retry bump) is always legal. It is not strictly forward-only: a failed merge or rebase loops back.
   - `null → awaiting_finalize`
   - `awaiting_finalize → finalize_rebase_requested | pr_created | blocked_finalize | pr_failed`
   - `finalize_rebase_requested → finalize_rebase_in_progress | blocked_finalize | pr_failed`
   - `finalize_rebase_in_progress → ready_to_merge | finalize_rebase_requested | blocked_finalize | pr_failed`
   - `ready_to_merge → finalize_rebase_requested` (merge failure) `| blocked_finalize | pr_failed`
   - `pr_created → pr_review_in_progress | finalize_rebase_requested | blocked_finalize | pr_failed`
   - `pr_review_in_progress → pr_merged | finalize_rebase_requested | blocked_finalize | pr_failed`
   - `blocked_finalize`, `pr_merged`, `pr_failed` are terminal; a terminal run event or operator recovery resets the field to null outside this function.
7. **Event compliance**: events satisfy `schemas/event.schema.json` and `lib/eventValidation.ts`; `seq` strictly increases.
8. **Lease enforcement**: no expired claim stays `claimed`/`in_progress` outside the finalize window.
9. **Write exclusivity**: state changes only through `orc` commands, MCP tools or the coordinator; one coordinator owns a project's writes at a time.
