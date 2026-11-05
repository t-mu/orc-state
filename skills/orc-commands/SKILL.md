---
name: orc-commands
description: >
  Reference for all orc CLI subcommands, their usage, flags, and common operational
  patterns. Use when you need to run any orchestrator CLI command, reset task/agent
  state, inject input to a worker, or understand the run lifecycle.
argument-hint: "[command name or operation]"
---

# orc commands

Cheat-sheet. Full flags: `docs/cli.md`, or `orc <subcommand> --help` (prints usage, never runs the command).

Every command acts on one registered project. Inside its repository or a worktree the repo selects it; elsewhere pass `--project=<id>` (or set `ORC_PROJECT_ID`). `orc project show` prints the state directory.

## Blessed path

1. `orc start-session` — coordinator + master (TTY).
2. Author tasks: `orc project task create|edit|import` or MCP `create_task`/`update_task`.
3. Dispatch is automatic; the coordinator marks tasks done after merge.
4. Workers: `run-start` → `run-work-complete` → `run-finish`.
5. Inspect: `orc status`, `orc doctor`.

## Inspection

| Command | Use |
|---|---|
| `orc status [--json] [--mine --agent-id=<id>]` / `orc watch` | agents, tasks, claims |
| `orc doctor` / `orc preflight` | state validation / environment check |
| `orc runs-active`, `orc run-info <run_id>`, `orc waiting-input` | runs, one run, pending questions |
| `orc worker-status [<agent_id>]`, `orc sessions [--all]` | worker health; session state (running/recoverable/unknown) |
| `orc events-tail [--n=<N>] [--event=<name>]`, `orc events-filter [--run-id=] [--agent-id=] [--event=] [--last=N]` | event log |
| `orc review-read --run-id=<id>` | submitted reviews, one per reviewer label |
| `orc attach <agent_id\|run_id> [--write]` | tmux session; read-only unless `--write`; Ctrl-b d detaches |
| `orc terminal <provider\|shell> <run_id> [--write] [--once]` | provider terminal or worktree shell (any session type) |

## Tasks and runs (operator / master)

| Command | Effect |
|---|---|
| `orc project task list\|show\|revisions\|export`, `orc project plan list\|show\|import\|export` | read and move task/plan Markdown |
| `orc task-reset <ref>` | any non-`todo` status → `todo`, cancels active claims |
| `orc task-unblock <ref> [--reason=]` | `blocked` → `todo` |
| `orc task-cancel <ref> [--reason=]` | non-terminal → `cancelled` |
| `orc task-mark-done <ref>` | recovery: mark done (coordinator normally does it) |
| `orc run-close <run_id> [--reason=]` | recovery: close a manually merged run, clean its worktree and branch |
| `orc run-expire <run_id>` | force-expire a claim and requeue its task |
| `orc delegate --task-ref=<ref> [--target-agent-id=<id>]` | manual dispatch (recovery; dispatch is automatic) |
| `orc run-input-respond --run-id= --agent-id= --response=` | answer a worker; master session only (`ORC_MASTER_SECRET`) or MCP `respond_input` |
| `orc pr-status <pr_ref> [--wait]`, `pr-diff`, `pr-review`, `pr-merge` | PR mode |

## Worker commands (inside a worker session only)

| Command | Use |
|---|---|
| `orc run-start --run-id= --agent-id=` | required first |
| `orc progress --event=phase_started --phase=<explore\|implement\|review\|complete\|finalize> --run-id= --agent-id=` | phase signal; `--event=heartbeat --note=<text>` sets the `orc watch` line |
| `orc run-work-complete --run-id= --agent-id=` | work and review done; wait for coordinator |
| `orc run-finish --run-id= --agent-id=` | terminal success, after work-complete |
| `orc run-fail --run-id= --agent-id= [--reason=] [--policy=requeue\|block]` | terminal failure (default `requeue`) |
| `orc run-input-request --run-id= --agent-id= --question=<text>` | ask the master; blocks until answered |
| `orc review-submit --run-id= --agent-id=<worker_id> --reviewer=<label> --outcome=<approved\|findings> --reason=` | reviewer sub-agents, with the worker's agent_id |
| `orc memory-wake-up [--wing=]`, `orc memory-record --content=`, `orc memory-search <q>`, `orc memory-status` | memory |

Lifecycle commands need the worker's session secret; outside a worker session they are refused (except `memory-record`).

## Worker cleanup and reset

| Command | Effect |
|---|---|
| `orc worker-remove <id> [--keep-session]` | stop and remove one worker; refused while it holds a claim |
| `orc worker-gc` | remove dead workers without claims (only when no coordinator runs) |
| `orc kill-all [--keep-sessions]` | stops the coordinator, stops all sessions, resets active tasks, removes run worktrees |

`kill-all` is a full reset: never run it in a loop or script.

## Restart

- Coordinator only: `orc start-session` → "Terminate and restart coordinator". tmux workers are adopted.
- Full reset: `orc kill-all`, then `orc start-session`.
- Never `ps | grep | kill`: it hits every project's coordinator. Stuck states: `docs/recovery.md`.

## Run lifecycle

```
claim_created → run_started → phase_started… → work_complete → run_finished | run_failed
```

Lease renewal is automatic. A dead session is expired (`claim_expired`) and its task requeued. Events: `docs/contracts.md`.
