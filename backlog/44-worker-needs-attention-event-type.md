---
ref: general/44-worker-needs-attention-event-type
title: "44 Worker Needs Attention Event Type"
status: done
feature: general
task_type: implementation
priority: high
---

## Context

The coordinator needs to emit a `worker_needs_attention` event when a worker
run has been idle past the escalation threshold. This task defines the event
type, updates the schema and validation, adds a `escalation_notified_at` field
to claims for persistent deduplication, and adds a `setEscalationNotified`
helper to claimManager.

Note: `pty_tail` is intentionally NOT included in the event payload. It would
create unbounded rows in `events.db` and be indexed by FTS5. The PTY tail is
included only in the master notification (task 45).

## Acceptance Criteria

1. `WorkerNeedsAttentionEvent` exists in `types/events.ts`:
   ```typescript
   event: 'worker_needs_attention'
   run_id: string
   agent_id: string
   task_ref: string
   payload: { reason: 'stale'; idle_ms: number }
   ```
2. `"worker_needs_attention"` is added to the `event` enum in
   `schemas/event.schema.json`. Events with this type pass `validateEventObject`
   without errors.
3. `lib/eventValidation.ts` validates the new event's required fields
   (`run_id`, `agent_id`, `task_ref`, `payload.reason`, `payload.idle_ms`).
4. `Claim` type in `types/claims.ts` gains optional field
   `escalation_notified_at?: string | null`.
5. `lib/claimManager.ts` exports `setEscalationNotified(stateDir, runId)`:
   sets `escalation_notified_at` to the current ISO timestamp on the matching
   claim under `withLock`.
6. All existing tests pass.

## Files to Change

- `types/events.ts`
- `schemas/event.schema.json`
- `lib/eventValidation.ts`
- `types/claims.ts`
- `lib/claimManager.ts`

## Verification

```bash
npm test
orc doctor
```
