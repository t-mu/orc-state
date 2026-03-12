# Task 34 — Parallel Tick: Concurrent API Calls for Nudges and Dispatch

High severity performance fix. Recommended to complete T35 (per-tick state cache) first,
but not a hard dependency.

## Scope

**In scope:**
- Replace sequential `for` loops in `enforceRunStartLifecycle` and `enforceInProgressLifecycle`
  with `Promise.allSettled` — nudges to different agents run concurrently
- Replace the sequential `for` loop in tick dispatch with `Promise.allSettled`
- Add tests verifying concurrent execution

**Out of scope:**
- Changing adapter internals or SDK call behaviour
- Changing claim lifecycle functions (`claimTask`, `startRun`, `heartbeat`, `finishRun`)
- Changing the reentrancy guard or tick scheduling
- Adding external concurrency-limiter dependencies (use the local batch pattern below)

---

## Context

A coordinator tick currently makes API calls sequentially:

```
tick() {
  enforceRunStartLifecycle(agents)    ← nudge claim-1 (30s API call)
                                      ← nudge claim-2 (30s API call)
  enforceInProgressLifecycle(agents)  ← nudge claim-3 (30s API call)
  dispatch:                           ← dispatch task-1 (60s API call)
                                      ← dispatch task-2 (60s API call)
}
// Total wall time: 210 seconds for a modest setup with 5 API calls
```

All five API calls are independent: they target different session handles (different agents).
There is no ordering constraint between nudges or between dispatch items. Running them
concurrently reduces worst-case tick time from O(N * avg_call_time) to O(max_call_time).

The only coordination point is the coordinator lock: `claimTask` acquires it synchronously
during dispatch. Since the lock is fast (nanosecond POSIX file ops), concurrent `claimTask`
calls serialize at the lock and then immediately release — each `adapter.send()` runs
concurrently after its `claimTask` succeeds.

**Affected files:**
- `coordinator.mjs` — refactor the three sequential loops

---

## Goals

1. Must run all nudge API calls in `enforceRunStartLifecycle` concurrently via the bounded batch pattern
2. Must run all nudge API calls in `enforceInProgressLifecycle` concurrently via the bounded batch pattern
3. Must run all dispatch API calls in `tick()` concurrently via the bounded batch pattern
4. Must handle per-item errors without aborting the whole batch (use `allSettled`, not `all`)
5. Must preserve per-item error logging (same messages as today)
6. Must not change behaviour for ticks with a single item (same as today)
7. Must maintain the invariant that `claimTask` is called exactly once per dispatch item (no double-claim)
8. Must cap concurrent API calls at `CONCURRENCY_LIMIT = 8` (no unbounded burst)

---

## Implementation

### Step 0 — Add `CONCURRENCY_LIMIT` constant and helper

**File:** `coordinator.mjs`

At the top of the file (or near other constants), add:

```js
// Maximum concurrent API calls per tick — prevents burst on large agent fleets.
const CONCURRENCY_LIMIT = 8;

/**
 * Run an array of async thunks with a bounded concurrency cap.
 * Returns all settled results (same shape as Promise.allSettled).
 */
async function runBounded(thunks, limit = CONCURRENCY_LIMIT) {
  const results = [];
  for (let i = 0; i < thunks.length; i += limit) {
    const batch = await Promise.allSettled(thunks.slice(i, i + limit).map((fn) => fn()));
    results.push(...batch);
  }
  return results;
}
```

No external dependency — this replaces `Promise.allSettled(work.map(fn => fn()))` at every
call site. With ≤8 work items the behaviour is identical to unbounded; with >8 items the
calls are processed in waves of 8.

---

### Step 1 — Refactor `enforceRunStartLifecycle`

**File:** `coordinator.mjs`

The current inner loop:
```js
for (const claim of readClaims(STATE_DIR).claims ?? []) {
  if (claim.state !== 'claimed') { ...; continue; }
  // ... timeout check ...
  // ... nudge threshold check ...
  try {
    const response = await adapter.send(agent.session_handle, buildRunStartNudge(claim));
    recordAdapterResponseEvents(response, { ... });
    emit({ event: 'need_input', ... });
    runStartNudgeAtMs.set(claim.run_id, nowMs);
    log(`nudged ${claim.agent_id} ...`);
  } catch (err) {
    log(`warning: ...`);
  }
}
```

Refactor to collect nudge work into an array, then `Promise.allSettled`:

```js
async function enforceRunStartLifecycle(agents) {
  const nowMs = Date.now();
  const byAgent = new Map(agents.map((a) => [a.agent_id, a]));
  const nudgeWork = [];

  for (const claim of readClaims(STATE_DIR).claims ?? []) {
    if (claim.state !== 'claimed') {
      runStartNudgeAtMs.delete(claim.run_id);
      continue;
    }
    // ... timeout check (same as before — call finishRun synchronously for timeouts) ...
    // ... nudge threshold check (same as before) ...

    const agent = byAgent.get(claim.agent_id);
    if (!agent?.session_handle || agent.status === 'offline') continue;

    const claimSnapshot = { ...claim }; // snapshot to avoid race with later mutations
    nudgeWork.push(async () => {
      const adapter = getAdapter(agent.provider);
      const response = await adapter.send(agent.session_handle, buildRunStartNudge(claimSnapshot));
      recordAdapterResponseEvents(response, {
        runId: claimSnapshot.run_id,
        taskRef: claimSnapshot.task_ref,
        agentId: claimSnapshot.agent_id,
      });
      emit({ event: 'need_input', ..., run_id: claimSnapshot.run_id, ... });
      runStartNudgeAtMs.set(claimSnapshot.run_id, nowMs);
      log(`nudged ${claimSnapshot.agent_id} for missing run_started on ${claimSnapshot.run_id}`);
    });
  }

  const results = await runBounded(nudgeWork);
  for (const result of results) {
    if (result.status === 'rejected') {
      log(`warning: run-start nudge failed: ${result.reason?.message}`);
    }
  }
}
```

**Important:** Timeout enforcement (calls to `finishRun`) must remain synchronous in the
loop body — do not defer them to `allSettled`. Only the `adapter.send()` part is async and
can be parallelised.

### Step 2 — Apply the same pattern to `enforceInProgressLifecycle`

**File:** `coordinator.mjs`

Same refactor: collect nudge work into an array, `runBounded(nudgeWork)` at the end.
Timeout enforcement remains synchronous.

### Step 3 — Refactor the dispatch loop in `tick()`

**File:** `coordinator.mjs`

Current loop:
```js
for (const item of dispatchPlan) {
  const agent = item.agent;
  const taskRef = item.task_ref;
  try {
    const ready = await ensureSessionReady(agent);
    if (!ready) continue;
    const { run_id } = claimTask(STATE_DIR, taskRef, agent.agent_id);
    const adapter = getAdapter(agent.provider);
    try {
      const response = await adapter.send(agent.session_handle, buildTaskEnvelope(taskRef, run_id, agent.agent_id));
      recordAdapterResponseEvents(response, { runId: run_id, taskRef, agentId: agent.agent_id });
    } catch (err) {
      finishRun(...); // requeue on dispatch error
      ...
    }
    log(`dispatched ${taskRef} to ${agent.agent_id}`);
  } catch (err) {
    log(`ERROR dispatching ...`);
  }
}
```

Refactor to `Promise.allSettled`:

```js
const dispatchResults = await runBounded(
  dispatchPlan.map((item) => async () => {
    const { agent, task_ref: taskRef } = item;
    const ready = await ensureSessionReady(agent);
    if (!ready) return;
    const { run_id } = claimTask(STATE_DIR, taskRef, agent.agent_id);
    log(`claimed ${taskRef} for ${agent.agent_id} (${run_id})`);
    const adapter = getAdapter(agent.provider);
    try {
      const response = await adapter.send(
        agent.session_handle,
        buildTaskEnvelope(taskRef, run_id, agent.agent_id),
      );
      recordAdapterResponseEvents(response, { runId: run_id, taskRef, agentId: agent.agent_id });
    } catch (err) {
      finishRun(STATE_DIR, run_id, agent.agent_id, {
        success: false,
        failureReason: `dispatch_error: ${err.message}`,
        failureCode: 'ERR_DISPATCH_FAILURE',
        policy: 'requeue',
      });
      const alive = await adapter.heartbeatProbe(agent.session_handle);
      if (!alive) markAgentOffline(agent, 'dispatch_failed_session_unreachable');
      throw err;
    }
    log(`dispatched ${taskRef} to ${agent.agent_id}`);
  }),
);  // runBounded processes at most CONCURRENCY_LIMIT=8 dispatches concurrently

for (const result of dispatchResults) {
  if (result.status === 'rejected') {
    log(`ERROR in dispatch: ${result.reason?.message}`);
  }
}
```

---

## Acceptance criteria

- [ ] Multiple concurrent nudge API calls are made in a single tick (not serialised)
- [ ] Multiple concurrent dispatch API calls are made in a single tick
- [ ] A failed nudge for one agent does not prevent nudges for other agents
- [ ] A failed dispatch for one agent does not prevent dispatch for other agents
- [ ] Timeout enforcement (calls to `finishRun` for expired runs) remains synchronous
- [ ] Per-item error messages are still logged
- [ ] At most `CONCURRENCY_LIMIT` (8) API calls run simultaneously — no unbounded `Promise.allSettled` over a raw array
- [ ] `runBounded` helper lives in `coordinator.mjs` with no new external dependencies
- [ ] All existing tests pass
- [ ] No changes outside `coordinator.mjs`

---

## Tests

Add to `e2e/orchestrationLifecycle.e2e.test.mjs`:

```js
it('sends nudges to multiple agents concurrently (not sequentially)', async () => {
  // Set up two agents each with a stale 'claimed' run older than nudge threshold.
  // Use mocked adapters that track call order and timing.
  // After tick(), assert both adapter.send() calls were initiated before either completed.
  // Simple proxy: both agents' send calls should be recorded in the mock.
});

it('dispatches to multiple agents in the same tick', async () => {
  // Set up two agents both idle, two tasks both todo.
  // After one tick, both tasks should be in 'claimed' state.
});
```

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

Performance smoke test (manual):

```bash
# With two agents registered and two tasks delegated, measure tick duration
# before and after this change. Should see ~50% reduction with two concurrent dispatches.
```
