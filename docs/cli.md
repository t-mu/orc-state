# CLI reference

All commands are invoked as `orc <subcommand> [args...]`.
Run `orc --help` for the full list.

---

## Global options

`--project=<id>` (or `--project <id>`) selects a registered project for any subcommand. It may appear before or after the subcommand (not after a `--` separator), takes precedence over `ORC_PROJECT_ID`, the current repository and `orc project select`, and an unknown id is an error rather than a fallback. Inherited legacy path variables (`ORC_STATE_DIR`, `ORC_HOME`, `ORC_REPO_ROOT`, `ORC_CONFIG_FILE`) are ignored for that command. Commands that show state print the project they act on. See `docs/configuration.md` → Selecting and switching projects.

## Session management

These are the commands you'll use to start and stop the orchestrator.

### `orc init`

First-time setup of a registered project. Register the repository first with
`orc project add <git-path>` (or migrate an old installation with
`orc project migrate`); without a registered project `orc init` refuses to run,
as do `orc start-session`, the coordinator and the MCP server. Walks you through
provider selection (`--provider` is required outside a TTY).

```bash
orc init                           # interactive (TTY)
orc init --provider=claude         # non-interactive
orc init --provider=claude,codex   # multiple providers
```

`orc init` writes nothing into the
repository: it records the provider choices as project settings in the registry
(`default_provider`, `worker_pool.provider`, and `worker_pool.max_workers` when unset),
completes the external state directory, and points at `orc install --global`
for skills and agents (`orc start-session` wires the MCP server). It needs no Git checkout in the current
directory when the project is selected with `--project`, asks no install questions, and refuses `--force`.

**Flags:** `[--provider=<providers>]` `[--worker-provider=<name>]`

### `orc start-session`

Start the coordinator (background process) and master agent session (foreground).
The coordinator manages the task lifecycle — dispatching work to workers, monitoring
health, and merging completed tasks. The master is your interactive session.

```bash
orc start-session                          # uses default provider from config
orc start-session --provider=claude        # explicit provider
```

**Flags:** `[--provider=claude|codex|gemini]` `[--agent-id=<id>]`

### `orc kill-all`

Full reset. Stops the coordinator, terminates all worker sessions, clears the
agent registry, and requeues any in-flight tasks. Use when the system is in a
bad state and you want a clean slate.

```bash
orc kill-all
```

**Flags:** `[--keep-sessions]`

---

## Monitoring

Commands for checking what the orchestrator is doing.

### `orc status`

Print a summary of agents, tasks, claims, and worker capacity. This is the
first command to run when you want to know what's going on.

```bash
orc status                # one-shot summary
orc status --watch        # auto-refresh
orc status --json         # machine-readable
```

**Flags:** `[--json]` `[--mine --agent-id=<id>]` `[--watch|-w]` `[--interval-ms=<ms>]` `[--once]`

### `orc watch`

Live-updating TUI dashboard. Shows agents, active runs, task progress, and
worker capacity in real time. Falls back to plain text refresh if no TTY.

```bash
orc watch
```

**Flags:** `[--interval-ms=<ms>]` `[--once]`

### `orc doctor`

Comprehensive health check. Validates state files, checks provider binaries
are installed, detects stale workers, orphaned claims, lifecycle invariant
violations, sandbox dependencies, and memory store integrity.
It also checks the versioned runtime tables in `events.db` and reports schema
version or migration problems under `checks.runtimeSchema` in JSON output.

```bash
orc doctor
orc doctor --json
```

If doctor reports issues, follow its suggested fixes.

**Flags:** `[--json]`

### `orc preflight`

Lightweight environment validation. Checks that the repo is set up correctly,
state files exist, and provider CLIs are available. Faster than `doctor` — use
before `start-session` to catch obvious problems.

```bash
orc preflight
```

**Flags:** `[--json]`

---

## Setup

`orc init` does not run these. Install skills and agents for your user with
`orc install --global --provider=<providers>`; `orc start-session`
wires the orchestrator MCP server into the master itself.

| Command | Description |
|---------|-------------|
| `install` | Install skills and agents for the given providers (default: the active project's provider settings). Writes no MCP config. |
| `install-skills` | Install skill definitions for supported provider targets. |
| `install-agents` | Install agent configuration files for supported provider targets. |

**Flags:**

| Command | Flags |
|---------|-------|
| `install` | `[--provider=<providers>]` `[--global]` `[--dry-run]` `[--skip-skills]` `[--skip-agents]` |
| `install-agents` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |
| `install-skills` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |

---

## Worker management

Recovery and debug commands for managing worker agents directly. In normal
operation, the coordinator spawns and manages workers automatically — these
commands are for when you need to intervene manually.

| Command | Description |
|---------|-------------|
| `attach <id>` | Print the tail of a worker's PTY output log (read-only). |
| `control-worker <id>` | Interactive PTY control of a running worker session. |
| `worker-remove <id>` | Stop a worker's session and remove it. Refused while the worker holds an active claim. |
| `worker-gc` | Remove offline and dead workers, and workers whose session is unreachable, unless they hold an active claim. |
| `worker-status [agent_id]` | Show worker state, active task, and session info. |

For a live run, `orc terminal provider <run_id>` observes its tmux provider
terminal. `orc terminal shell <run_id>` opens a separate shell in the assigned
worktree, including when the provider uses a structured runtime. Both commands
are read-only by default; add `--write` to acquire the exclusive input lease.
Press Ctrl-] to detach a writer or Ctrl-C to detach an observer. `--once` prints
the current output and exits. The shell survives detach and daemon restart;
its output is retained in `terminal-logs/` in the project state directory.
Terminals require the local control daemon and tmux, and are for the master
and the operator: run them from the master's shell or an operator shell, never
from inside a worker session. A legacy `pty:` provider
has only its log tail through `orc attach`.

**Flags:**

| Command | Flags |
|---------|-------|
| `worker-remove` | `<id>` `[--keep-session]` |
| `worker-status` | `[<agent_id>]` `[--json]` |

---

## Task management

Commands for creating, completing, and managing tasks. In normal operation,
the master agent handles task creation and the coordinator handles dispatch.
These are available for manual intervention and debugging.

`task-cancel`, `task-reset`, `task-unblock`, `delegate` and
`run-input-respond` (like the master's `cancel_task`, `reset_task`, `unblock_task`,
`delegate_task` and `respond_input`) are applied by the running coordinator
through its control API; the CLI sends them as the operator, the master's tools
with the master's session, and a shell inside a worker session (one with
`ORC_SESSION_SECRET`) is refused. `run-input-respond` answers as the master and
needs the master's credential in every case: its `ORC_MASTER_SECRET`
(so it runs from the master's own shell). When no coordinator is
running they apply the change directly and print `coordinator is not running;
applying <op> directly`, so operator recovery works with the coordinator stopped.
While a coordinator still holds the project (its `coordinator.pid` names the
live coordinator process, checked by PID and start time) but its control API is not answering, as during startup or shutdown,
they refuse with a retryable error instead of writing alongside it.

These commands and the master's tools now share one implementation: `task-reset`
and `reset_task` also clear `requeue_eligible_after` and record a
`run_cancelled` event per cancelled run; `delegate` applies the master tool's
eligibility check, refusing a target that already has an active run, with the
routing reasons in the error; `task-unblock` records `--actor-id` when given.
Without `--actor-id` the coordinator records the caller (the master session as the
master, an operator as `human`); with the master's session, `--actor-id` is ignored and
the master is recorded. As the operator, `--actor-id` must be `human` or a registered
agent; any other id (such as `coordinator`) is refused. The same rule applies to
`run-expire`, `task-mark-done` and project task authoring. An answer from `run-input-respond` is recorded with
`actor_type: agent` for an agent actor such as `master` (it used to be `human`).

| Command | Description |
|---------|-------------|
| `task-mark-done <task-ref>` | Operator recovery: mark a task done in runtime state. The coordinator marks merged tasks done itself. No spec file is changed. |
| `task-reset <task-ref>` | Reset a task to `todo`, cancelling any active claims. |
| `task-unblock <task-ref>` | Transition a blocked task back to `todo`. |
| `task-cancel <task-ref>` | Cancel a task that is not yet terminal, ending any active run (status `cancelled`). Exits 1 for a task that is already done, released or cancelled. |
| `delegate` | Dispatch a task to an available worker agent. |
| `project task <list\|show\|revisions\|create\|edit\|import\|export>` | Author tasks in a registered project's SQLite store: `create [--feature=] [--title=] [--body-file=] [--depends-on=a,b] [--ac=..]`, `edit <ref> --expected-revision=<n> [fields]`, `show <ref> [--revision=<n>]`, `import <file-or-dir> [--strict]`, `export <dir-or-file.md> [--ref=a,b]`; `project plan <list\|show\|import\|export>` stores and renders plans. All accept `--project=<id>`; `create`, `edit` and `import` also accept `--actor-id=<id>`. See configuration.md → Project tasks. |
| `project migrate [legacy-path] [--execute [--name=N] \| --cleanup-report]` | Move an attached or sibling installation into a registered project; it is the only way to keep using an old installation, which no longer runs. Without flags it is a dry run (inventory, conflicts, blockers; nothing is written). `--execute` backs up, imports tasks with their effective runtime status, copies history, imports plans and settings, verifies parity, and cuts over; a retry is safe. `--cleanup-report` lists leftover legacy files after the cutover; nothing is deleted. Exits 1 when `--execute` is `blocked` or `verification_failed`. See configuration.md → Migrating an existing installation. |

`orc project task create|edit|import`, MCP task authoring, `run-expire` and `task-mark-done` are applied by the running coordinator. `import` reads the files in the caller's process and sends their contents, so the coordinator never opens the caller's path. If no coordinator holds the project, they apply directly and print a warning. A live coordinator whose API is unavailable returns a retryable error.

**Flags:**

| Command | Flags |
|---------|-------|
| `task-mark-done` | `<task-ref>` `[--actor-id=<id>]` |
| `task-reset` | `<task-ref>` `[--actor-id=<id>]` |
| `task-unblock` | `<task-ref>` `[--reason=<text>]` `[--actor-id=<id>]` |
| `task-cancel` | `<task-ref>` `[--reason=<text>]` `[--actor-id=<id>]` |
| `delegate` | `--task-ref=<feature/task>` `[--target-agent-id=<id>]` `[--task-type=implementation\|refactor]` `[--note=<text>]` |

---

## Plans

A project stores plans in its SQLite store. `orc project plan import` reads plan Markdown
files in the format below, and `orc project plan export` writes it. Tasks are authored with
`create_task` (`body_markdown`) or `orc project task import`.

**On-disk contract:**

- Required frontmatter: `plan_id`, `name`, `title`, `created_at`, `updated_at`,
  `derived_task_refs`. `derived_task_refs: []` is valid for fresh plans.
- Required sections: `## Objective`, `## Scope`, `## Out of Scope`,
  `## Constraints`, `## Affected Areas`, `## Implementation Steps`.
- `## Implementation Steps` is an ordered sequence of `### Step N — Title`
  sub-headings. Steps may declare dependencies with the exact structured cue
  `Depends on: N` or `Depends on: N, M`. The structured cue is plans-only;
  task specs continue to use the prose `Depends on Task N.` form.
- Plan bodies must not contain unresolved placeholders: `TBD`, `TODO`, three or
  more `?` characters, or bare bracketed fill-ins (`[like this]`) outside fenced
  code blocks and outside markdown link syntax (`[text](url)`).
- Plan files must be UTF-8 without a byte-order mark.
- `plan_id` numbering is an independent sequence from task numbers.
  Collisions across the two sequences are expected and benign.

See `docs/plan-template.md` for a skeleton that `orc project plan import` accepts. The parser
lives in `lib/planDocs.ts` (`parsePlan`).

---

## Inspection

Commands for digging into active runs and the event stream.

| Command | Description |
|---------|-------------|
| `runs-active` | List in-progress and claimed runs with idle/age metrics. |
| `sessions` | List supervised provider sessions with state (`running`, `recoverable`, `unknown`, `offline`), transport, PID, owner and reason. |
| `run-info <run_id>` | Show claim state, task, worktree path, and idle time for a run. |
| `run-expire <run_id>` | Force-expire a claim and requeue the task. |
| `waiting-input` | List runs blocked waiting for master input. |
| `events-tail` | Print the last N events. |
| `events-filter` | Query events by run, agent, or event type. |
| `event-cursor` | Inspect a durable consumer offset; reset it for replay while the coordinator is stopped. |
| `control` | Client for the local daemon control API: `snapshot`, `events`, `command`, `ack`, `message`, `messages`, `consume`. |

**Flags:**

| Command | Flags |
|---------|-------|
| `runs-active` | `[--json]` `[--via-control]` |
| `sessions` | `[--all]` `[--json]` |
| `run-info` | `<run_id>` `[--json]` |
| `events-tail` | `[--n=<N>]` `[--event=<name>]` `[--json]` |
| `events-filter` | `[--run-id=<id>]` `[--agent-id=<id>]` `[--event=<type>]` `[--last=<N>]` `[--json]` |
| `event-cursor` | `[--consumer=<id>]` `[--reset-to=<seq>]` |
| `control snapshot` | — |
| `control events` | `[--after=<seq>]` `[--limit=<N>]` `[--follow]` `[--max-events=<N>]` |
| `control command` | `--run-id=<id>` `--recipient-session=<id>` `--kind=<kind>` `--idempotency-key=<key>` `[--payload=<json>]` `[--credential=<secret>]` |
| `control ack` | `<command_id>` `--state=<accepted\|running\|completed\|failed>` `[--credential=<secret>]` |
| `control message` | `--run-id=<id>` `--recipient-session=<id>` `--kind=<message\|question\|review_request\|feedback\|result>` `--text=<text>` `--idempotency-key=<key>` `[--artifact-ref=<ref>]` `[--parent-message=<id>]` `[--credential=<secret>]` |
| `control messages` | `[--include-consumed]` `[--credential=<secret>]` |
| `control consume` | `<message_id>` `[--credential=<secret>]` |
| `waiting-input` | `[--json]` |

The coordinator reads at most 128 event rows per tick and records its cursor in
SQLite. The old `event-checkpoint.json` is retained as a migration backup.
Resetting the cursor replays events after the chosen sequence; stop the
coordinator first and use a sequence at or before the event you want replayed.

`orc control` and `runs-active --via-control` talk to the coordinator's local
control API (see `docs/contracts.md` → **Local Control API**). They fail with
"Control daemon is not running" when the coordinator is stopped or has crashed;
the plain `runs-active` path still works then. Mutations authenticate with the
caller's session secret (`ORC_MASTER_SECRET` or `ORC_SESSION_SECRET`, which
launched sessions receive; `--credential` overrides it, and `--session-token`
is its older name). `orc control
snapshot` lists running sessions (caller and recipient IDs). Snapshot, events
and `runs-active --via-control` read the whole project, so only the master and
the operator may use them; a worker session is refused (`403`).
Queued commands are not yet delivered to workers.

---

## Memory

The memory system stores persistent knowledge across sessions. Agents use
`memory-wake-up` and `memory-record` during task execution. These commands
are also available for manual inspection.

| Command | Description |
|---------|-------------|
| `memory-status` | Show store statistics: drawer count, wings, rooms, DB size. |
| `memory-search <query>` | Full-text search across memory drawers. |
| `memory-wake-up` | Recall essential memories for session context (agent use). |
| `memory-record` | Store a memory manually (agent use). |

**Flags:**

| Command | Flags |
|---------|-------|
| `memory-search` | `<query>` `[--wing=<wing>]` `[--room=<room>]` |
| `memory-wake-up` | `[--wing=<wing>]` `[--budget=<N>]` |
| `memory-record` | `--content=<text>` `[--wing=<wing>]` `[--hall=<category>]` `[--room=<topic>]` `[--importance=<N>]` |

---

## Run lifecycle

Worker agents call these commands from inside their PTY sessions to report
progress through the task lifecycle. Not for human use.

In a registered project these commands do not write the state directory: each
is sent to the coordinator over `ORC_CONTROL_SOCKET` with the worker's session
secret (`ORC_SESSION_SECRET`), and the coordinator applies it for that
session's own run. Outside a worker session they are refused, except
`memory-record`, which an operator shell still writes directly. While the
coordinator is stopped or restarting they retry for up to
`ORC_CONTROL_RETRY_MS` (two minutes). To stop a run from outside, use
`orc task-reset <ref>` or the master's `reset_task`/`cancel_task`. See
[configuration.md → Global project registry](configuration.md#global-project-registry-new-project-api).

| Command | Description |
|---------|-------------|
| `report-for-duty` | Worker announces session is ready after bootstrap. |
| `run-start` | Acknowledge task start; transitions claim to `in_progress`. |
| `run-work-complete` | Signal implementation, review, and rebase are done. |
| `run-finish` | Terminal success. Ends the run. |
| `run-fail` | Terminal failure. Requeues or blocks the task. |
| `progress` | Emit a phase lifecycle event (phase_started, phase_finished). |
| `run-input-request` | Worker asks the master a blocking question. |
| `run-input-respond` | Master answers a worker's pending input request. |

**Flags:**

| Command | Flags |
|---------|-------|
| `report-for-duty` | `--agent-id=<id>` `--session-id=<id>` (`--session-token` is its older name) |
| `run-start` | `--run-id=<id>` `--agent-id=<id>` |
| `run-work-complete` | `--run-id=<id>` `--agent-id=<id>` |
| `run-finish` | `--run-id=<id>` `--agent-id=<id>` |
| `run-fail` | `--run-id=<id>` `--agent-id=<id>` `[--reason=<text>]` `[--code=<code>]` `[--policy=requeue\|block]` |
| `progress` | `--event=<type>` `--run-id=<id>` `--agent-id=<id>` `[--phase=<name>]` `[--reason=<text>]` |
| `run-input-request` | `--run-id=<id>` `--agent-id=<id>` `--question=<text>` `[--timeout-ms=<ms>]` |
| `run-input-respond` | `--run-id=<id>` `--agent-id=<id>` `--response=<text>` `[--actor-id=<id>]` `[--request-id=<id>]` `[--session-id=<master session id, legacy only>]` (`--session-token` is its older name) |

---

## Review

Sub-agent reviewers use these to submit findings. The worker that spawns
them uses `review-read` to collect results. Not for human use.

| Command | Description |
|---------|-------------|
| `review-submit` | Submit review outcome (approved or findings) for a run. |
| `review-read` | Retrieve all submitted review findings for a run. Exits 0 whatever the reviews say; exits 1 only when they could not be read (the coordinator is down and the state is not readable directly), and the message asks to retry. |

**Flags:**

| Command | Flags |
|---------|-------|
| `review-submit` | `--run-id=<id>` `--agent-id=<id>` `--outcome=approved\|findings` `--reason=<text>` |
| `review-read` | `--run-id=<id>` `[--json]` |

---

## Pull Request

Commands for interacting with pull requests. Used by PR reviewer workers —
not for direct human use. Require `pr_provider` in config.

| Command | Description |
|---------|-------------|
| `pr-diff <pr_ref>` | Print PR diff to stdout. |
| `pr-review <pr_ref>` | Submit PR review (approve or request changes). |
| `pr-merge <pr_ref>` | Merge the PR. |
| `pr-status <pr_ref>` | Show PR status and CI state. |

**Flags:**

| Command | Flags |
|---------|-------|
| `pr-diff` | `<pr_ref>` |
| `pr-review` | `<pr_ref>` `--approve\|--request-changes` `[--body=<text>]` |
| `pr-merge` | `<pr_ref>` |
| `pr-status` | `<pr_ref>` |

---

## MCP server

Starts the Model Context Protocol server for tool-based orchestrator access.
Used internally by agent integrations.

| Command | Description |
|---------|-------------|
| `mcp-server` | Start the MCP server. |

---

## Skills

The `orc install-skills` command installs provider-agnostic skill definitions
into `.claude/skills/` or `.codex/skills/`. The packaged skills include:

| Skill | Purpose |
|-------|---------|
| `orc-commands` | Inline reference for orc CLI subcommands. |
| `worker-inspect` | Inspect worker state via MCP orchestrator tools. |

