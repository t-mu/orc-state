---
ref: general/5-workflow-automation-completeness
feature: general
priority: high
status: todo
---

# Task 5 — Complete Workflow Automation: Timeouts, Retry, and Recovery

Independent.

## Scope

**In scope:**
- Add configurable timeout to `orc run-input-request` — worker exits with `run_failed` if no response arrives within the timeout window (default: 1 hour)
- Add auto-retry with exponential backoff for session start failures in the coordinator (`coordinator.ts`)
- Add a `docs/recovery.md` documenting finalization failure recovery steps for operators

**Out of scope:**
- Changing the input request/response protocol event schema
- Implementing automatic merge conflict resolution
- Adding Prometheus metrics or structured log output
- Changing the finalization state machine logic

---

## Context

Three automation gaps can cause a worker or the coordinator to hang indefinitely or require operator intervention with no documented recovery path:

1. `orc run-input-request` blocks the worker process until a response arrives. If the master never responds (e.g., it crashes or ignores the request), the worker is stuck forever — heartbeats stop, the claim eventually expires and requeues, but the worker process itself is never terminated.
2. Session start failures in `coordinator.ts` emit an event and log a warning but do not retry. A transient failure (e.g., provider CLI not yet in PATH) permanently stalls the task until an operator intervenes.
3. When finalization fails (`blocked_finalize` state), there is no documented recovery procedure for operators.

### Current state
- `cli/run-input-request.ts`: polls for `input_response` event with no timeout cutoff — loop runs until response or process kill
- `coordinator.ts` `_startWorkerSession()`: on failure, emits `session_start_failed` event and returns — no retry scheduled
- No `docs/recovery.md` exists

### Desired state
- `orc run-input-request --timeout-ms=<ms>` exits with `run_failed` event after the timeout elapses with no response
- Coordinator retries failed session starts up to 3 times with 30s backoff before marking the task blocked
- `docs/recovery.md` documents the `blocked_finalize` state and step-by-step recovery

### Start here
- `cli/run-input-request.ts` — current poll loop implementation
- `coordinator.ts` — `_startWorkerSession()` failure handling (search for `session_start_failed`)

**Affected files:**
- `cli/run-input-request.ts` — add timeout cutoff
- `coordinator.ts` — add retry logic to session start failure path
- `docs/recovery.md` — new file, operator recovery guide

---

## Goals

1. Must: `orc run-input-request --question="..." --timeout-ms=3600000` emits `run_failed` and exits non-zero if no `input_response` arrives before the timeout.
2. Must: The default timeout when `--timeout-ms` is omitted is 3,600,000 ms (1 hour).
3. Must: Coordinator retries a failed session start up to 3 times with 30-second delays before emitting `session_start_failed` and stopping.
4. Must: `docs/recovery.md` exists and documents how to recover from `blocked_finalize` state.
5. Must: Existing behavior when a response arrives before timeout is unchanged.

---

## Implementation

### Step 1 — Add timeout to `orc run-input-request`

**File:** `cli/run-input-request.ts`

```ts
const timeoutMs = Number(flag('timeout-ms') ?? 3_600_000);
const deadline = Date.now() + timeoutMs;

// Inside the poll loop, before sleeping:
if (Date.now() >= deadline) {
  // Emit run_failed
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'run_failed',
    run_id: runId,
    agent_id: agentId,
    payload: { reason: 'input_request_timeout', policy: 'requeue' },
  });
  console.error(`[run-input-request] timeout after ${timeoutMs}ms — no response received`);
  process.exit(1);
}
```

Invariant: do not change the poll interval or event schema.

### Step 2 — Add retry logic to session start in coordinator

**File:** `coordinator.ts`

Find `_startWorkerSession()` (or equivalent) failure handler. Wrap the start attempt in a retry loop:

```ts
const MAX_START_RETRIES = 3;
const RETRY_DELAY_MS = 30_000;

for (let attempt = 1; attempt <= MAX_START_RETRIES; attempt++) {
  const result = await tryStartSession(agent);
  if (result.ok) return;
  if (attempt < MAX_START_RETRIES) {
    await sleep(RETRY_DELAY_MS);
  }
}
// After all retries exhausted — emit session_start_failed as before
```

Invariant: `session_start_failed` event is still emitted after all retries are exhausted. Do not change event schema.

### Step 3 — Write `docs/recovery.md`

**File:** `docs/recovery.md`

```md
# Operator Recovery Guide

## Finalization failure (`blocked_finalize`)

A run enters `blocked_finalize` when the coordinator cannot merge the worker's branch
after two rebase attempts. The worker's work is preserved in its worktree branch.

### Symptoms
`orc status` shows a claim with `finalization_state: blocked_finalize`.

### Recovery steps
1. Find the blocked run: `orc runs-active`
2. Identify the worktree branch: `.worktrees/<run_id>`
3. Resolve conflicts manually:
   ```bash
   cd .worktrees/<run_id>
   git rebase main
   # resolve conflicts
   git rebase --continue
   git -C ../.. merge <branch> --no-ff
   ```
4. Mark the claim released:
   ```bash
   orc run-finish --run-id=<run_id> --agent-id=<agent_id>
   ```

## Hung input request

If a worker is blocked on `orc run-input-request` and the master cannot respond:
1. Find the run: `orc runs-active`
2. Respond via MCP: `respond_input(run_id, agent_id, "abort")`
   Or kill the worker session: `orc worker-remove <agent_id>`

## Session start failure after retries

If coordinator logs show repeated `session_start_failed`:
1. Check provider CLI is in PATH: `which claude` / `which codex` / `which gemini`
2. Check provider credentials are valid
3. Restart worker: `orc start-worker-session <agent_id>`
```

---

## Acceptance criteria

- [ ] `orc run-input-request --question="test" --timeout-ms=100` exits non-zero and emits a `run_failed` event within 200ms when no response is deposited.
- [ ] `orc run-input-request` without `--timeout-ms` defaults to 1-hour timeout (verifiable by reading the parsed value in code).
- [ ] A worker that responds before the timeout completes normally (no regression).
- [ ] Coordinator retries session start at least 2 times before emitting `session_start_failed` (observable via event log).
- [ ] `docs/recovery.md` exists and contains all three recovery scenarios.
- [ ] No changes to event schemas.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `cli/run-input-request.test.ts` (create if absent):

```ts
it('exits with run_failed event when timeout elapses before response', async () => { ... });
it('completes normally when response arrives before timeout', async () => { ... });
```

Add to `coordinator.test.ts`:

```ts
it('retries session start up to 3 times before emitting session_start_failed', async () => { ... });
```

---

## Verification

```bash
# Targeted — timeout test (manual)
node --experimental-strip-types cli/run-input-request.ts \
  --run-id=test-run --agent-id=test-agent --question="test" --timeout-ms=200
# Expected: exits 1 within ~300ms

# Full suite
nvm use 24 && npm test
```

```bash
# Smoke
node --experimental-strip-types cli/doctor.ts
# Expected: exits 0
```

## Risk / Rollback

**Risk:** Adding a timeout to `run-input-request` changes the behavior of long-running interactive tasks. Workers in production with `--timeout-ms` not set will now auto-fail after 1 hour instead of waiting indefinitely. This is the intended behavior but may surprise operators with tasks that legitimately take hours.
**Rollback:** `git restore cli/run-input-request.ts coordinator.ts && npm test`
