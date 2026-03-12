---
ref: orch/task-106-coordinator-double-read-fix
epic: orch
status: done
---

# Task 106 — Fix Coordinator Double Event-File Read and Signal Handler Ordering

Independent. Blocks none.

## Scope

**In scope:**
- `coordinator.mjs` — collapse two `readEvents`/`readEventsSince` calls into one pass; move signal handler registration before the first `await tick()`

**Out of scope:**
- Changes to `eventLog.mjs`, `runActivity.mjs`, or any other library
- Changes to coordinator CLI flags or interval logic

## Context

In `tick()` (lines 372–381), when new events exist the coordinator performs two sequential reads of the same file:

```js
const allEvents = readEvents(EVENTS_FILE);           // read #1 — full scan
const newEvents = readEventsSince(EVENTS_FILE, lastProcessedSeq);  // read #2 — partial scan
latestActivityByRun = latestRunActivityMap(allEvents);
processTerminalRunEvents(newEvents);
```

Both `readEvents` and `readEventsSince` open the file independently. Between the two reads, a worker could append a new event — `allEvents` and `newEvents` are then inconsistent (they describe different file states). The fix is to read once and derive both views from the same in-memory array.

A second issue: signal handlers (`SIGINT`/`SIGTERM`) are registered at line 584, *after* `await tick()` at line 572. A signal delivered during the first tick (which can take seconds) is not caught — the process exits unclean with no lock release. Handlers must be registered before the first `await tick()`.

**Affected files:**
- `coordinator.mjs` — tick event-read logic and main() signal handler ordering

## Goals

1. Must read `EVENTS_FILE` exactly once per tick when `currentSeq > lastProcessedSeq`.
2. Must derive `allEvents` and `newEvents` from the same in-memory result without a second file open.
3. Must register `SIGINT` and `SIGTERM` handlers before the first `await tick()` call in `main()`.
4. Must not change any observable coordinator behaviour other than fixing the race.

## Implementation

### Step 1 — Collapse double read in tick()

**File:** `coordinator.mjs`

```js
// Before:
const allEvents = readEvents(EVENTS_FILE);
const newEvents = readEventsSince(EVENTS_FILE, lastProcessedSeq);
latestActivityByRun = latestRunActivityMap(allEvents);
processTerminalRunEvents(newEvents);

// After:
const allEvents = readEvents(EVENTS_FILE);
const newEvents = allEvents.filter((e) => (e.seq ?? 0) > lastProcessedSeq);
latestActivityByRun = latestRunActivityMap(allEvents);
processTerminalRunEvents(newEvents);
```

Remove the `readEventsSince` import from the top of the file if it becomes unused after this change.

### Step 2 — Move signal handlers before first tick

**File:** `coordinator.mjs`

```js
// In main(), before:   await tick();
// Add:
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// Remove the duplicate registrations at the bottom of main()
```

The `shutdown` function references `doShutdown` which is already defined before `main()`, so hoisting the registrations is safe.

## Acceptance criteria

- [ ] `readEventsSince` is no longer called inside the tick event-processing block (or is removed entirely if unused elsewhere).
- [ ] `newEvents` is derived by filtering the in-memory `allEvents` array.
- [ ] `SIGINT` and `SIGTERM` handlers are registered before the `await tick()` call in `main()`.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `orchestrator/coordinator.test.mjs` (existing or new)

```js
it('processTerminalRunEvents is not called with a stale event slice', () => {
  // Verify that the tick reads events once and filters in-memory
  // (unit test via spying on readEvents — confirm called once, not twice)
});
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```
