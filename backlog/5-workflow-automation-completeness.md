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
- Change `orc run-input-request` timeout behavior to the intended contract: default 1 hour and explicit terminal failure signaling on timeout
- Add bounded retry with backoff for retryable worker-session start failures in the coordinator launch path
- Add operator recovery documentation for finalization failures and related manual recovery flows

**Out of scope:**
- Changing the input request/response protocol event schema
- Implementing automatic merge conflict resolution
- Adding Prometheus metrics or structured log output
- Changing the finalization state machine logic

---

## Context

Three workflow gaps still make operator behavior less predictable than intended:

1. `orc run-input-request` already times out, but its default timeout is 25 minutes and timeout currently exits non-zero without emitting a terminal `run_failed` event. That makes timeout behavior inconsistent with the desired run-lifecycle contract.
2. Session start failures for retryable managed slots already return the slot to `idle`, but there is no bounded retry/backoff loop around the launch attempt itself. A transient failure is only retried on later coordinator ticks rather than through an explicit local retry policy.
3. When finalization fails (`blocked_finalize` state), there is no documented recovery procedure for operators.

### Current state
- `cli/run-input-request.ts` already has a timeout cutoff and continues heartbeating while it waits for input
- The current default `--timeout-ms` value is 25 minutes
- Timeout clears `input_state` and exits 1, but does not emit `run_failed`
- Session launch logic currently flows through `ensureSessionReady()` in `coordinator.ts` and `launchWorkerSession()` in `lib/workerRuntime.ts`
- Retryable managed-slot start failures emit `session_start_failed`, reset the slot to `idle`, and rely on future ticks rather than an explicit backoff loop
- No `docs/recovery.md` exists

### Desired state
- `orc run-input-request --timeout-ms=<ms>` exits with `run_failed` event after the timeout elapses with no response
- `orc run-input-request` defaults to 3,600,000 ms (1 hour) when `--timeout-ms` is omitted
- Coordinator retries failed retryable session starts up to 3 times with bounded backoff before falling back to the existing failure path
- `docs/recovery.md` documents the `blocked_finalize` state and step-by-step recovery

### Start here
- `cli/run-input-request.ts` — current poll loop implementation
- `coordinator.ts` — `ensureSessionReady()` launch flow
- `lib/workerRuntime.ts` — `launchWorkerSession()` failure handling
- `cli/run-reporting.test.ts` — existing `run-input-request` coverage

**Affected files:**
- `cli/run-input-request.ts` — change default timeout and emit terminal failure on timeout
- `coordinator.ts` and/or `lib/workerRuntime.ts` — add retry logic to the retryable launch path
- `docs/recovery.md` — new file, operator recovery guide
- `cli/run-reporting.test.ts` — extend existing timeout coverage
- `coordinator.test.ts` — cover the bounded retry path

---

## Goals

1. Must: `orc run-input-request --question="..." --timeout-ms=3600000` emits `run_failed` and exits non-zero if no `input_response` arrives before the timeout.
2. Must: The default timeout when `--timeout-ms` is omitted is 3,600,000 ms (1 hour).
3. Must: Coordinator retries a failed retryable session start up to 3 times with bounded delays before falling back to the existing `session_start_failed` path.
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
  // Emit run_failed using the existing event schema
  appendSequencedEvent(STATE_DIR, {
    ts: new Date().toISOString(),
    event: 'run_failed',
    actor_type: 'agent',
    actor_id: agentId,
    run_id: runId,
    task_ref: validatedClaim.task_ref,
    agent_id: agentId,
    payload: { reason: 'input_request_timeout', policy: 'requeue' },
  });
  console.error(`[run-input-request] timeout after ${timeoutMs}ms — no response received`);
  process.exit(1);
}
```

Preserve the existing poll-loop and heartbeat behavior. Do not invent a new event schema.

### Step 2 — Add retry logic to retryable session start

**Files:** `coordinator.ts`, `lib/workerRuntime.ts`

Add the retry loop around the actual retryable launch path used by managed slots. Keep one-off non-retryable workers on their current failure behavior.

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
// After all retries exhausted, fall back to the existing failure path
```

Invariant: `session_start_failed` remains the terminal event after retries are exhausted. Do not change event schema.

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
4. After the manual recovery succeeds, finish the preserved run through the documented coordinator/operator path in effect at that time.
   ```bash
   orc run-finish --run-id=<run_id> --agent-id=<agent_id>
   ```

## Hung input request

If a worker is blocked on `orc run-input-request` and the master cannot respond:
1. Find the run: `orc runs-active`
2. Respond via the supported input-response mechanism (`orc run-input-respond ...` or the equivalent MCP tool)
3. If recovery is not possible, stop the worker through the normal worker-management path and requeue/reset the task as needed

## Session start failure after retries

If coordinator logs show repeated `session_start_failed`:
1. Check provider CLI is in PATH: `which claude` / `which codex` / `which gemini`
2. Check provider credentials are valid
3. Distinguish managed slot launch failures from manual worker-session failures and recover with the matching operator command
```

---

## Acceptance criteria

- [ ] `orc run-input-request --question="test" --timeout-ms=100` exits non-zero and appends a `run_failed` event when no response is deposited.
- [ ] `orc run-input-request` without `--timeout-ms` defaults to 1-hour timeout (verifiable by reading the parsed value in code).
- [ ] A worker that responds before the timeout completes normally (no regression).
- [ ] Coordinator retries retryable session start at least 2 times before falling back to `session_start_failed` (observable via test or event log).
- [ ] `docs/recovery.md` exists and contains all three recovery scenarios.
- [ ] No changes to event schemas.
- [ ] No changes to files outside the stated scope.

---

## Tests

Extend the existing `orc-run-input-request` coverage in `cli/run-reporting.test.ts`:

```ts
it('exits with run_failed event when timeout elapses before response', async () => { ... });
it('completes normally when response arrives before timeout', async () => { ... });
```

Add to `coordinator.test.ts`:

```ts
it('retries retryable session start up to 3 times before emitting session_start_failed', async () => { ... });
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
