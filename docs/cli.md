# CLI reference

All commands are invoked as `orc <subcommand> [args...]`.
Run `orc --help` for the full list.

---

## Session management

These are the commands you'll use to start and stop the orchestrator.

### `orc init`

Interactive first-time setup. Walks you through provider selection, initializes
state files, and installs skills, agents, and MCP configuration for your chosen
providers.

```bash
orc init                           # interactive (TTY)
orc init --provider=claude         # non-interactive
orc init --provider=claude,codex   # multiple providers
orc init --force                   # reinitialize (backs up existing state)
```

**Flags:** `[--provider=<providers>]` `[--feature=<ref>]` `[--feature-title=<title>]` `[--skip-skills]` `[--skip-agents]` `[--skip-mcp]` `[--force]`

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

These commands are called by `orc init` automatically. You typically don't need
to run them directly unless you're updating an existing installation.

| Command | Description |
|---------|-------------|
| `install` | Install skills, agents, and MCP config for configured providers. |
| `install-skills` | Install skill definitions for supported provider targets. |
| `install-agents` | Install agent configuration files for supported provider targets. |

**Flags:**

| Command | Flags |
|---------|-------|
| `install` | `[--provider=<providers>]` `[--global]` `[--dry-run]` `[--skip-skills]` `[--skip-agents]` `[--skip-mcp]` |
| `install-agents` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |
| `install-skills` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |

---

## Worker management

Recovery and debug commands for managing worker agents directly. In normal
operation, the coordinator spawns and manages workers automatically — these
commands are for when you need to intervene manually.

| Command | Description |
|---------|-------------|
| `register-worker <id>` | Manually create a worker agent record. |
| `start-worker-session <id>` | Launch a headless PTY session for an existing worker. |
| `attach <id>` | Print the tail of a worker's PTY output log (read-only). |
| `control-worker <id>` | Interactive PTY control of a running worker session. |
| `deregister <id>` | Remove an agent registration. Blocks if active claims exist. |
| `worker-remove <id>` | Stop a worker's session and remove it. |
| `worker-gc` | Mark workers with dead PIDs as offline. |
| `worker-clearall` | Remove all offline and stale workers. |
| `worker-status [agent_id]` | Show worker state, active task, and session info. |

**Flags:**

| Command | Flags |
|---------|-------|
| `register-worker` | `<id>` `--provider=codex\|claude\|gemini` `[--role=worker\|reviewer\|scout]` `[--capabilities=<a,b>]` |
| `start-worker-session` | `<id>` `[--provider=codex\|claude\|gemini]` `[--force-rebind]` |
| `worker-remove` | `<id>` `[--keep-session]` |
| `worker-gc` | `[--deregister]` |
| `worker-status` | `[<agent_id>]` `[--json]` |

---

## Task management

Commands for creating, completing, and managing tasks. In normal operation,
the master agent handles task creation and the coordinator handles dispatch.
These are available for manual intervention and debugging.

| Command | Description |
|---------|-------------|
| `task-create` | Register a task from an existing markdown spec in `backlog/`. |
| `task-mark-done <task-ref>` | Mark a task done. Updates spec frontmatter and runtime state. |
| `task-reset <task-ref>` | Reset a task to `todo`, cancelling any active claims. |
| `task-unblock <task-ref>` | Transition a blocked task back to `todo`. |
| `delegate` | Dispatch a task to an available worker agent. |
| `feature-create <ref>` | Create a new feature grouping in the backlog. |

**Flags:**

| Command | Flags |
|---------|-------|
| `task-create` | `--feature=<ref>` `--title=<text>` `[--ref=<slug>]` `[--task-type=implementation\|refactor]` `[--description=<text>]` `[--ac=<criterion>]` `[--depends-on=<task-ref>]` `[--owner=<agent_id>]` `[--required-capabilities=<cap>]` `[--required-provider=<provider>]` |
| `task-mark-done` | `<task-ref>` `[--actor-id=<id>]` |
| `task-reset` | `<task-ref>` `[--actor-id=<id>]` |
| `task-unblock` | `<task-ref>` `[--reason=<text>]` |
| `delegate` | `--task-ref=<feature/task>` `[--target-agent-id=<id>]` `[--task-type=implementation\|refactor]` `[--note=<text>]` |
| `feature-create` | `<ref>` `[--title=<text>]` |

---

## Backlog

Commands for inspecting and repairing the backlog — the set of markdown task
specs in `backlog/` and their runtime state in `.orc-state/backlog.json`.

| Command | Description |
|---------|-------------|
| `backlog-sync` | Repair runtime state from markdown specs. |
| `backlog-sync-check` | Validate specs match runtime state. Exits 1 on mismatch. |
| `backlog-ready` | List tasks eligible for dispatch (todo + deps satisfied). |
| `backlog-blocked` | List blocked tasks with reasons. |
| `backlog-orient` | Print backlog summary: next task seq, features, task counts. |

**Flags:**

| Command | Flags |
|---------|-------|
| `backlog-sync-check` | `[--refs=<ref1,ref2,...>]` |
| `backlog-ready` | `[--json]` |
| `backlog-blocked` | `[--json]` |

---

## Inspection

Commands for digging into active runs and the event stream.

| Command | Description |
|---------|-------------|
| `runs-active` | List in-progress and claimed runs with idle/age metrics. |
| `run-info <run_id>` | Show claim state, task, worktree path, and idle time for a run. |
| `run-expire <run_id>` | Force-expire a claim and requeue the task. |
| `waiting-input` | List runs blocked waiting for master input. |
| `events-tail` | Print the last N events. |
| `events-filter` | Query events by run, agent, or event type. |

**Flags:**

| Command | Flags |
|---------|-------|
| `runs-active` | `[--json]` |
| `run-info` | `<run_id>` `[--json]` |
| `events-tail` | `[--n=<N>]` `[--event=<name>]` `[--json]` |
| `events-filter` | `[--run-id=<id>]` `[--agent-id=<id>]` `[--event=<type>]` `[--last=<N>]` `[--json]` |
| `waiting-input` | `[--json]` |

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
| `report-for-duty` | `--agent-id=<id>` `--session-token=<token>` |
| `run-start` | `--run-id=<id>` `--agent-id=<id>` |
| `run-work-complete` | `--run-id=<id>` `--agent-id=<id>` |
| `run-finish` | `--run-id=<id>` `--agent-id=<id>` |
| `run-fail` | `--run-id=<id>` `--agent-id=<id>` `[--reason=<text>]` `[--code=<code>]` `[--policy=requeue\|block]` |
| `progress` | `--event=<type>` `--run-id=<id>` `--agent-id=<id>` `[--phase=<name>]` `[--reason=<text>]` |
| `run-input-request` | `--run-id=<id>` `--agent-id=<id>` `--question=<text>` `[--timeout-ms=<ms>]` |
| `run-input-respond` | `--run-id=<id>` `--agent-id=<id>` `--response=<text>` `[--actor-id=<id>]` |

---

## Review

Sub-agent reviewers use these to submit findings. The worker that spawns
them uses `review-read` to collect results. Not for human use.

| Command | Description |
|---------|-------------|
| `review-submit` | Submit review outcome (approved or findings) for a run. |
| `review-read` | Retrieve all submitted review findings for a run. |

**Flags:**

| Command | Flags |
|---------|-------|
| `review-submit` | `--run-id=<id>` `--agent-id=<id>` `--outcome=approved\|findings` `--reason=<text>` |
| `review-read` | `--run-id=<id>` `[--json]` |

---

## MCP server

Starts the Model Context Protocol server for tool-based orchestrator access.
Used internally by agent integrations.

| Command | Description |
|---------|-------------|
| `mcp-server` | Start the MCP server. |
