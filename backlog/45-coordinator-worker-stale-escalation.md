---
ref: general/45-coordinator-worker-stale-escalation
title: "45 Coordinator Worker Stale Escalation"
status: done
feature: general
task_type: implementation
priority: high
depends_on:
  - general/44-worker-needs-attention-event-type
---

## Context

When a worker run goes idle past the nudge window without recovering, the
coordinator currently waits silently for the full 30-min lease to expire. This
means a worker stuck on a quota screen or frozen PTY costs 30 minutes per run
and gives master no signal about why.

This task adds a second escalation threshold in `enforceInProgressLifecycle`:
after the nudge has fired AND the run remains idle past `RUN_INACTIVE_ESCALATE_MS`
(default 15 min), the coordinator emits a `worker_needs_attention` event and
records the escalation via `claim.escalation_notified_at` (set by
`setEscalationNotified`) so it survives coordinator restarts.

## Acceptance Criteria

1. Coordinator emits `worker_needs_attention` exactly once per run, only
   after:
   - `idle_ms >= RUN_INACTIVE_ESCALATE_MS` (default 15 min), AND
   - The nudge has already fired for this run (`runInactiveNudgeAtMs` has an
     entry), AND
   - `claim.escalation_notified_at` is null/undefined.
2. `claim.escalation_notified_at` is set via `setEscalationNotified` after
   emitting — escalation does not re-fire on subsequent ticks or coordinator
   restarts.
3. `worker_needs_attention` remains aligned with task 44 and task 55:
   - the durable event payload stays `{ reason: 'stale', idle_ms: number }`
   - do not add `pty_tail` to the event payload or reintroduce PTY-forwarded
     notifications
   - if PTY tail is still needed later, it must be handled in a separate,
     explicitly scoped follow-up task
4. `RUN_INACTIVE_ESCALATE_MS` is a configurable int-flag constant in
   coordinator, defaulting to 15 minutes, alongside the existing
   `RUN_INACTIVE_NUDGE_MS` and `RUN_INACTIVE_TIMEOUT_MS`.
5. Do not reintroduce PTY-forwarded or queue-backed master notifications.
   The `worker_needs_attention` event is surfaced to master via
   `get_notifications`; no PTY formatting is needed.
6. Unit tests cover: escalation fires after nudge + idle threshold; escalation
   does not fire before nudge; escalation does not re-fire on second tick;
   escalation does not re-fire after coordinator restart (claim already has
   `escalation_notified_at`).
7. All existing tests pass.

## Implementation Notes

- In `enforceInProgressLifecycle`, escalation check runs after the existing
  nudge block, not in parallel with it.
- The escalation must be skipped for claims in finalization states
  (`awaiting_finalize`, `finalize_rebase_requested`, etc.) — same skip
  conditions as the nudge.

## Files to Change

- `coordinator.ts` — add `RUN_INACTIVE_ESCALATE_MS` and escalation logic in `enforceInProgressLifecycle`
- `coordinator.test.ts` — add escalation unit tests

**Do NOT reintroduce:** PTY-forwarded notifications, queue-backed notification state, or `pty_tail` in the durable event payload.

## Verification

```bash
npm test
orc doctor
```
