# @t-mu/orc-state

Provider-agnostic, file-state orchestration runtime for autonomous coding agents.

## Requirements

- **Node.js ≥ 24** (uses `--experimental-strip-types`; no build step)
- **Native build tools** — `node-pty` compiles a native addon on install.
  On macOS: Xcode Command Line Tools (`xcode-select --install`).
  On Linux: `build-essential` + `python3`.

## Runtime Model

- State is file-backed under `ORCH_STATE_DIR`: `backlog.json`, `agents.json`, `claims.json`, `events.jsonl`.
- The coordinator dispatches `todo` tasks (`planning_state=ready_for_dispatch`) to eligible workers.
- Worker sessions are owned by the coordinator and run as headless PTY processes via `node-pty`.
- Worker execution capacity comes from coordinator-managed worker-pool config, not from manually counting pre-registered headless workers.
- Worker PTY sessions launch inside their assigned run worktree; shared `.orc-state` still resolves from the canonical repo root.
- Workers report lifecycle through the `orc run-start`, `orc run-heartbeat`,
  `orc run-finish`, and `orc run-fail` CLIs executed inside their session.
- Master session is started in the foreground and also uses PTY.
- Master completion notifications are delivered through `masterPtyForwarder`:
  - Coordinator deposits completion notices into `master-notify-queue.jsonl`.
  - Forwarder reads pending notices and injects `[ORCHESTRATOR] TASK_COMPLETE` blocks into the master PTY when idle/prompt-ready.

## Provider Support

Supported providers:

- `claude`
- `codex`
- `gemini`

Provider startup behavior for master sessions:

- `claude`: bootstrap via system prompt path used by `start-session`.
- `codex`: bootstrap passed as `--instructions`.
- `gemini`: bootstrap passed as `--system-instruction` with `--mcp-config`.

Forwarder prompt detection and submit behavior are provider-aware (pattern + submit sequence per provider).

## Provider Authentication

Provider CLIs handle their own authentication. The orchestrator runtime does
not require direct provider credential environment variables as a health gate.
For normal PTY sessions, the important prerequisite is that the provider CLI
binary is installed and already authenticated on the machine.

Worker-pool config supports these optional overrides:

| Setting | Env var | Default |
|----------|---------|---------|
| Max managed worker slots | `ORC_MAX_WORKERS` | `0` |
| Default worker provider | `ORC_WORKER_PROVIDER` | `codex` |
| Default worker model | `ORC_WORKER_MODEL` | unset |

You can also persist the same values in `ORCH_STATE_DIR/orchestrator.config.json`:

```json
{
  "worker_pool": {
    "max_workers": 2,
    "provider": "claude",
    "model": "claude-sonnet-4-6"
  }
}
```

Environment variables override the config file. The coordinator materializes
stable slot IDs `orc-1` through `orc-N` from this config. The foreground master
remains a separate role and does not count against `max_workers`.

## Quick Start

## Blessed Paths

The normal operator/agent workflow is:

1. Start the system with `orc start-session`.
2. Create or edit the markdown spec in `backlog/`.
3. Register or sync that spec into runtime state.
4. Delegate the task.
5. Worker reports `run-start` -> `run-heartbeat` -> `run-work-complete` -> `run-finish`.
6. Use `orc status` / `orc doctor` / `orc backlog-sync-check` as the normal inspection path.

Outside the blessed workflow, there are three secondary categories:

- Supported inspection commands for observability.
- Advanced / specialized commands for setup or niche workflows.
- Recovery/debug commands for exceptional cases.

`orc start-session` runs in three phases:

1. Coordinator: reuse the running coordinator or start a new one.
2. Master session: reuse, replace, or register the single foreground master.
3. Foreground launch: start the master provider CLI in your current terminal.

Important:

- `MASTER` and `WORKERS` are different registration paths.
- The master provider is selected for the foreground planner/delegator in your terminal.
- Headless workers are coordinator-managed background capacity launched per task.
- Manual worker commands are debug/recovery tools, not the standard startup flow.
- Do not use worker commands to create a master. Use `orc start-session` for the master only.

1. Start the master session (foreground) and coordinator:

```bash
orc start-session --provider=claude
```

This is the normal operator entry point. It prepares the coordinator, ensures the foreground master is configured, and launches the master in the current terminal. Worker capacity comes from coordinator config; the coordinator launches and tears down headless worker sessions per task.

2. Configure background worker capacity before startup, or restart the coordinator after changing it:

Set worker-pool capacity through environment or `orchestrator.config.json` before running `orc start-session`:

```bash
export ORC_MAX_WORKERS=2
export ORC_WORKER_PROVIDER=codex
export ORC_WORKER_MODEL=gpt-5-codex
```

or:

```json
{
  "worker_pool": {
    "max_workers": 2,
    "provider": "codex",
    "model": "gpt-5-codex"
  }
}
```

3. Use manual worker commands only for debugging or recovery:

```bash
orc register-worker orc-1 --provider=claude
orc start-worker-session orc-1
orc control-worker orc-1
```

These commands are not part of the blessed workflow. They remain available when you need to inspect a worker, recover a stuck registration, or force a manual session rebind.

## Monitoring Commands

```bash
orc status                   # master + worker capacity + active runs
orc watch                    # live-refresh status display
orc runs-active              # currently active runs
orc events-tail              # tail events.jsonl
orc master-check             # check pending master notifications
```

`orc status` is now capacity-first:

- `Master` shows the single foreground controller session.
- `Worker Capacity` shows configured slot count, used slots, available slots, warming slots, unavailable slots, and dispatch-ready work waiting for capacity.
- `Active Runs` shows the run ids currently consuming slots, including idle/stalled timing.
- `Finalization` shows runs in `awaiting_finalize`, `finalize_rebase_requested`,
  `finalize_rebase_in_progress`, `ready_to_merge`, and `blocked_finalize`.
  Blocked finalization is preserved work, not generic implementation failure.
  Status output includes retry counts plus any preserved branch/worktree metadata
  still tracked in `run-worktrees.json`.
- `Recent Failures` highlights recent `session_start_failed`, `blocked`, and `run_failed` events that need operator attention.

Do not interpret the absence of idle background worker sessions as a fault. In
the per-task model, idle capacity means free worker slots, not always-on worker
PTYs sitting at a shell prompt.
If more tasks are ready than available slots, the extra work stays queued in
the backlog until a running slot finishes and the coordinator launches the next
task-scoped worker session.

`orc master-check` prints any unconsumed TASK_COMPLETE notifications that the master PTY forwarder has not yet delivered.

## Backlog Spec Authority

`backlog/` is the authoritative source for backlog task metadata.
The runtime `.orc-state/backlog.json` is the dispatch mirror used by the coordinator.

- Blessed path:
  1. write or edit the markdown spec in `backlog/`
  2. register/sync it into runtime state
  3. run `orc backlog-sync-check`
- `orc backlog-sync-check` validates that active markdown specs and runtime state agree.
- `orc backlog-sync` repairs runtime backlog metadata from markdown specs.
- `backlog/legacy/` is excluded from active backlog validation and repair.
- Runtime-owned live execution fields still win while a task is `claimed` or `in_progress`.

## Worker Lifecycle

Workers are PTY-driven provider CLI sessions, not an API response parser. The
active worker contract is:

```bash
orc run-start --run-id=<id> --agent-id=<id>
orc run-heartbeat --run-id=<id> --agent-id=<id>
orc run-finish --run-id=<id> --agent-id=<id>
orc run-fail --run-id=<id> --agent-id=<id> --reason="..."
```

The coordinator reacts to those shared-state updates on subsequent ticks.
`orc status` focuses on slot capacity and active runs, while worker liveness is
still preserved internally for coordinator recovery/debugging.

Blessed worker path:

1. `orc run-start`
2. `orc run-heartbeat` while active
3. `orc run-work-complete` after implementation/review/rebase
4. `orc run-finish` only after the work-complete handoff

Recovery/debug paths such as manual worker session control are not part of the normal agent workflow.

## Finalization Ownership

After a worker emits `orc run-work-complete`, the run stays `in_progress` and
enters the coordinator-owned finalization phase.

- The worker stays attached to the same worktree/session and may be asked to
  rebase onto the latest `main` again.
- The coordinator owns the trusted merge attempt and post-merge cleanup.
- If merge cannot proceed, the coordinator sends `FINALIZE_REBASE` back to the
  same live worker session.
- If finalization blocks, the branch/worktree metadata is preserved and surfaced
  in status output for operator follow-up.

Blocked finalization is preserved work waiting for intervention. It is not the
same thing as rejecting or discarding the task result.

Blessed finalization path:

- worker stops at `run-work-complete`
- coordinator owns merge/finalization
- worker only continues if the coordinator asks for follow-up in the same session

If the coordinator requests `FINALIZE_REBASE`, the worker should first emit
`orc progress --event=finalize_rebase_started --run-id=<id> --agent-id=<id>`,
perform the rebase work in the same worktree, then emit
`orc run-work-complete` again.

Do not treat manual merge or manual worktree cleanup as a normal path.

## MCP Server

The package ships an MCP server over stdio at `mcp/server.ts`.

Start it by pointing `ORCH_STATE_DIR` at the orchestrator state directory:

```bash
ORCH_STATE_DIR=/path/to/project/.orc-state node --experimental-strip-types mcp/server.ts
```

Resources:

- `orchestrator://state/backlog` — full `backlog.json`
- `orchestrator://state/agents` — full `agents.json`

Available tools:

| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks, optionally filtered by status or feature |
| `list_agents` | List registered agents |
| `list_active_runs` | List active task claims |
| `list_stalled_runs` | List active claims missing heartbeats |
| `get_task` | Get one task by ref |
| `get_recent_events` | Return recent orchestrator events |
| `get_status` | Return a compact orchestrator status snapshot |
| `get_agent_workview` | Return one agent's actionable work summary |
| `create_task` | Create a backlog task |
| `update_task` | Update mutable task fields |
| `delegate_task` | Assign a task to a worker |
| `cancel_task` | Cancel a task and remove active runs |
| `respond_input` | Respond to a worker input request |
| `get_run` | Get one run with merged task/worktree details |
| `list_waiting_input` | List runs waiting for master input |
| `query_events` | Query the event log with filters |
| `reset_task` | Reset a task to `todo` and cancel active claims |
| `list_worktrees` | List registered run worktrees |

Provider notes:

- `claude`: `orc start-session` writes an MCP config file and launches the master with `--mcp-config`.
- `codex`: `orc start-session` passes the master bootstrap via `--instructions`; Codex MCP wiring is not auto-managed by this package.
- `gemini`: `orc start-session` writes an MCP config file and launches the master with `--mcp-config` plus `--system-instruction`.

## Delegation Safety

- `delegate_task` rejects explicit assignment to agents that already have active claims (`claimed` or `in_progress`).
- Error output includes agent id and active run id.
- Auto-target selection keeps existing behavior.

## Recovery And Debug Paths

These commands remain supported, but they are not part of the normal agent workflow:

- manual worker registration / session start: `orc register-worker`, `orc start-worker-session`
- worker inspection / forced session control: `orc attach`, `orc control-worker`
- task/operator recovery: `orc task-reset`, `orc task-unblock`, `orc worker-gc`, `orc worker-clearall`
- full reset: `orc kill-all`

Use them only for explicit recovery, debugging, or operator intervention.

## Test Entrypoints

Canonical verification commands for this workspace:

```bash
npm test
npm run test:e2e
```

Use `npm test` for the unit/integration suite and `npm run test:e2e` when you
need the e2e coverage as well.

## Command Binaries

The package exposes a single CLI entry point:

- `orc` — dispatcher for all subcommands (`orc <subcommand> [args...]`)

Run `orc --help` to list all available subcommands.

## Contract Reference

See [contracts.md](./contracts.md) for adapter contract details, worker lifecycle, and state invariants.
