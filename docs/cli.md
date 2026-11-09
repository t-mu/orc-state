# CLI reference

`orc <subcommand> [args...]`. `orc --help` lists every subcommand.

## Global options

- `--project=<id>` (or `--project <id>`) selects a registered project for any subcommand, before or after it (not after `--`). Highest precedence; an unknown id is an error; an inherited `ORC_STATE_DIR` is ignored. See [configuration.md → Project selection](configuration.md#project-selection).
- `orc <subcommand> --help` (or `-h`) prints that subcommand's usage line and never runs it.
- Commands that show state print the project they act on.
- Output is for people or for scripts, decided by stdout. On a terminal, `--json` is indented and the `status`/`watch` banner is shown (by `watch` only when it fits). When stdout is piped or captured, `--json` is one compact line and the banner is omitted. The JSON shape is the same either way. A `--json` result is never cut short when piped.
- Argument parsing is strict for the commands that read project state (`status`, `runs`, `run-info`, `review-read`, `worker-status`, `sessions`, `events`) and for `task-cancel`, `task-reset` and `worker-remove`: `--x=v` and `--x v` both work, an unknown flag or surplus argument is a usage error (exit 1), and a flag's value is never taken as the positional target.
- Project-scoped read commands exit 1 with the no-project message when no project resolves, instead of returning empty results.

## Session management

| Command | Flags | Notes |
|---------|-------|-------|
| `init` | `[--provider=claude,codex,gemini]` `[--worker-provider=<name>]` | Needs a registered project (`orc project add`). Records `default_provider`, `worker_pool.provider`, and `worker_pool.max_workers` (when unset) in the registry; writes nothing into the repository. `--provider` is required outside a TTY. Refuses `--force`. |
| `start-session` | `[--provider=claude\|codex\|gemini]` `[--agent-id=<id>]` `[--reset]` `[--restart-stale]` | Starts the coordinator (background) and the master in orc's tmux server (needs tmux), then attaches to it. A live master is reattached instead of starting another. `Ctrl-b d` or closing the terminal detaches and the master keeps running. A dead Claude master resumes its recorded conversation. Without a TTY it starts the master and does not attach. Wires the orchestrator MCP server into the master. Runtime state is kept: the new coordinator adopts live worker sessions (crash recovery). `--reset` (interactive: "Start fresh (reset)") stops the running coordinator and every worker session, then fails their runs (`session_reset`) and requeues the tasks; it refuses while a master runs or the coordinator cannot be stopped. A running coordinator whose `version` or `build_id` differs from the code on disk, or that reports no build id at all while the disk has one (started before health carried it), triggers a warning; `--restart-stale` then restarts it (state is kept). |
| `coordinator <start\|stop\|restart\|status>` | `[--json]` | Runs only the coordinator: no master, provider auth or tmux master check. `start` is a no-op when one runs; `stop` ends it and leaves tasks, claims, agents and worktrees alone (`kill-all` resets them); `restart` stops it and starts a new one (e.g. after `npm run build`), keeping the same state, reports `previous_pid` and the new `pid`, and with none running just starts one (MCP: `restart_coordinator`); `status` reports `pid`, `version`, `socket`. Shapes: [contracts.md → CLI `--json` output](contracts.md#cli---json-output). |
| `kill-all` | `[--keep-sessions]` `[--json]` | Full reset: stops the coordinator, terminates sessions, clears the agent registry, resets active tasks, removes run worktrees. `--keep-sessions` leaves every agent session running and adoptable: its agent record, session row, active run and worktree are kept for the next `start-session`. |

```bash
orc init --provider=claude,codex
orc start-session --provider=claude
```

## Projects

| Command | Notes |
|---------|-------|
| `project add <git-path> [--name=N]` | Register a repository; creates its state directory and task store. |
| `project list` | List registered projects; `--json` adds `repo_present`, the control socket (only while the coordinator runs) and coordinator liveness. |
| `project select <id>` | Default project outside every Git repository. |
| `project show` | Print the resolved project. |
| `project config <list\|get\|set\|unset> [key] [value] [--global]` | Read/write settings. `list` shows effective values; `--global` targets global settings (not combinable with `--project`). Keys: [configuration.md → Settings](configuration.md#settings). |
| `project task list [--status=<s>[,<s>]] [--feature=<f>]` | List tasks (ref, title, status, revision). With no flag every task is listed, including done ones. `--status` takes the runtime statuses (`todo`, `claimed`, `in_progress`, `done`, `blocked`, `cancelled`), repeatable or comma-separated, written as `--status=<s>` (a space-separated value is a usage error); an unknown status is a usage error. `--feature` matches the task's feature ref. |
| `project task show <ref> [--revision=<n>]` | Show a task or one revision. |
| `project task revisions <ref>` | List revisions. |
| `project task create [fields]` | Create a task. |
| `project task edit <ref> --expected-revision=<n> [fields]` | New revision; a stale `--expected-revision` fails. `feature`, `ref`, `owner` are not editable. |
| `project task import <file-or-dir> [--strict]` | Import Markdown specs; `--strict` rejects lifecycle fields. |
| `project task export <dir-or-file.md> [--ref=a,b]` | Export Markdown. |
| `project plan <list\|show <id>\|import <path>\|export <id> <path>>` | Store and render plans. |

- Task fields: `--title`, `--feature`, `--ref`, `--priority`, `--description`, `--task-type`, `--required-provider`, `--model`, `--review-level`, `--merge-strategy`, `--owner`, `--body-file=<path>`, `--depends-on=a,b`, `--ac=<criterion>` (comma list or repeated).
- `task create|edit|import` accept `--actor-id=<id>`; all `project` subcommands except `add`, `list`, `select` accept `--project=<id>`.
- Import/export semantics: [configuration.md → Project tasks](configuration.md#project-tasks).

## Monitoring

| Command | Flags | Notes |
|---------|-------|-------|
| `status` | `[--json [--events=<0-200>]]` `[--mine --agent-id=<id>]` `[--watch\|-w [--interval-ms=<ms>] [--once]]` | Agents, tasks, claims, capacity. The project line says how the project was selected; `--json` carries it as `project.selected_by` (`flag`, `env`, `cwd`, `selected`; see [configuration.md → Project selection](configuration.md#project-selection)). With `--json`, `--once`/`--watch` print one compact JSON document per line (NDJSON); screen-clear codes are written only to a TTY. |
| `watch` | `[--interval-ms=<ms>]` `[--once]` | Live TUI; plain refresh without a TTY. The TUI fits its output to the terminal height (re-fitted on resize): it drops the sprites, then collapses phases, then the banner (also hidden when the terminal is narrower than it), and cuts the run, event and scout lists with a `+N more` line. |
| `doctor` | `[--json]` `[--stale-progress-ms=<ms>]` `[--stale-start-ms=<ms>]` | Full health check: state files, provider binaries, stale workers, orphaned claims, invariants, sandbox deps, memory store, `events.db` schema (`checks.runtimeSchema`), whether the running coordinator's schema support covers `events.db` and `runtime.db` (`checks.coordinatorSchema`; fails `doctor`, see [recovery.md](./recovery.md#runtime-database-upgrade-and-restore)), and a restart warning when the running coordinator's code is older than the code on disk (`checks.coordinatorCode`; never fails `doctor`). Stale thresholds default to 20 min / 5 min. MCP `doctor` runs the same checks (`lib/doctor.ts`) and returns `{ ok, checks: [{ name, ok, detail }] }`. |
| `preflight` | `[--json]` | Fast environment check before `start-session`. |

When a live run (claimed or in progress) waits for an input response, `status` and the plain `watch` print a `Waiting for input (N)` section under the title: agent, task, wait time, the question (truncated) and how to answer (`orc run-input-respond …` or ask master). The section is left out when nothing waits. The `watch` TUI adds a yellow `N WAITING FOR INPUT` header line with the same answer hint, and a `NEEDS INPUT` badge, wait time and question on the worker's slot. Finished claims that still carry `awaiting_input` (legacy runs) are not listed here, by `orc runs --state=waiting-input` or by MCP `list_runs`. `status --json` counts the waiting runs in `claims.waiting_input` and adds `coordinator` (`{ running, pid, version, started_at, stale }`, as MCP `get_status`).

Under each active run, `watch` and `status` print a `└` activity line: a note younger than 5 min, else the current to-do item, else the last tool call; dimmed after 2 min. MCP `get_status` / `get_agent_workview` return it as `current_activity`.

## Setup

| Command | Flags |
|---------|-------|
| `install` | `[--provider=claude,codex,gemini]` `[--global]` `[--dry-run]` `[--skip-skills]` `[--skip-agents]` |
| `install-skills` | `[--provider=claude,codex,gemini]` `[--global]` `[--dry-run]` |
| `install-agents` | `[--provider=claude,codex,gemini]` `[--global]` `[--dry-run]` |

`install` installs skills and agents (default providers: the project's settings) and writes no MCP config. `orc init` does not run it.

## Worker management (recovery/debug)

| Command | Flags | Notes |
|---------|-------|-------|
| `attach <agent_id\|run_id>` | `[--write]` | Real `tmux attach-session` on orc's private tmux server. Read-only by default; `--write` sends input; Ctrl-b d detaches. Needs a TTY; refuses non-tmux (`app:`) sessions. |
| `terminal <provider\|shell> <run_id>` | `[--write [--takeover]]` `[--once]` | `provider`: the run's provider terminal; `shell`: a shell in the run worktree (survives detach; output in `<state>/terminal-logs/`). Streams live output (`GET /v1/terminals/<id>/stream`); sizes the pane to this terminal when it holds the lease or is the first viewer. Read-only by default; `--write` takes the exclusive input lease (`--write --takeover` takes it from its current holder; operator only); `--once` prints the current screen and exits (MCP `terminal_snapshot` reads the same screen, ANSI stripped). Ctrl-] detaches a writer, Ctrl-C an observer. Needs the coordinator and tmux; run from the master or an operator shell, never a worker. |
| `worker-status [<agent_id>]` | `[--json]` | Worker state, active task, session. |
| `worker-remove <worker_id>` | `[--keep-session]` `[--json]` | Refused while the worker holds a claim, and for the master or a scout. |
| `worker-gc` | `[--json]` | Remove offline/dead workers without a claim (not master/scouts) and `pty-hook-events/` files of unregistered agents. A running coordinator does this itself. |
| `sessions` | `[--all]` `[--json]` | Supervised sessions: state (`running`, `recoverable`, `unknown`, `offline`), transport, PID, owner, reason. |

## Task management

| Command | Flags | Notes |
|---------|-------|-------|
| `delegate` | `--task-ref=<feature/task>` `[--target-agent-id=<id>]` `[--task-type=implementation\|refactor]` `[--note=<text>]` `[--actor-id=<id>]` `[--json]` | Force dispatch (normal dispatch is automatic). Refuses a target with an active run. |
| `task-reset <task_ref>` | `[--actor-id=<id>]` `[--json]` | Any status → `todo`; cancels active claims (`run_cancelled` per run), clears requeue backoff. |
| `task-unblock <task_ref>` | `[--reason=<text>]` `[--actor-id=<id>]` `[--json]` | `blocked` → `todo`. |
| `task-cancel <task_ref>` | `[--reason=<text>]` `[--actor-id=<id>]` `[--json]` | → `cancelled`, ends any active run. Exits 1 if already done/cancelled. |
| `task-mark-done <task_ref>` | `[--actor-id=<id>]` `[--json]` | Recovery: mark done in runtime state (the coordinator does this after merge). |
| `run-expire <run_id>` | `[--json]` | Force-expire a claim and requeue the task. |
| `run-close <run_id>` | `[--reason=<text>]` `[--actor-id=<id>]` `[--json]` | Close a run merged by hand (see below). MCP: `close_run`. |

`run-close` requires a non-terminal claim whose task is `done` or whose branch is merged into `main` (an ancestor of `main`, not on its first-parent history). It records the claim `done`, emits `run_finished {closed_by, reason, manual: true}`, and for a merged branch marks the task `done` and removes the worktree and branch. For squash/rebase/fast-forward merges run `task-mark-done` first; otherwise use `run-expire` or `task-reset`.

With `--json`, the operator commands above (and `run-input-respond`, `worker-remove`, `worker-gc`, `kill-all`) print one JSON document on stdout. Failure prints `{ "error": { "code", "message" } }` on stdout instead and exits 1, or 75 when `code` is `unavailable` or `busy` (retry). Without `--json`, output and exit codes are unchanged. Codes are the control API's: `not_found`, `conflict`, `bad_request`, `forbidden`, `unauthenticated`, `unavailable`, `busy`, `internal`, plus the client-side `timeout` (exit 1, not retried: the coordinator may already have applied the request).

Authorization (canonical: [contracts.md → Local Control API](contracts.md#local-control-api)):

- The commands above, `run-input-respond` and `project task create|edit|import` are applied by the running coordinator over its control API, as the operator.
- No coordinator: applied directly with `coordinator is not running; applying <op> directly`. Coordinator alive but API not answering: retryable error.
- A shell inside a worker session (`ORC_SESSION_SECRET`) is refused.
- `--actor-id` must be `human` or a registered agent; default is the caller (`human` for the operator); ignored with the master's session.

## Plans

Plan Markdown format: [plan-template.md](plan-template.md).

## Inspection

| Command | Flags | Notes |
|---------|-------|-------|
| `runs` | `[--state=active\|stalled\|waiting-input]` `[--stale-after-ms=<ms>]` `[--json]` `[--via-control]` | Live runs (claimed or in progress), same handler and JSON as MCP `list_runs`: `{ runs }`, each row `run_id`, `task_ref`, `agent_id`, `state`, `phase`, `age_seconds`, `idle_seconds`, `stalled`, plus `question`, `request_id`, `waiting_seconds` on a run waiting for input. `active` (default) lists every live run; `stalled` those idle for `--stale-after-ms` (default 600000) with no input wait and no tool call running; `waiting-input` those waiting for an input response. `--via-control` reads them from the coordinator's control API. |
| `run-info <run_id>` | `[--json]` | Claim state, task, worktree, idle time. |
| `events` | `[--run-id=<id>]` `[--agent-id=<id>]` `[--task-ref=<ref>]` `[--event=<type>]` `[--notifications]` `[--after=<seq>]` `[--limit=<1-100>]` `[--fts=<query>]` `[--verbose]` `[--json]` `[--follow [--max-events=<n>]]` | One page of events, same handler and JSON as MCP `query_events`: `{ events, last_seq, has_more }`. Without `--after`, the newest `--limit` (default 25) matching events; with it, the oldest events after that `seq` (pass `last_seq` back to page on). `--notifications` keeps the notification class. Events are compact (no `event_id`, `actor_type`, `actor_id`; `input_response` without its `question`) unless `--verbose`. `--follow` prints the first page, then each new matching event as it arrives (one JSON line each with `--json`), stopping after `--max-events` when given. |
| `event-cursor` | `[--consumer=<id>]` `[--reset-to=<seq>]` | Show a consumer offset; reset replays events after `<seq>` (coordinator must be stopped). |

### `orc control`

Client for the coordinator's local control API. Fails with "Control daemon is not running" when the coordinator is down.

| Subcommand | Flags |
|------------|-------|
| `snapshot` | — |
| `events` | `[--after=<seq>]` `[--limit=<n>]` `[--follow]` `[--max-events=<n>]` |
| `command` | `--run-id=<id>` `--recipient-session=<id>` `--kind=<kind>` `--idempotency-key=<key>` `[--payload=<json>]` `[--credential=<secret>]` |
| `ack <command_id>` | `--state=<accepted\|running\|completed\|failed>` `[--credential=<secret>]` |
| `message` | `--run-id=<id>` `--recipient-session=<id>` \| `--recipient-agent=<id>` (exactly one) `--kind=<message\|question\|review_request\|feedback\|result>` `--text=<text>` `--idempotency-key=<key>` `[--artifact-ref=<ref>]` `[--parent-message=<id>]` |
| `messages` | `[--include-consumed]` |
| `consume <message_id>` | — |

- Mutations authenticate with `ORC_MASTER_SECRET` or `ORC_SESSION_SECRET`; `--credential=<secret>` overrides (`--session-token` is an alias).
- `snapshot`, `events` and `runs --via-control` read the whole project: master and operator only; a worker session gets `403`.

## Memory

| Command | Flags | Notes |
|---------|-------|-------|
| `memory-status` | — | Drawer count, wings, rooms, DB size. |
| `memory-search <query>` | `[--wing=X]` `[--room=Y]` | Full-text search. |
| `memory-wake-up` | `[--wing=X]` `[--budget=N]` | Recall essential memories (agent use). |
| `memory-record` | `--content=<text>` `[--wing=X]` `[--hall=Y]` `[--room=Z]` `[--importance=N]` | Store a memory (agent use). |

## Run lifecycle (worker use)

- Sent to the coordinator over `ORC_CONTROL_SOCKET` with the session's `ORC_SESSION_SECRET`; the coordinator applies them to that session's own run.
- Refused outside a worker session, except `memory-record` (an operator shell writes directly).
- While the coordinator is unreachable they retry for `ORC_CONTROL_RETRY_MS` (2 min).
- To stop a run from outside: `orc task-reset <ref>` or the master's `reset_task`/`cancel_task`.

| Command | Flags | Notes |
|---------|-------|-------|
| `report-for-duty` | `--agent-id=<id>` `--session-id=<id>` | Session ready after bootstrap, for providers without a session-start hook (Codex, Gemini); a Claude session reports ready through its hook. Accepted from any provider (`--session-token` is an alias of `--session-id`). |
| `run-start` | `--run-id=<id>` `--agent-id=<id>` | Claim → `in_progress`. |
| `progress` | `--event=<type>` `--run-id=<id>` `--agent-id=<id>` `[--phase=<name>]` `[--reason=<text>]` `[--note=<text>]` `[--policy=<requeue\|block>]` | Events: see below. `--note` is the activity line shown by `watch` (send with `--event=heartbeat`). |
| `run-work-complete` | `--run-id=<id>` `--agent-id=<id>` | Implementation, review, rebase done. |
| `run-finish` | `--run-id=<id>` `--agent-id=<id>` | Terminal success. |
| `run-fail` | `--run-id=<id>` `--agent-id=<id>` `[--reason=<text>]` `[--code=<code>]` `[--policy=<requeue\|block>]` | Terminal failure; default `requeue`. |
| `run-input-request` | `--run-id=<id>` `--agent-id=<id>` `--question=<text>` `[--timeout-ms=<ms>]` `[--poll-ms=<ms>]` | Blocking question to the master. |
| `run-input-respond` | `--run-id=<id>` `--agent-id=<id>` `--response=<text>` `[--actor-id=<id>]` `[--request-id=<id>]` `[--json]` | Answer a pending input request, as master or operator; `--request-id` targets one request (a stale id → conflict). |
| `run-heartbeat` | — | Deprecated no-op; leases renew automatically. |

`progress --event` values (`lib/progressValidation.ts`): `run_started`, `heartbeat`, `phase_started`, `phase_finished` (need `--phase`), `review_submitted`, `work_complete`, `finalize_rebase_started`, `ready_to_merge`, `run_finished`, `run_failed`, `blocked`, `need_input` (need `--reason`), `input_provided`, `unblocked`.

## Review (sub-agent reviewers)

| Command | Flags | Notes |
|---------|-------|-------|
| `review-submit` | `--run-id=<id>` `--agent-id=<worker_id>` `--outcome=<approved\|findings>` `--reason=<text>` `[--reviewer=<label>]` | `--agent-id` is the **worker's** id; `--reviewer` labels the reviewer (`critic`, `integrator`, `reviewer`). |
| `review-read` | `--run-id=<id>` `[--json]` | One review per agent + label (latest wins): `Review from <agent> (<label>) [outcome]`. Exits 0 whatever the outcome; 1 only when reviews cannot be read (retry). |

## Pull requests (PR reviewer workers)

Require `coordinator.pr_provider` (`orc project config set coordinator.pr_provider github`).

| Command | Notes |
|---------|-------|
| `pr-diff <pr_ref>` | Print the diff. |
| `pr-review <pr_ref> --approve\|--request-changes --body=<text>` | Submit a review. |
| `pr-merge <pr_ref>` | Merge. |
| `pr-status <pr_ref> [--wait]` | PR and CI state; `--wait` blocks until CI resolves, prints `passing`/`failing`. |

## Internal

| Command | Notes |
|---------|-------|
| `mcp-server` | stdio MCP server; started by `start-session`. |
| `stop-check` | Claude task workers' `Stop` hook (reads hook JSON on stdin). Blocks the turn end while the run is unfinished (no `run-work-complete`, no pending input, not finalizing, and `TASK_START` already sent; a stop before it is allowed): max 3 blocks per 10 min, 9 per run, each a `stop_blocked` event. Also closes unfinished tool calls. Always exits 0; fails open. |
