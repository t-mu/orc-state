---
ref: general/55-events-as-notification-source
title: "Replace master notify queue with event cursor polling"
status: done
feature: general
task_type: implementation
priority: high
depends_on: []
---

# Task 55 — Replace master notify queue with event cursor polling

## Context

The current master notification system was designed for a PTY-injected master
session: the coordinator formats `[ORCHESTRATOR] TASK_COMPLETE` blocks and
pushes them into the master PTY via `masterPtyForwarder.ts`, backed by a
`master-notify-queue.jsonl` file.

The actual master agent is Claude Code running over MCP — a pull-based interface.
Push-injection never reliably arrives. Notifications pile up, dedup state is lost
on restart, and workers repeatedly trigger INPUT_REQUEST for prompts that Claude
Code auto-accepts anyway (bypass permissions mode).

**Approach B:** The events SQLite DB is already the durable source of truth. All
relevant signals (`task_complete`, `run_failed`, `run_cancelled`,
`worker_needs_attention`, `input_requested`) are already events. The master
should poll events with an `after_seq` cursor instead of consuming a separate
queue. The queue and PTY forwarder become dead code.

## Acceptance Criteria

1. **New MCP tool `get_notifications(after_seq?)`** added to `mcp/handlers.ts`
   and registered in `mcp/server.ts`:
   - Returns events with `event` IN `['task_complete', 'run_failed',
     'run_cancelled', 'worker_needs_attention', 'input_requested',
     'input_response']` and `seq > after_seq` (default 0), ordered by seq ASC.
   - Response shape: `{ notifications: OrcEvent[], last_seq: number }`.
   - `last_seq` is the highest seq returned (or `after_seq` if empty), so the
     caller can pass it back on the next call.
   - Max 200 results per call.

2. **`masterNotifyQueue.ts` write path removed**: coordinator and run handlers
   no longer call `enqueueNotification` or write to
   `.orc-state/master-notify-queue.jsonl`. The file may remain on disk but
   nothing writes to it.

3. **`masterPtyForwarder.ts` neutered**: the `formatNotifications` /
   `forwardPendingNotifications` path becomes a no-op (or the module is deleted
   if it has no other callers). No PTY injection of `[ORCHESTRATOR]` blocks.

4. **Master bootstrap templates updated** — all three files:
   - `templates/master-bootstrap-v1.txt`
   - `templates/master-bootstrap-codex-v1.txt`
   - `templates/master-bootstrap-gemini-v1.txt`

   The NOTIFICATIONS section is rewritten to describe the cursor-polling model:
   - On startup, call `get_notifications()` (no `after_seq`) to catch up on
     any missed events; store the returned `last_seq`.
   - After any significant pause or user interaction, call
     `get_notifications(after_seq=<last_seq>)` and update the cursor.
   - For `task_complete` / `run_failed` / `run_cancelled`: surface to user,
     ask ignore/react.
   - For `worker_needs_attention`: surface agent_id, task_ref, idle_ms and
     offer wait / force-fail / intervene options.
   - For `input_requested`: surface the question; call `respond_input` once
     the user answers.
   - Remove all `[ORCHESTRATOR] TASK_COMPLETE` / `INPUT_REQUEST` block
     descriptions — those were PTY-injection artifacts.

5. **`AGENTS.md` updated** — `orc run-input-request` usage restricted:
   - Only call it for: ambiguous/missing spec requirements that block
     implementation; merge conflicts that are genuinely unresolvable; external
     dependencies unavailable (service down, credential missing).
   - Explicitly NOT for tool permission prompts (bypass permissions handles
     those automatically in Claude Code).

6. **`get_status` response** includes `last_notification_seq` (the seq of the
   most recent notification-class event, or 0 if none) so the master can
   bootstrap its cursor from status alone.

7. **Tests**:
   - Unit test for the `get_notifications` handler: returns correct events,
     respects `after_seq`, returns correct `last_seq`.
   - Existing notification queue tests updated or removed if the queue write
     path is deleted.

8. `orc doctor` exits 0. `npm test` passes.

## Files to Change

- `mcp/handlers.ts` — add `handleGetNotifications`
- `mcp/server.ts` — register new tool
- `coordinator.ts` — remove `enqueueNotification` / `forwardPendingNotifications` calls
- `lib/masterNotifyQueue.ts` — remove write path (keep read for migration if needed)
- `lib/masterPtyForwarder.ts` — make no-op or delete
- `templates/master-bootstrap-v1.txt`
- `templates/master-bootstrap-codex-v1.txt`
- `templates/master-bootstrap-gemini-v1.txt`
- `AGENTS.md`
- Test files for affected modules

## Verification

```bash
npm test
orc doctor
# Confirm no writes to master-notify-queue.jsonl after a task completes:
orc runs-active  # start a task, complete it, check the queue file is unchanged
```
