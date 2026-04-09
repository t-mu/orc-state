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

**Flags**

| Command | Flags |
|---------|-------|
| `start-session` | `[--provider=claude\|codex\|gemini]` `[--agent-id=<id>]` |
| `kill-all` | `[--keep-sessions]` |
| `init` | `[--provider=<providers>]` `[--feature=<ref>]` `[--feature-title=<title>]` `[--skip-skills]` `[--skip-agents]` `[--skip-mcp]` `[--force]` |

## Task management

| Command | Description |
|---------|-------------|
| `task-create` | Register a task whose markdown spec already exists in `backlog/`. |
| `task-mark-done <task-ref>` | Mark a task done, updating its spec frontmatter and runtime state. |
| `task-reset <task-ref>` | Reset a task back to `todo`, cancelling any active claims. |
| `task-unblock <task-ref>` | Transition a blocked task back to `todo`. |
| `delegate` | Assign and dispatch a task to a worker agent. |
| `feature-create <ref>` | Create a new feature grouping in the backlog. |
| `backlog-sync` | Sync all backlog markdown specs into runtime state. |
| `backlog-sync-check` | Verify that runtime state matches the backlog markdown specs. |

**Flags**

| Command | Flags |
|---------|-------|
| `task-create` | `--feature=<ref>` `--title=<text>` `[--ref=<slug>]` `[--task-type=implementation\|refactor]` `[--description=<text>]` `[--ac=<criterion>]` `[--depends-on=<task-ref>]` `[--owner=<agent_id>]` `[--required-capabilities=<cap>]` `[--required-provider=<provider>]` `[--actor-id=<id>]` |
| `task-mark-done` | `<task-ref>` `[--actor-id=<id>]` |
| `task-reset` | `<task-ref>` `[--actor-id=<id>]` |
| `task-unblock` | `<task-ref>` `[--reason=<text>]` |
| `delegate` | `--task-ref=<feature/task>` `[--target-agent-id=<id>]` `[--task-type=implementation\|refactor]` `[--note=<text>]` `[--actor-id=<id>]` |
| `feature-create` | `<ref>` `[--title=<text>]` |
| `backlog-sync-check` | `[--refs=<ref1,ref2,...>]` |

## Worker lifecycle

> **Note:** These commands are called by worker agents from inside their PTY sessions, not by human operators. They are documented here for completeness and debugging.

| Command | Description |
|---------|-------------|
| `run-start` | Acknowledge task start; transitions claim to `in_progress`. |
| `report-for-duty` | Worker announces readiness and requests its first task. |
| `run-heartbeat` | Protocol signal emitted at key lifecycle points (before reviewers, rebase, work-complete). |
| `run-work-complete` | Signal that implementation, review, and rebase are done. |
| `run-finish` | Terminal success signal. Ends the run. |
| `run-fail` | Terminal failure signal. Optionally requeues or blocks the task. |
| `progress` | Emit a lifecycle event (phase started/finished, custom events). |
| `run-input-request` | Worker asks the master a blocking question. |
| `run-input-respond` | Master answers a worker's pending input request. |

**Flags**

| Command | Flags |
|---------|-------|
| `run-start` | `--run-id=<id>` `--agent-id=<id>` |
| `report-for-duty` | `--agent-id=<id>` `--session-token=<token>` |
| `run-heartbeat` | `--run-id=<id>` `--agent-id=<id>` |
| `run-work-complete` | `--run-id=<id>` `--agent-id=<id>` |
| `run-finish` | `--run-id=<id>` `--agent-id=<id>` |
| `run-fail` | `--run-id=<id>` `--agent-id=<id>` `[--reason=<text>]` `[--code=<code>]` `[--policy=requeue\|block]` |
| `progress` | `--event=<type>` `--run-id=<id>` `--agent-id=<id>` `[--phase=<name>]` `[--reason=<text>]` `[--policy=requeue\|block]` |
| `run-input-request` | `--run-id=<id>` `--agent-id=<id>` `--question=<text>` `[--timeout-ms=<ms>]` `[--poll-ms=<ms>]` |
| `run-input-respond` | `--run-id=<id>` `--agent-id=<id>` `--response=<text>` `[--actor-id=<id>]` |

### Review commands

> **Note:** These commands are used by sub-agent reviewers and the worker that spawns them, not by human operators.

| Command | Description |
|---------|-------------|
| `review-submit` | Reviewer submits review findings for a run. |
| `review-read` | Read all submitted review findings for a run. |

**Flags**

| Command | Flags |
|---------|-------|
| `review-submit` | `--run-id=<id>` `--agent-id=<id>` `--outcome=approved\|findings` `--reason=<text>` |
| `review-read` | `--run-id=<id>` `[--json]` |

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
| `run-info <run_id>` | Show details for a specific run. |
| `worker-status [agent_id]` | Show the current status of a specific worker. |
| `waiting-input` | List runs that are blocked waiting for master input. |
| `backlog-ready` | List tasks that are ready to be claimed (all deps satisfied). |
| `backlog-blocked` | List tasks that are currently blocked. |
| `backlog-orient` | Summarize backlog state for planning. |

**Flags**

| Command | Flags |
|---------|-------|
| `status` | `[--json]` `[--mine --agent-id=<id>]` `[--watch\|-w]` `[--interval-ms=<ms>]` `[--once]` |
| `watch` | `[--interval-ms=<ms>]` `[--once]` |
| `runs-active` | `[--json]` |
| `events-tail` | `[--n=<N>]` `[--event=<name>]` `[--json]` |
| `events-filter` | `[--run-id=<id>]` `[--agent-id=<id>]` `[--event=<type>]` `[--last=<N>]` `[--json]` |
| `doctor` | `[--json]` |
| `preflight` | `[--json]` |
| `run-info` | `<run_id>` `[--json]` |
| `worker-status` | `[<agent_id>]` `[--json]` |
| `waiting-input` | `[--json]` |
| `backlog-ready` | `[--json]` |
| `backlog-blocked` | `[--json]` |

## Memory

| Command | Description |
|---------|-------------|
| `memory-status` | Show memory store statistics (drawer count, DB size, FTS5 health). |
| `memory-search <query>` | Full-text search across memory drawers. |
| `memory-wake-up` | Recall essential memories for session context. |
| `memory-record` | Store a new memory in the spatial taxonomy. |

**Flags**

| Command | Flags |
|---------|-------|
| `memory-search` | `<query>` `[--wing=<wing>]` `[--room=<room>]` |
| `memory-wake-up` | `[--wing=<wing>]` `[--budget=<N>]` |
| `memory-record` | `--content=<text>` `[--wing=<wing>]` `[--hall=<category>]` `[--room=<topic>]` `[--importance=<N>]` |

## Worker management

Recovery and debug commands for managing worker agents directly.

> **Note:** These commands are for operator recovery and debugging. They are not part of the normal blessed workflow.

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
| `run-expire <run_id>` | Expire a run whose heartbeat lease has lapsed. |

**Flags**

| Command | Flags |
|---------|-------|
| `register-worker` | `<id>` `--provider=codex\|claude\|gemini` `[--dispatch-mode=<mode>]` `[--role=worker\|reviewer\|scout]` `[--capabilities=<a,b>]` |
| `start-worker-session` | `<id>` `[--provider=codex\|claude\|gemini]` `[--role=worker\|reviewer\|scout]` `[--force-rebind]` |
| `worker-remove` | `<worker_id>` `[--keep-session]` |
| `worker-gc` | `[--deregister]` |

## MCP server

> **Note:** This command starts the Model Context Protocol server used by agent tool integrations, not for direct human use.

| Command | Description |
|---------|-------------|
| `mcp-server` | Start the Model Context Protocol server for tool-based access. |

## Setup

| Command | Description |
|---------|-------------|
| `install` | Install skills, agents, and MCP config for configured providers. Gemini currently only affects runtime config/MCP setup; skill and agent targets are skipped with a warning. |
| `install-agents` | Install agent configuration files for supported provider targets (currently Claude and Codex). |
| `install-skills` | Install skill definitions for supported provider targets (currently Claude and Codex). |

**Flags**

| Command | Flags |
|---------|-------|
| `install` | `[--provider=<providers>]` `[--global]` `[--dry-run]` `[--skip-skills]` `[--skip-agents]` `[--skip-mcp]` |
| `install-agents` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |
| `install-skills` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |

---

## Examples

### First-time setup

```bash
orc init --provider=claude
```

### Start a session

```bash
orc start-session
# or with explicit provider and master agent ID:
orc start-session --provider=claude --agent-id=master
```

### Check system health

```bash
orc status
orc doctor
orc preflight
```

### Delegate a task to a worker

```bash
orc delegate --task-ref=general/42-my-task
# or target a specific agent:
orc delegate --task-ref=general/42-my-task --target-agent-id=worker-1
```

### Reset a stuck task

```bash
orc task-reset general/42-my-task
```

### Inspect active runs and events

```bash
orc runs-active
orc events-tail --n=50
orc events-filter --run-id=run-20260101120000-abcd
```

### Debug a worker

```bash
orc attach worker-1
orc worker-status worker-1
orc control-worker worker-1
```

### Create a feature and task

```bash
orc feature-create my-feature --title="My Feature"
# edit backlog/my-feature-001-do-the-thing.md, then:
orc backlog-sync-check
```

### Search memory

```bash
orc memory-search "database migration"
orc memory-search "auth" --wing=general --room=decisions
orc memory-status
```

### Worker run lifecycle (quick reference)

```bash
orc run-start --run-id=<id> --agent-id=<id>
# ... do work ...
orc run-heartbeat --run-id=<id> --agent-id=<id>
orc run-work-complete --run-id=<id> --agent-id=<id>
orc run-finish --run-id=<id> --agent-id=<id>
```

### Fail a run and block retry

```bash
orc run-fail --run-id=<id> --agent-id=<id> \
  --reason="Cannot resolve merge conflict in config.ts" \
  --policy=block
```
