---
ref: general/42-notifications-bulk-clear
title: "42 Notifications Bulk Clear"
status: done
feature: general
task_type: implementation
priority: high
---

## Context

Master notifications accumulate in `.orc-state/master-notify-queue.jsonl` with
no dismiss mechanism. After long sessions or coordinator restarts, stale
notifications pile up and surface repeatedly. This task adds a bulk-clear
command and coordinator startup auto-expiry.

## Acceptance Criteria

1. `orc notifications-clear` CLI command marks all pending (unconsumed)
   notifications as consumed atomically.
2. New MCP tool `clear_notifications()` performs the same operation and is
   callable by the master agent.
3. Coordinator `doStart()` auto-expires notifications older than
   `NOTIFICATION_AUTO_EXPIRE_MS` (default 24h, configurable via
   `orc.config.json`) by marking them consumed — not physically deleting
   (preserves dedup keys for the notification queue).
4. All existing tests pass; new tests cover the CLI and `clearNotifications`
   export.

## Implementation Notes

- `lib/masterNotifyQueue.ts`: add `clearNotifications(stateDir, olderThanMs?)`:
  reads queue under `withLock`, marks all entries (or those older than the
  threshold) `consumed: true`, writes back atomically.
- `cli/notifications-clear.ts`: thin CLI wrapper calling `clearNotifications`.
  Prints count of entries cleared.
- `cli/orc.ts`: register `notifications-clear` in the COMMANDS dispatch table.
- `mcp/handlers.ts`: add `handleClearNotifications(stateDir)`.
- `mcp/tools-list.ts`: add `clear_notifications` tool definition.
- `coordinator.ts` `doStart()`: call `clearNotifications(STATE_DIR, NOTIFICATION_AUTO_EXPIRE_MS)`
  after existing startup logic.

## Files to Change

- `lib/masterNotifyQueue.ts`
- `cli/notifications-clear.ts` (new)
- `cli/orc.ts`
- `mcp/handlers.ts`
- `mcp/tools-list.ts`
- `coordinator.ts`
- `cli/notifications-clear.test.ts` (new)
- `lib/masterNotifyQueue.test.ts`

## Verification

```bash
npm test
orc doctor
orc notifications-clear
```
