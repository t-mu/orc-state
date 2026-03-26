---
ref: runtime-robustness/59-global-error-handlers
title: "Add unhandledRejection and uncaughtException handlers to coordinator"
status: todo
feature: runtime-robustness
task_type: implementation
priority: high
depends_on: []
---

# Task 59 — Add Global Error Handlers to Coordinator

Independent.

## Scope

**In scope:**
- Register `process.on('unhandledRejection')` and `process.on('uncaughtException')` in the coordinator main function.
- Log the error, emit a diagnostic event, and trigger graceful shutdown.

**Out of scope:**
- Adding error handlers to CLI commands (they already have try-catch + process.exit).
- Adding a new event type — use existing `coordinator_error` if available, or a generic log.
- Changes to the shutdown flow itself.

---

## Context

### Current state

The coordinator has no global handlers for `unhandledRejection` or `uncaughtException`. An unhandled async error in the tick loop or adapter code silently crashes the process without cleanup, leaving orphaned locks and PTY sessions.

### Desired state

Global handlers catch unhandled errors, log them to stderr, emit a diagnostic event to the event store, and trigger the existing `doShutdown()` graceful shutdown path. The coordinator exits cleanly even on unexpected async failures.

### Start here

- `coordinator.ts` — `main()` function, `doShutdown()` function
- `types/events.ts` — check if `coordinator_error` event type exists

**Affected files:**
- `coordinator.ts` — register handlers in `main()`

---

## Goals

1. Must register `unhandledRejection` handler that logs to stderr and calls `doShutdown()`.
2. Must register `uncaughtException` handler that logs to stderr and calls `doShutdown()`.
3. Must not double-shutdown if `doShutdown()` is already in progress (verify existing `shutdownStarted` guard).
4. Must emit a diagnostic event before shutdown if possible (best-effort).
5. Must not interfere with normal SIGINT/SIGTERM shutdown path.

---

## Implementation

### Step 1 — Register handlers in main()

**File:** `coordinator.ts`

After acquiring the coordinator lock and before the first tick, add:

```typescript
process.on('unhandledRejection', (reason) => {
  console.error('[coordinator] unhandled rejection:', reason);
  try {
    appendSequencedEvent(STATE_DIR, {
      event: 'coordinator_stopped',
      reason: `unhandled_rejection: ${String(reason).slice(0, 500)}`,
    });
  } catch { /* best-effort */ }
  doShutdown();
});

process.on('uncaughtException', (err) => {
  console.error('[coordinator] uncaught exception:', err);
  try {
    appendSequencedEvent(STATE_DIR, {
      event: 'coordinator_stopped',
      reason: `uncaught_exception: ${String(err.message).slice(0, 500)}`,
    });
  } catch { /* best-effort */ }
  doShutdown();
});
```

### Step 2 — Verify doShutdown() re-entrance guard

Confirm that `doShutdown()` checks `shutdownStarted` and returns early on subsequent calls. This prevents the SIGINT handler and unhandledRejection handler from racing.

---

## Acceptance criteria

- [ ] Unhandled promise rejection triggers `doShutdown()` and logs to stderr.
- [ ] Uncaught exception triggers `doShutdown()` and logs to stderr.
- [ ] Double-shutdown does not crash (re-entrance guard works).
- [ ] Normal SIGINT/SIGTERM shutdown still works.
- [ ] `npm test` passes.
- [ ] No changes outside `coordinator.ts`.

---

## Tests

Add to `coordinator.test.ts` (or a new `coordinator-error-handlers.test.ts` if coordinator tests don't exist):

```typescript
it('unhandledRejection triggers graceful shutdown', () => { ... });
it('uncaughtException triggers graceful shutdown', () => { ... });
it('double doShutdown() is safe', () => { ... });
```

---

## Verification

```bash
npm test
```
