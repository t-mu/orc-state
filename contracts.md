# Orchestrator Contracts

This document defines the runtime and integration contracts for `orc-state`.

## Core State Files

The orchestrator reads/writes JSON state under `ORC_STATE_DIR` (default `<repo-root>/.orc-state`):

- `backlog.json`
- `agents.json`
- `claims.json`
- `events.db`

## Session Ownership and Operator Model

- Master runs in the operator's foreground terminal session.
- Workers run as headless PTY sessions managed by the coordinator.
- Worker PTY sessions launch inside their assigned run worktree, while shared orchestrator state stays anchored to the canonical repo root.
- `orc start-session` is the master entrypoint; it does not open worker foreground shells.
- `orc start-worker-session` requests/repairs headless worker runtime state.
- `orc attach <agent_id>` attaches to a worker's background PTY output.

## Session Handles

Worker and master session handles use the format `pty:<agent_id>`.

Examples:
- `pty:master`
- `pty:orc-1`
- `pty:worker-01`

The handle identifies a local PTY process owned by the coordinator.
Handles are adapter-defined but deterministic in the active PTY runtime.
If a worker or master session is restarted, the coordinator recreates the PTY and
rewrites the corresponding `session_handle` in `agents.json`.

### Cross-process session probing

Session history is not orchestrator state. The PTY adapter persists only process
metadata and streamed output:

- `pty-pids/<agent_id>.pid` for cross-process heartbeat probing
- `pty-logs/<agent_id>.log` for attach/log-tail workflows

When `heartbeatProbe` is called from a separate process, the PTY adapter checks
the recorded PID rather than consulting provider API credentials or response
history. `orc-attach` reads the PTY log file for background sessions.

## Adapter Interface

All adapters must implement:

- `start(agentId, config) -> Promise<{ session_handle, provider_ref }>`
- `send(sessionHandle, text) -> Promise<string>`
- `attach(sessionHandle) -> void`
- `heartbeatProbe(sessionHandle) -> Promise<boolean>`
- `stop(sessionHandle) -> Promise<void>`

### Method Semantics

1. `start()`
- Initializes a provider CLI PTY session.
- Accepts `config.system_prompt` and optional provider settings (for example `model`).

2. `send()`
- Sends one prompt or command envelope into the session.
- In the active PTY runtime, worker lifecycle is reported through `orc run-*`
  commands executed inside the worker session, not by parsing structured lines
  out of response text.
- Throws on unknown session handle or delivery failure.

3. `attach()`
- Attaches to the session's PTY output stream or log-backed view.
- Prints `(no messages yet)` when no PTY output has been recorded yet.

4. `heartbeatProbe()`
- Returns `true` when the PTY process is alive.
- Returns `false` when the PTY is unreachable or the recorded PID is stale.

5. `stop()`
- Deletes in-memory session state for the handle.
- No-op if handle does not exist.

## Provider Support

| Provider | Adapter name | Runtime prerequisite |
|----------|--------------|----------------------|
| Claude   | `claude`     | `claude` CLI installed and authenticated |
| Codex    | `codex`      | `codex` CLI installed and authenticated |
| Gemini   | `gemini`     | `gemini` CLI installed and authenticated |

## Worker Contract

When a worker receives `TASK_START`, it should:

1. Call `orc run-start` immediately.
2. Call `orc run-heartbeat` during long-running work.
3. Call `orc run-finish` on success.
4. Call `orc run-fail --reason=...` on unrecoverable failure.
5. Call `orc run-input-request` when master input is needed to unblock an interactive prompt.

Workers run as headless PTY CLI sessions owned by the coordinator. The active
runtime contract is shell-command based: lifecycle events are written to shared
state through the `orc run-*` CLIs, not embedded in assistant response text.

Stale runs are recovered by coordinator lease expiry and heartbeat checks. A
worker that is still active should continue reporting with `orc run-heartbeat`;
otherwise the coordinator may expire the claim and requeue or block the task.

## CLI Compatibility

- `orc progress` remains available for human/manual workflows.
- PTY workers should use `orc run-start`, `orc run-heartbeat`, `orc run-finish`,
  and `orc run-fail`.

## Dispatch and Claims

Coordinator lifecycle model:

1. Claim task (`todo -> claimed`) via `claimTask()`.
2. Dispatch task envelope to an eligible worker via adapter `send()`.
3. Worker reports lifecycle via `orc run-*` commands against shared state.
4. Complete run via `run_finished` / `run_failed` events.
5. Lease expiration and inactivity protections remain enforced by claim manager and coordinator timeouts.

## Public Binaries

Installed package binary: `orc`

Subcommands:

- `orc status`
- `orc runs-active`
- `orc events-tail`
- `orc doctor`
- `orc preflight`
- `orc watch`
- `orc init`
- `orc progress`
- `orc task-create`
- `orc delegate`
- `orc attach`
- `orc start-session`
- `orc register-worker`
- `orc start-worker-session`
- `orc worker-gc`
- `orc worker-clearall`
- `orc worker-remove`
- `orc run-start`
- `orc run-heartbeat`
- `orc run-finish`
- `orc run-fail`
- `orc kill-all`

## Invariants

- At most one active claim (`claimed` or `in_progress`) per `task_ref`.
- Claim `agent_id` must reference an existing agent.
- Claim `task_ref` must reference an existing backlog task.
- Event objects must satisfy `schemas/event.schema.json` plus runtime invariants in `lib/eventValidation.mjs`.
