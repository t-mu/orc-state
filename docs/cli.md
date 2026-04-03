# CLI reference

All commands are invoked as `orc <subcommand> [args...]`.
Run `orc --help` for the full list.

---

## Session management

| Command | Description |
|---------|-------------|
| `start-session` | Start the coordinator and master agent session (requires TTY). |
| `kill-all` | Stop the coordinator and deregister all agents. Full reset. |
| `init` | Interactive first-time setup: provider selection, state initialization, and install of supported skills/agents/MCP config. |

## Task management

| Command | Description |
|---------|-------------|
| `task-create` | Register a task whose markdown spec already exists in `backlog/`. |
| `task-mark-done <task-ref>` | Mark a task done, updating its spec frontmatter and runtime state. |
| `task-reset <task-ref>` | Reset a task back to `todo`, cancelling any active claims. |
| `task-unblock <task-ref>` | Transition a blocked task back to `todo`. |
| `delegate` | Assign and dispatch a task to a worker agent. |
| `feature-create` | Create a new feature grouping in the backlog. |
| `backlog-sync` | Sync all backlog markdown specs into runtime state. |
| `backlog-sync-check` | Verify that runtime state matches the backlog markdown specs. |

## Worker lifecycle

These commands are emitted by workers from inside their PTY sessions.

| Command | Description |
|---------|-------------|
| `run-start` | Acknowledge task start; transitions claim to `in_progress`. |
| `report-for-duty` | Worker announces readiness and requests its first task. |
| `run-heartbeat` | Extend the claim lease (must fire at least every 5 minutes). |
| `run-work-complete` | Signal that implementation, review, and rebase are done. |
| `run-finish` | Terminal success signal. Ends the run. |
| `run-fail` | Terminal failure signal. Optionally requeues or blocks the task. |
| `progress` | Emit a lifecycle event (phase started/finished, custom events). |
| `run-input-request` | Worker asks the master a blocking question. |
| `run-input-respond` | Master answers a worker's pending input request. |
| `review-submit` | Reviewer submits review findings for a run. |
| `review-read` | Read all submitted review findings for a run. |

## Monitoring

| Command | Description |
|---------|-------------|
| `status` | Print the agent, task, and claim summary table. |
| `watch` | Live-refresh status dashboard (TUI). |
| `runs-active` | List all in-progress and claimed runs. |
| `events-tail` | Tail the event stream. |
| `events-filter` | Query the event stream with filters. |
| `doctor` | Validate state files and check provider keys/binaries. |
| `preflight` | Lightweight environment health check. |
| `run-info` | Show details for a specific run. |
| `worker-status` | Show the current status of a specific worker. |
| `waiting-input` | List runs that are blocked waiting for master input. |
| `backlog-ready` | List tasks that are ready to be claimed (all deps satisfied). |
| `backlog-blocked` | List tasks that are currently blocked. |
| `backlog-orient` | Summarize backlog state for planning. |

## Worker management

Recovery and debug commands for managing worker agents directly.

| Command | Description |
|---------|-------------|
| `register-worker <id>` | Register a new worker agent with a given provider. |
| `start-worker-session <id>` | Launch a headless PTY session and bootstrap a worker. |
| `attach <id>` | Print the tail of a worker's PTY output log (read-only). |
| `control-worker <id>` | Inspect a running worker session. |
| `deregister <id>` | Remove a specific agent registration. |
| `worker-remove <id>` | Stop a worker's session and deregister it. |
| `worker-gc` | Mark stale workers as offline. |
| `worker-clearall` | Remove all offline and stale workers. |
| `run-expire` | Expire a run whose heartbeat lease has lapsed. |

## MCP server

| Command | Description |
|---------|-------------|
| `mcp-server` | Start the Model Context Protocol server for tool-based access. |

## Setup

| Command | Description |
|---------|-------------|
| `install` | Install skills, agents, and MCP config for configured providers. Gemini currently only affects runtime config/MCP setup; skill and agent targets are skipped with a warning. |
| `install-agents` | Install agent configuration files for supported provider targets (currently Claude and Codex). |
| `install-skills` | Install skill definitions for supported provider targets (currently Claude and Codex). |
