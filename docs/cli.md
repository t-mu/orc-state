# CLI reference

`orc <subcommand> [args...]`. `orc --help` lists every subcommand.

## Global options

- `--project=<id>` (or `--project <id>`) selects a registered project for any subcommand, before or after it (not after `--`). Highest precedence; an unknown id is an error; an inherited `ORC_STATE_DIR` is ignored. See [configuration.md → Project selection](configuration.md#project-selection).
- `orc <subcommand> --help` (or `-h`) prints that subcommand's usage line and never runs it.
- Commands that show state print the project they act on.

## Session management

| Command | Flags | Notes |
|---------|-------|-------|
| `init` | `[--provider=claude,codex,gemini]` `[--worker-provider=<name>]` | Needs a registered project (`orc project add`). Records `default_provider`, `worker_pool.provider`, and `worker_pool.max_workers` (when unset) in the registry; writes nothing into the repository. `--provider` is required outside a TTY. Refuses `--force`. |
| `start-session` | `[--provider=claude\|codex\|gemini]` `[--agent-id=<id>]` | Starts the coordinator (background) and the master in orc's tmux server (needs tmux), then attaches to it. A live master is reattached instead of starting another. `Ctrl-b d` or closing the terminal detaches and the master keeps running. A dead Claude master resumes its recorded conversation. Without a TTY it starts the master and does not attach. Wires the orchestrator MCP server into the master. |
| `kill-all` | `[--keep-sessions]` | Full reset: stops the coordinator, terminates sessions (unless `--keep-sessions`), clears the agent registry, resets active tasks, removes run worktrees. |

```bash
orc init --provider=claude,codex
orc start-session --provider=claude
```

## Projects

| Command | Notes |
|---------|-------|
| `project add <git-path> [--name=N]` | Register a repository; creates its state directory and task store. |
| `project list` | List registered projects; `--json` adds each control socket and coordinator liveness. |
| `project select <id>` | Default project outside every Git repository. |
| `project show` | Print the resolved project. |
| `project config <list\|get\|set\|unset> [key] [value] [--global]` | Read/write settings. `list` shows effective values; `--global` targets global settings (not combinable with `--project`). Keys: [configuration.md → Settings](configuration.md#settings). |
| `project task list` | List tasks (ref, title, status, revision). |
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
| `status` | `[--json [--events=<0-200>]]` `[--mine --agent-id=<id>]` `[--watch\|-w [--interval-ms=<ms>] [--once]]` | Agents, tasks, claims, capacity. |
| `watch` | `[--interval-ms=<ms>]` `[--once]` | Live TUI; plain refresh without a TTY. |
| `doctor` | `[--json]` `[--stale-progress-ms=<ms>]` `[--stale-start-ms=<ms>]` | Full health check: state files, provider binaries, stale workers, orphaned claims, invariants, sandbox deps, memory store, `events.db` schema (`checks.runtimeSchema`), and a restart warning when the running coordinator's code is older than the code on disk (`checks.coordinatorCode`; never fails `doctor`). Stale thresholds default to 20 min / 5 min. |
| `preflight` | `[--json]` | Fast environment check before `start-session`. |

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
| `terminal <provider\|shell> <run_id>` | `[--write]` `[--once]` | `provider`: the run's provider terminal; `shell`: a shell in the run worktree (survives detach; output in `<state>/terminal-logs/`). Streams live output (`GET /v1/terminals/<id>/stream`); sizes the pane to this terminal when it holds the lease or is the first viewer. Read-only by default; `--write` takes the exclusive input lease; `--once` prints the current screen and exits. Ctrl-] detaches a writer, Ctrl-C an observer. Needs the coordinator and tmux; run from the master or an operator shell, never a worker. |
| `worker-status [<agent_id>]` | `[--json]` | Worker state, active task, session. |
| `worker-remove <worker_id>` | `[--keep-session]` | Refused while the worker holds a claim, and for the master or a scout. |
| `worker-gc` | — | Remove offline/dead workers without a claim (not master/scouts) and `pty-hook-events/` files of unregistered agents. A running coordinator does this itself. |
| `sessions` | `[--all]` `[--json]` | Supervised sessions: state (`running`, `recoverable`, `unknown`, `offline`), transport, PID, owner, reason. |

## Task management

| Command | Flags | Notes |
|---------|-------|-------|
| `delegate` | `--task-ref=<feature/task>` `[--target-agent-id=<id>]` `[--task-type=implementation\|refactor]` `[--note=<text>]` `[--actor-id=<id>]` | Force dispatch (normal dispatch is automatic). Refuses a target with an active run. |
| `task-reset <task_ref>` | `[--actor-id=<id>]` | Any status → `todo`; cancels active claims (`run_cancelled` per run), clears requeue backoff. |
| `task-unblock <task_ref>` | `[--reason=<text>]` `[--actor-id=<id>]` | `blocked` → `todo`. |
| `task-cancel <task_ref>` | `[--reason=<text>]` `[--actor-id=<id>]` | → `cancelled`, ends any active run. Exits 1 if already done/released/cancelled. |
| `task-mark-done <task_ref>` | `[--actor-id=<id>]` | Recovery: mark done in runtime state (the coordinator does this after merge). |
| `run-expire <run_id>` | — | Force-expire a claim and requeue the task. |
| `run-close <run_id>` | `[--reason=<text>]` `[--actor-id=<id>]` | Close a run merged by hand (see below). MCP: `close_run`. |

`run-close` requires a non-terminal claim whose task is `done`/`released` or whose branch is merged into `main` (an ancestor of `main`, not on its first-parent history). It records the claim `done`, emits `run_finished {closed_by, reason, manual: true}`, and for a merged branch marks the task `done` and removes the worktree and branch. For squash/rebase/fast-forward merges run `task-mark-done` first; otherwise use `run-expire` or `task-reset`.

Authorization (canonical: [contracts.md → Local Control API](contracts.md#local-control-api)):

- The commands above, `run-input-respond` and `project task create|edit|import` are applied by the running coordinator over its control API, as the operator.
- No coordinator: applied directly with `coordinator is not running; applying <op> directly`. Coordinator alive but API not answering: retryable error.
- A shell inside a worker session (`ORC_SESSION_SECRET`) is refused; `run-input-respond` needs the master's `ORC_MASTER_SECRET`.
- `--actor-id` must be `human` or a registered agent; default is the caller (`human` for the operator); ignored with the master's session.

## Plans

Plan Markdown format: [plan-template.md](plan-template.md).

## Inspection

| Command | Flags | Notes |
|---------|-------|-------|
| `runs-active` | `[--json]` `[--via-control]` | In-progress/claimed runs with idle/age; JSON rows carry `stalled`. |
| `run-info <run_id>` | `[--json]` | Claim state, task, worktree, idle time. |
| `waiting-input` | `[--json]` | Runs waiting for master input. |
| `events-tail` | `[--n=<count>]` `[--event=<name>]` `[--json]` | Last N events. |
| `events-filter` | `[--run-id=<id>]` `[--agent-id=<id>]` `[--event=<type>]` `[--last=<N>]` `[--json]` | Query events. |
| `event-cursor` | `[--consumer=<id>]` `[--reset-to=<seq>]` | Show a consumer offset; reset replays events after `<seq>` (coordinator must be stopped). |

### `orc control`

Client for the coordinator's local control API. Fails with "Control daemon is not running" when the coordinator is down.

| Subcommand | Flags |
|------------|-------|
| `snapshot` | — |
| `events` | `[--after=<seq>]` `[--limit=<n>]` `[--follow]` `[--max-events=<n>]` |
| `command` | `--run-id=<id>` `--recipient-session=<id>` `--kind=<kind>` `--idempotency-key=<key>` `[--payload=<json>]` |
| `ack <command_id>` | `--state=<accepted\|running\|completed\|failed>` |
| `message` | `--run-id=<id>` `--recipient-session=<id>` \| `--recipient-agent=<id>` (exactly one) `--kind=<message\|question\|review_request\|feedback\|result>` `--text=<text>` `--idempotency-key=<key>` `[--artifact-ref=<ref>]` `[--parent-message=<id>]` |
| `messages` | `[--include-consumed]` |
| `consume <message_id>` | — |

- Mutations authenticate with `ORC_MASTER_SECRET` or `ORC_SESSION_SECRET`; `--credential=<secret>` overrides (`--session-token` is an alias).
- `snapshot`, `events` and `runs-active --via-control` read the whole project: master and operator only; a worker session gets `403`.

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
| `run-input-respond` | `--run-id=<id>` `--agent-id=<id>` `--response=<text>` `[--actor-id=<id>]` `[--request-id=<id>]` | Master answers (needs `ORC_MASTER_SECRET`). |
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
| `stop-check` | Claude task workers' `Stop` hook (reads hook JSON on stdin). Blocks the turn end while the run is unfinished (no `run-work-complete`, no pending input, not finalizing): max 3 blocks per 10 min, 9 per run, each a `stop_blocked` event. Also closes unfinished tool calls. Always exits 0; fails open. |
