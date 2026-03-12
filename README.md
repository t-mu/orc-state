# @t-mu/orc-state

Provider-agnostic, file-state orchestration runtime for autonomous coding agents.

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

These commands are no longer part of the normal startup model. They remain available when you need to inspect a worker, recover a stuck registration, or force a manual session rebind.

## Monitoring Commands

```bash
orc status                   # master + worker capacity + active runs
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

## Delegation Safety

- `delegate_task` rejects explicit assignment to agents that already have active claims (`claimed` or `in_progress`).
- Error output includes agent id and active run id.
- Auto-target selection keeps existing behavior.

## Test Entrypoints

Canonical verification commands for this workspace:

```bash
npm run test:orc:mcp
npm run test:orc:unit
npm run test:orc
```

`npm run test:orc:mcp` is the canonical repo-root command for MCP-focused
changes. It runs the orchestrator MCP test files directly with
`orchestrator/vitest.config.mjs`, so contributors do not need npm argument
forwarding or the game test config.

Use `npm run test:orc:unit` for the full orchestrator unit suite, and
`npm run test:orc` when you want orchestrator unit plus e2e coverage from the
workspace root. The repo-root `npm test` command does not run orchestrator MCP
tests.

## Command Binaries

The package exposes a single CLI entry point:

- `orc` — dispatcher for all subcommands (`orc <subcommand> [args...]`)

Run `orc --help` to list all available subcommands.

## Contract Reference

See [contracts.md](./contracts.md) for adapter contract details, worker lifecycle, and state invariants.
