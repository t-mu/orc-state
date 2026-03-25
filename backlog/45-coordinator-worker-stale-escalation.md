---
ref: general/45-coordinator-worker-stale-escalation
title: "45 Coordinator Worker Stale Escalation"
status: todo
feature: general
task_type: implementation
priority: high
depends_on:
  - general/43-adapter-output-tail-interface
  - general/44-worker-needs-attention-event-type
---

## Context

When a worker run goes idle past the nudge window without recovering, the
coordinator currently waits silently for the full 30-min lease to expire. This
means a worker stuck on a quota screen or frozen PTY costs 30 minutes per run
and gives master no signal about why.

This task adds a second escalation threshold in `enforceInProgressLifecycle`:
after the nudge has fired AND the run remains idle past `RUN_INACTIVE_ESCALATE_MS`
(default 15 min), the coordinator reads the worker's PTY tail via the adapter
interface, emits a `worker_needs_attention` event, and sends a
`WORKER_NEEDS_ATTENTION` master notification. Deduplication is via
`claim.escalation_notified_at` (set by `setEscalationNotified`) so it survives
coordinator restarts.

## Acceptance Criteria

1. Coordinator emits `worker_needs_attention` event and appends a
   `WORKER_NEEDS_ATTENTION` master notification exactly once per run, only
   after:
   - `idle_ms >= RUN_INACTIVE_ESCALATE_MS` (default 15 min), AND
   - The nudge has already fired for this run (`runInactiveNudgeAtMs` has an
     entry), AND
   - `claim.escalation_notified_at` is null/undefined.
2. `claim.escalation_notified_at` is set via `setEscalationNotified` after
   emitting — escalation does not re-fire on subsequent ticks or coordinator
   restarts.
3. The `WORKER_NEEDS_ATTENTION` notification payload includes:
   `{ agent_id, run_id, task_ref, pty_tail: string, idle_ms: number }`.
   `pty_tail` comes from `adapter.getOutputTail(sessionHandle)` — empty string
   if adapter returns null or session handle is unavailable.
4. `RUN_INACTIVE_ESCALATE_MS` is a configurable int-flag constant in
   coordinator, defaulting to 15 minutes, alongside the existing
   `RUN_INACTIVE_NUDGE_MS` and `RUN_INACTIVE_TIMEOUT_MS`.
5. `lib/masterPtyForwarder.ts` `formatNotifications()` handles
   `WORKER_NEEDS_ATTENTION`: formats a human-readable block showing agent ID,
   task ref, idle duration, and PTY tail (truncated to 800 chars for PTY
   display).
6. Unit tests cover: escalation fires after nudge + idle threshold; escalation
   does not fire before nudge; escalation does not re-fire on second tick;
   escalation does not re-fire after coordinator restart (claim already has
   `escalation_notified_at`).
7. All existing tests pass.

## Implementation Notes

- In `enforceInProgressLifecycle`, escalation check runs after the existing
  nudge block, not in parallel with it.
- Use `createAdapter(agent.provider)` to get the adapter instance (same pattern
  as existing coordinator code); call `adapter.getOutputTail(agent.session_handle)`.
- The escalation must be skipped for claims in finalization states
  (`awaiting_finalize`, `finalize_rebase_requested`, etc.) — same skip
  conditions as the nudge.

## Files to Change

- `coordinator.ts`
- `lib/masterPtyForwarder.ts`
- `lib/masterPtyForwarder.test.ts`
- `coordinator.test.ts`

## Verification

```bash
npm test
orc doctor
```
