---
name: worker-inspect
description: >
  Inspect a worker or run's state, progress, output, or stuck status using
  MCP orchestrator tools. Use when asked about a specific worker's health,
  what it is doing, or why it is stuck.
argument-hint: "<agent-id>"
---

# Worker Inspect

Trigger on a named worker or run ("what is X doing?", "is X stuck?", "check run Y"). For overall status with no named worker, call `get_status()` instead.

## Intent → tool

Call one tool; add a second only if the first is insufficient.

| Intent | Call |
|---|---|
| What is X doing / progressing? | `get_agent_workview(agent_id)` → `active_run.current_activity`, `active_run.last_heartbeat_at`, `blockers` |
| Run details, input or finalization state | `get_run(run_id)` → claim fields (`state`, `input_state`, `finalization_state`, `finalization_blocked_reason`, `lease_expires_at`), `worktree_path`, `task_spec_revision_status` |
| Which runs are stalled? | `list_stalled_runs()` (excludes runs waiting for input or running a tool call) |
| Who is waiting for input? | `list_waiting_input()` → `question`, `waiting_seconds` |
| Current phase / recent history | `get_recent_events(agent_id or run_id)` (latest `phase_started`) |
| Raw terminal output | bash `orc terminal provider <run_id> --once`; live tmux session: `orc attach <agent_id>` (needs a TTY) |
| Session state after a coordinator restart | bash `orc sessions` (running / recoverable / unknown) |
| Scout result | `get_scout_report(agent_id)`, then `remove_scout(agent_id)` |

Prefer MCP tools (structured JSON) over bash; use bash only for what has no MCP tool.

## Diagnostic hints

- `input_state: awaiting_input` → the worker is blocked on a question. Tell the user; do not call `respond_input()` on your own.
- `finalization_state: blocked_finalize` → merge failed; read `finalization_blocked_reason`, then see `docs/recovery.md`.
- Agent `status: offline` while its claim is active → the coordinator's liveness probe finds the dead session and requeues the task on its next tick.
- Listed by `list_stalled_runs` with an old `last_heartbeat_at` → no recent progress; check `get_recent_events`, then raw output.
