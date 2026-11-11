# CLI reference

`orc <subcommand> [args...]`. `orc --help` lists every subcommand.

## Global options

- `--project=<id>` (or `--project <id>`) selects a registered project for any subcommand, before or after it (not after `--`). Highest precedence; an unknown id is an error; an inherited `ORC_STATE_DIR` is ignored. See [configuration.md → Project selection](configuration.md#project-selection).
- `orc <subcommand> --help` (or `-h`) prints that subcommand's usage line and never runs it.
- Commands that show state print the project they act on.
- Output is for people or for scripts, decided by stdout. On a terminal, `--json` is indented and the `status` banner is shown. When stdout is piped or captured, `--json` is one compact line and the banner is omitted. The JSON shape is the same either way. A `--json` result is never cut short when piped.
- Argument parsing is strict for the commands that read project state (`status`, `runs`, `run-info`, `review-read`, `worker-status`, `sessions`, `events`) and for `task-cancel`, `task-reset` and `worker-remove`: `--x=v` and `--x v` both work, an unknown flag or surplus argument is a usage error (exit 1), and a flag's value is never taken as the positional target.
- Project-scoped read commands exit 1 with the no-project message when no project resolves, instead of returning empty results.

## Session management

| Command | Flags | Notes |
|---------|-------|-------|
| `init` | `[--provider=claude,codex,gemini]` `[--worker-provider=<name>]` | Needs a registered project (`orc project add`). Records `default_provider`, `worker_pool.provider`, and `worker_pool.max_workers` (when unset) in the registry; writes nothing into the repository. `--provider` is required outside a TTY. Refuses `--force`. |
| `start-session` | `[--provider=claude\|codex\|gemini]` `[--agent-id=<id>]` `[--reset]` `[--restart-stale]` `[--no-cockpit]` | Starts the coordinator (background) and the master in orc's tmux server (needs tmux), then runs the cockpit in this terminal (described under `cockpit`) on this project: its master for a project new to the cockpit, the tab it last showed otherwise. The cockpit reaches the master directly on orc's tmux server, so it works with the coordinator stopped. One cockpit runs per user: it holds a lock (`cockpit/cockpit.lock` under orc's data home, `ORC_DATA_HOME`) naming its pid and process start time. Run on another terminal while a cockpit runs, it takes over: it asks the running one to exit (that one prints that the cockpit moved to another terminal) and opens here with this project shown; a lock whose pid is dead, or reused by another process (the start time differs), is taken over silently; a running cockpit that does not exit within 5 s is reported and start-session attaches straight to the master. Run from inside orc's tmux servers (the master's shell, which the cockpit shows), it nests nothing: it adds the project to the cockpit's view state (`cockpit/view-state.json`) as its active project and wakes the running cockpit (SIGUSR2), which shows it; with none running, the next cockpit opens with it. What an older orc's cockpit left is retired on launch: a running old cockpit is asked to exit through its lock, which is then removed, and its tmux servers, which only host views, are killed (a no-op once they are gone). `Ctrl-q`, the prefix then `d` (`F12 d`), or closing the terminal quits the cockpit; masters, workers and coordinators keep running. `--no-cockpit` attaches straight to the master instead (`Ctrl-b d` detaches, as before), and so does a cockpit that cannot run. A live master is reattached instead of starting another. A master that exits (`/exit`) while the cockpit runs leaves its tab showing how to start it; after the cockpit quits, start-session sees the session gone and retires it (one that exits with no cockpit open is retired by the coordinator). A dead Claude master resumes its recorded conversation. Without a TTY it starts the master and does not attach. Wires the orchestrator MCP server into the master. Runtime state is kept: the new coordinator adopts live worker sessions (crash recovery). `--reset` (interactive: "Start fresh (reset)") stops the running coordinator and every worker session, then fails their runs (`session_reset`) and requeues the tasks; it refuses while a master runs or the coordinator cannot be stopped. A running coordinator whose `version` or `build_id` differs from the code on disk, or that reports no build id at all while the disk has one (started before health carried it), triggers a warning; `--restart-stale` then restarts it (state is kept). |
| `cockpit` | | The cockpit, which draws the whole terminal itself, on the current project; starts no coordinator or master. Needs a TTY. What `start-session` runs on a terminal, launched the same way (see `start-session`): one cockpit per user with takeover from another terminal, from inside orc's tmux servers only the nested add of the current project, and what an older orc's cockpit left retired on launch. Opens the current project in the slot (right, below the tab bar): its master for a project new to the cockpit, the tab it last showed otherwise. The top row is a header: `ORC`, the active project's name (cut first on a narrow terminal) and, flush right, the `tasks` entry and the attention badge (`! N`); the last row is a footer: the focus or the tab's mode and its keys, then `project › tab`, then the quit, dashboard and attention keys as configured, cut from the right on a narrow terminal (a terminal too short drops the footer, then the header). Between them the slot sits next to the sidebar (left, 34 columns: status, projects and the active project's agents with their attention badges) and the tab bar (right, 3 rows: the active project's tabs with their attention badges, `○` view and `✎` typing marks on agent tabs, a `×` close marker, and `‹ N`/`N ›` for tabs that do not fit). The master is reached directly on orc's tmux server (the status view's `tmux_socket`/`tmux_session`, else the names computed from the state directory), so it works with the coordinator stopped; its window is sized to the slot. Keys go to the master, pastes arrive as one paste. Clicks on a sidebar row open that project or agent and on a tab show it, either one then taking the keys; a click on a tab's `×` closes it (only the view: the agent keeps running); in the pane, mouse events reach an app that turned its mouse mode on, pane-relative in its encoding (none from a view-only worker or scout tab); otherwise the wheel scrolls the pane's scrollback (including output from before the cockpit attached; any key returns to live) and a drag selects text, copied to the clipboard with OSC 52 on release. Shift held always selects or scrolls instead of reaching the app (the terminal's own selection is off while the cockpit runs). The prefix table is the cockpit's (`n`/`p`, `&`, `1`-`9`, `N`/`P`, `d`; pressed twice the prefix reaches the pane), and so are the direct keys `F1`-`F9`. `F10` or the prefix then `o` give the sidebar the keys (the focused box's title and cursor row are reversed; otherwise the active tab's label is): arrows or `j`/`k` move, `Tab` switches between projects and agents, `Enter` opens and gives the opened tab the keys, as a click does, `Esc` (or the prefix then `o` again, or a click in the slot) returns to the pane. The prefix then `t`, or the header's `tasks` entry, opens the read-only task explorer of the active project as a tab after the project's tabs (it runs `orc cockpit explorer` in a session on the cockpit's private tmux server `orc-explorer` and exists only while shown; `tmux -L orc-explorer kill-server` ends any explorer left by a cockpit that crashed, and stops no agent). It owns its keys, sent to it one at a time even when they arrive together: arrows or `j`/`k`, `Enter`, `Esc`/`q`/`h`/`Backspace` back from a task, `s`/`f` filters, and `Esc` or `q` in its list quit it, which closes the tab; `Ctrl-]` or its `×` always close it, and so do `q`/`Esc`/`Ctrl-D`/`Ctrl-C` while it is starting or shows why it failed. Closing it or any tab change shows the active tab again. `F11`, or a click on the header's attention badge (`! N`, the agents needing a human across projects), shows the next agent needing attention: the cockpit's projects first, permission prompts first within a project; projects whose coordinator is down are skipped. Worker and scout tabs open view-only: no key reaches the agent, `q`/`Esc`/`Ctrl-D`/`Ctrl-C`/`Ctrl-]` close the tab, `i` types into it until `Ctrl-]` or the tab is left (another tab or project, the explorer, `F11`), so every return to a worker or scout tab starts view-only; keys typed reach it as they come and pastes arrive as one paste (pastes are dropped in view mode). `Ctrl-q` (`ORC_COCKPIT_KEYS` `quit=<key>`) or the prefix (`ORC_COCKPIT_PREFIX`, `F12`) then `d` quits and restores the terminal; quitting, a crash, SIGTERM or SIGHUP never stops the master, a worker or the coordinator. A master whose session is not running shows how to start it. The screen is redrawn only when something changed. Without true colour (`COLORTERM` other than `truecolor`/`24bit`) RGB colours are drawn as the nearest of the 256 xterm colours. |
| `cockpit explorer` | `--project=<id>` | The read-only task explorer of the selected project until `Esc` or `q`, as the cockpit's explorer tab runs it; usable on its own in any terminal. |
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
| `watch` | `[--interval-ms=<ms>]` `[--once]` | A standalone dashboard of every registered project: the cockpit's sidebar view on its own, without cockpit actions; plain refresh without a TTY. Reads everything through `orc-state/client` (the `ProjectWatcher`), never the state files. Three boxes, top to bottom. **Status**: the active project's coordinator (`running`, `stopped`, `stale`: recorded as running but not answering, or `incompatible`), its worker capacity used/total, and how many agents need a human across projects (`N need you`). **Projects**: every registered project with its state and, when its agents need a human, `!N`; `▸` marks the active project, at first the one `orc watch` runs for, then the one last selected. **Agents** of the active project, its workers and scouts (never the master), two rows each: the name, the current phase and the run time (`12m`, `1h04`); then the activity line (else the task), cut to the width. An agent that needs a human shows a badge in the phase's place: `PERMISSION` (a provider permission prompt), `QUESTION` (a `run-input-request`), `STALLED` or `NO PROGRESS`, with the question, prompt or reason as its second row, and is listed first. It only shows these; answer through the master or `orc run-input-respond`. Keys: `↑`/`↓` (or `k`/`j`) move within a box, `Tab` moves between Projects and Agents, Enter selects: a project switches the Agents box to it, an agent says terminals open in the cockpit (`orc cockpit`). The bottom line shows the keys, or what the last selection did. The screen is redrawn only when the shown data changes, and the output is kept below the terminal height (re-fitted on resize): the Agents box gets the rows left after Status and Projects, shows the agents needing a human (never cut) and as many others as fit around the selection, and counts the rest in a `+N more` row; the Projects box is cut (around its selection) only when it would leave too little for them. The live view starts from a cleared screen. With no coordinator running, the current project is shown as `stopped` (exit 0 with `--once`; an unreachable or incompatible coordinator, or an unreadable registry, exits 1). Without a TTY, the plain refresh prints the current project's status (marked `showing last known status` when its coordinator stopped) and one line per other project. |
| `doctor` | `[--json]` `[--stale-progress-ms=<ms>]` `[--stale-start-ms=<ms>]` | Full health check: state files, provider binaries, stale workers, orphaned claims, invariants, sandbox deps, memory store, `events.db` schema (`checks.runtimeSchema`), whether the running coordinator's schema support covers `events.db` and `runtime.db` (`checks.coordinatorSchema`; fails `doctor`, see [recovery.md](./recovery.md#runtime-database-upgrade-and-restore)), and a restart warning when the running coordinator's code is older than the code on disk (`checks.coordinatorCode`; never fails `doctor`). Stale thresholds default to 20 min / 5 min. MCP `doctor` runs the same checks (`lib/doctor.ts`) and returns `{ ok, checks: [{ name, ok, detail }] }`. |
| `preflight` | `[--json]` | Fast environment check before `start-session`. |

When a live run (claimed or in progress) waits for an input response, `status` and the plain `watch` print a `Waiting for input (N)` section under the title: agent, task, wait time, the question (truncated) and how to answer (`orc run-input-respond …` or ask master). The section is left out when nothing waits. The `watch` sidebar marks the worker's row with a `QUESTION` badge (`PERMISSION` for a provider prompt) and the question. Finished claims that still carry `awaiting_input` (legacy runs) are not listed here, by `orc runs --state=waiting-input` or by MCP `list_runs`. `status --json` counts the waiting runs in `claims.waiting_input` and adds `coordinator` (`{ running, pid, version, started_at, stale }`, as MCP `get_status`).

Under each active run, `watch` and `status` print a `└` activity line: a note younger than 5 min, else the current to-do item, else the last tool call; `status` dims it after 2 min (`watch` always shows it dimmed). MCP `get_status` / `get_agent_workview` return it as `current_activity`.

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
| `terminal <agent_id> \| <provider\|shell> <run_id>` | `[--write [--takeover] \| --view-first]` `[--once]` | `<agent_id>`: the provider terminal of that agent's running session (a worker, a scout or the master, e.g. `orc terminal master --write`); an unknown agent or one with no running session fails `not_found`. `provider`: the run's provider terminal; `shell`: a shell in the run worktree (survives detach; output in `<state>/terminal-logs/`). Streams live output (`GET /v1/terminals/<id>/stream`); sizes the pane to this terminal when it holds the lease or is the first viewer. Read-only by default; `--write` takes the exclusive input lease (`--write --takeover` takes it from its current holder; operator only); `--once` prints the current screen and exits (MCP `terminal_snapshot` reads the same screen, ANSI stripped). `--view-first` (needs a TTY; the cockpit's agent tabs use the same keys) opens in view mode: no lease, no key reaches the agent; `i` types (takes the lease), `Ctrl-]` stops typing (releases it, back to view mode); in view mode `q`, `Esc`, `Ctrl-D`, `Ctrl-C` or `Ctrl-]` closes it with exit code 10 (any other end shows the closed/reconnect prompt); the mode and its keys show on the bottom line, drawn at open, after each snapshot and on each mode change (the cursor is kept; the agent's next repaint of that line covers it). Ctrl-] detaches a `--write` writer, Ctrl-C an observer; a hang-up (its window closed) detaches and releases the lease too. Needs the coordinator and tmux; run from the master or an operator shell, never a worker. |
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
| `report-for-duty` | `--agent-id=<id>` `--session-id=<id>` | Session ready after bootstrap, for sessions without a session-start hook (Gemini, sandboxed Codex); a Claude or `full-access` Codex CLI session reports ready through its hook. Accepted from any provider (`--session-token` is an alias of `--session-id`). |
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
