# Task 31 — Graceful Coordinator Shutdown (Drain In-Flight API Calls)

High severity robustness fix. Independent — no dependencies on other tasks.

## Scope

**In scope:**
- Rewrite the `shutdown` function in `coordinator.mjs::main()` to drain the current tick
  before calling `process.exit(0)`
- Ensure `coordinator_stopped` is always emitted before exit, even after drain
- Add a test verifying that SIGINT waits for the current tick to complete

**Out of scope:**
- Changing tick logic, dispatch logic, or adapter behaviour
- Setting a hard maximum inflight time (a 30-second fallback is acceptable; anything beyond
  that would indicate a hung adapter — log and exit)
- Changing any other file

---

## Context

The current shutdown handler in `coordinator.mjs`:

```js
function shutdown() {
  log('shutting down…');
  running = false;
  clearInterval(timer);
  emit({ event: 'coordinator_stopped', ... });
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
```

`process.exit(0)` is called synchronously. If `adapter.send()` is currently awaited inside
`tick()`, Node.js abandons the async chain immediately. The response is never processed; the
run remains stuck in `claimed` or `in_progress` until its 30-minute lease expires and gets
requeued. In a busy multi-agent system, a SIGINT on restart can leave several runs requeued
unnecessarily.

The fix uses the existing `ticking` boolean flag. After setting `running = false` and
clearing the timer, we poll `ticking` with a deadline before calling `emit` and `process.exit`.

Signal handlers registered with `process.on('SIGINT', fn)` are called synchronously but
the signal handler itself can be synchronous and start an async drain by storing a Promise
reference — Node's event loop continues running while the drain Promise resolves.

**Affected files:**
- `coordinator.mjs` — rewrite shutdown logic in `main()`

---

## Goals

1. Must set `running = false` immediately on SIGINT/SIGTERM so no new tick starts
2. Must clear the interval timer immediately so no new tick is scheduled
3. Must wait for `ticking` to become `false` before emitting `coordinator_stopped`
4. Must not wait longer than 30 seconds (emit and exit after the deadline regardless)
5. Must emit exactly one `coordinator_stopped` event even when the drain completes cleanly
6. Must not introduce any change to the tick logic or the dispatch path

---

## Implementation

### Step 1 — Extract `doShutdown` as an async function and wire signal handlers

**File:** `coordinator.mjs`

Inside `main()`, replace the existing `shutdown` function and signal handler registration
with the pattern below. The `ticking` variable is already defined in `main()` — reference
it via closure.

**Export `doShutdown` for testability:** `doShutdown` must be exported at the module level
(not guarded by an argv check) so that e2e tests can call it directly instead of sending
OS signals. This is the same ESM export pattern used by other testable coordinator functions.
Export it from `main()` via module-scope assignment or export the function directly.

```js
// Replaces the existing shutdown() + process.on() block:

let shutdownStarted = false;

async function doShutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  log('shutting down — waiting for current tick to complete...');
  running = false;
  clearInterval(timer);

  if (ticking) {
    await new Promise((resolve) => {
      const poll = setInterval(() => {
        if (!ticking) { clearInterval(poll); resolve(); }
      }, 100);
      // Hard deadline: do not wait longer than 30 seconds.
      setTimeout(() => { clearInterval(poll); resolve(); }, 30_000);
    });
  }

  emit({ event: 'coordinator_stopped', actor_type: 'coordinator', actor_id: 'coordinator', payload: {} });
  log('shutdown complete.');
  process.exit(0);
}

function shutdown() { doShutdown().catch((err) => { console.error(err); process.exit(1); }); }

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// Export for e2e test access (allows tests to trigger shutdown without OS signals).
export { doShutdown };
```

Key design points:
- `shutdown()` is synchronous (required by Node signal handler API) but immediately starts
  the async `doShutdown()` and hooks its rejection to `process.exit(1)`.
- `doShutdown()` is idempotent via `shutdownStarted` — double SIGINT does nothing extra.
- The 30-second poll deadline guarantees the process always exits even if the adapter hangs.
- `running = false` is set before the drain, so if the current tick finishes, the timer
  callback that fires next will see `!running` and return immediately.

### Step 2 — Move `coordinator_stopped` emit to inside `doShutdown`

Confirm the existing `emit({ event: 'coordinator_stopped', ... })` inside the old
`shutdown()` function is removed and replaced by the one inside `doShutdown()` above.
There must be exactly one emit of `coordinator_stopped` per shutdown.

---

## Acceptance criteria

- [ ] SIGINT/SIGTERM sets `running = false` synchronously (no new tick is queued)
- [ ] If `ticking` is `false` at shutdown time, coordinator exits within 200 ms
- [ ] If `ticking` is `true`, coordinator waits for the tick to complete before emitting `coordinator_stopped`
- [ ] A hard deadline of 30 seconds prevents indefinite hang if an adapter call hangs
- [ ] Exactly one `coordinator_stopped` event is emitted per shutdown, regardless of drain path
- [ ] Double SIGINT does not emit `coordinator_stopped` twice
- [ ] All existing tests pass
- [ ] No changes to files outside `coordinator.mjs`

---

## Tests

Add to `e2e/orchestrationLifecycle.e2e.test.mjs`:

```js
it('emits coordinator_stopped event on graceful shutdown', async () => {
  // Set up minimal state (empty backlog, one agent, no claims).
  // Import coordinator and call the exported doShutdown() directly.
  // Assert that events.jsonl contains exactly one coordinator_stopped event at the end.
  const { doShutdown } = await import('../../coordinator.mjs');
  await doShutdown();
  // Read events and assert the last event is coordinator_stopped.
});

it('does not start a new tick after running is set to false', async () => {
  // Verify the reentrancy guard + running flag together prevent double-tick on shutdown.
});
```

**Note:** Using the exported `doShutdown()` instead of `process.kill(process.pid, 'SIGINT')`
makes the test deterministic and avoids signal-delivery timing issues in the test runner.

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

Manual smoke check (if running the coordinator locally):

```bash
node coordinator.mjs --mode=autonomous &
COORD_PID=$!
sleep 2
kill -INT $COORD_PID
# Expected: coordinator logs "waiting for current tick to complete..." then "shutdown complete."
# Expected: events.jsonl ends with a coordinator_stopped event
tail -1 orc-state/events.jsonl | node -e "const e=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(e.event);"
# Expected: coordinator_stopped
```

---

## Risk / Rollback

**Risk:** The `doShutdown` async drain relies on the event loop remaining active after the
signal handler returns. This is standard Node.js behaviour but can interact poorly with
other `process.exit` calls or uncaught exception handlers. Verify no other code path calls
`process.exit` inside `tick()`.

**Rollback:** Revert `coordinator.mjs` to the previous synchronous shutdown. The only
observable change is that in-flight API calls complete before exit rather than being abandoned.
State files are not modified by this change.
