---
ref: general/14-event-driven-worker-lifecycle
feature: general
priority: high
status: done
---

# Task 14 — Make Worker Lifecycle Commands Append-Only to events.jsonl

Independent.

## Scope

**In scope:**
- Rewrite `cli/run-start.ts` to append a `run_started` event instead of calling `startRun()` (lock + claims write)
- Rewrite `cli/run-heartbeat.ts` to append a `heartbeat` event instead of calling `heartbeat()` (lock + claims write)
- Rewrite `cli/run-finish.ts` to append a `run_finished` event instead of calling `finishRun()` (lock + claims write)
- Rewrite `cli/run-fail.ts` to append a `run_failed` event (with `reason` and `policy` in payload) instead of calling `finishRun()` (lock + claims write)
- Rewrite `cli/run-work-complete.ts` to append `work_complete`/`ready_to_merge` events without calling `heartbeat()` or `setRunFinalizationState()` (lock + claims writes); keep the read of `claims.json` to determine which event to emit
- Remove all `recordAgentActivity()` calls from the five worker CLI files listed above (each calls `updateAgentRuntime` which acquires the lock on `agents.json`)
- Extend `coordinator.ts` `processTerminalRunEvents` to handle `run_started` and `heartbeat` events by calling `startRun()` and `heartbeat()` (including `recordAgentActivity`) on the coordinator side
- Update `cli/run-reporting.test.ts` to match the new event-append-only behavior

**Out of scope:**
- `cli/run-input-request.ts` and `cli/run-input-respond.ts` — these already use event appends and coordinator-owned state writes; do not touch
- `cli/run-work-complete.ts` read of `claims.json` — reads require no lock and are safe inside the sandbox; keep the read
- `lib/claimManager.ts` function signatures — no internal library changes needed
- Any other CLI commands or coordinator logic beyond the events listed above

---

## Context

Worker CLI commands (`run-start`, `run-heartbeat`, `run-finish`, `run-fail`) currently write to `claims.json` and `agents.json` by acquiring a file lock (`.orc-state/.lock`). When the worker runs inside a provider sandbox (e.g., codex `--sandbox workspace-write` scoped to the worktree), that lock path is outside the sandbox boundary, causing `EPERM: operation not permitted`. This produces `run_started timeout` failures because the coordinator never sees the acknowledgment.

The fix is to make worker CLIs append-only to `events.jsonl` — appends are atomic and require no lock — while the coordinator drives all `claims.json` and `agents.json` mutations on its own tick.

### Current state

- `cli/run-start.ts` calls `startRun(STATE_DIR, runId, agentId)` which acquires `.orc-state/.lock`, mutates `claims.json` (state → `in_progress`), and writes `backlog.json`. Then calls `recordAgentActivity()` which acquires the lock again on `agents.json`.
- `cli/run-heartbeat.ts` calls `heartbeat()` (lock + `claims.json` write) and `recordAgentActivity()` (lock + `agents.json` write).
- `cli/run-finish.ts` and `cli/run-fail.ts` call `finishRun()` (lock + `claims.json` + `backlog.json` writes) and `recordAgentActivity()`.
- `cli/run-work-complete.ts` calls `heartbeat()` + `setRunFinalizationState()` (both lock-based).
- The coordinator's `processTerminalRunEvents` already handles `run_finished`, `run_failed`, `work_complete`, and `ready_to_merge` but NOT `run_started` or `heartbeat`.

### Desired state

- Worker CLI commands append exactly one sequenced event to `events.jsonl` and exit. No lock is acquired, no JSON state file is mutated by the worker.
- The coordinator's `processTerminalRunEvents` handles `run_started` (calls `startRun()`) and `heartbeat` (calls `heartbeat()` + `recordAgentActivity()`) in addition to the events it already handles.
- Worker sessions under any sandboxed provider can successfully complete the full run lifecycle without hitting `EPERM`.

### Start here

- `cli/run-start.ts` — simplest example of current lock-based pattern
- `coordinator.ts` around `processTerminalRunEvents` (search for `'run_finished'`) — shows the existing event handler pattern to extend
- `lib/claimManager.ts` — confirms `startRun`, `heartbeat`, `finishRun` signatures remain unchanged (coordinator calls them)

**Affected files:**
- `cli/run-start.ts` — replace `startRun` + `recordAgentActivity` with `appendSequencedEvent`
- `cli/run-heartbeat.ts` — replace `heartbeat` + `recordAgentActivity` with `appendSequencedEvent`
- `cli/run-finish.ts` — replace `finishRun` + `recordAgentActivity` with `appendSequencedEvent`
- `cli/run-fail.ts` — replace `finishRun` + `recordAgentActivity` with `appendSequencedEvent`; put `reason` and `policy` in event payload
- `cli/run-work-complete.ts` — remove `heartbeat()` and `setRunFinalizationState()` calls; keep claims read; append event only
- `coordinator.ts` — add `run_started` and `heartbeat` handlers in `processTerminalRunEvents`
- `cli/run-reporting.test.ts` — update tests for the five CLIs to assert event appended, not claims mutated

---

## Goals

1. Must: `orc run-start` appends a `run_started` event to `events.jsonl` and does not write `claims.json` or acquire `.orc-state/.lock`.
2. Must: `orc run-heartbeat` appends a `heartbeat` event and does not acquire the lock.
3. Must: `orc run-finish` appends a `run_finished` event and does not acquire the lock.
4. Must: `orc run-fail` appends a `run_failed` event (payload includes `reason` and `policy`) and does not acquire the lock.
5. Must: coordinator processes `run_started` events by calling `startRun()`, transitioning the claim from `claimed` → `in_progress` and updating `agents.json`.
6. Must: coordinator processes `heartbeat` events by calling `heartbeat()`, renewing `lease_expires_at` and `last_heartbeat_at` on the claim.
7. Must: all existing tests pass after the refactor; updated tests assert event-append semantics, not direct claims mutations.

---

## Implementation

### Step 1 — Rewrite cli/run-start.ts

**File:** `cli/run-start.ts`

Replace the body with a single `appendSequencedEvent` call. Remove imports of `startRun` and `recordAgentActivity`.

```typescript
#!/usr/bin/env node
import { appendSequencedEvent } from '../lib/eventLog.ts'; // or wherever appendSequencedEvent lives
import { STATE_DIR } from '../lib/paths.ts';
import { flag } from '../lib/args.ts';

const runId   = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-start --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

appendSequencedEvent(STATE_DIR, {
  event:    'run_started',
  run_id:   runId,
  agent_id: agentId,
});
console.log(`run_started: ${runId} (${agentId})`);
```

Invariant: do not call `startRun` or `recordAgentActivity` in this file.

### Step 2 — Rewrite cli/run-heartbeat.ts

**File:** `cli/run-heartbeat.ts`

Replace lock-based calls with a single `appendSequencedEvent`:

```typescript
appendSequencedEvent(STATE_DIR, {
  event:    'heartbeat',
  run_id:   runId,
  agent_id: agentId,
});
console.log(`heartbeat: ${runId} (${agentId})`);
```

Remove imports of `heartbeat` and `recordAgentActivity`.

### Step 3 — Rewrite cli/run-finish.ts

**File:** `cli/run-finish.ts`

```typescript
appendSequencedEvent(STATE_DIR, {
  event:    'run_finished',
  run_id:   runId,
  agent_id: agentId,
});
console.log(`run_finished: ${runId} (${agentId})`);
```

Remove imports of `finishRun` and `recordAgentActivity`.

### Step 4 — Rewrite cli/run-fail.ts

**File:** `cli/run-fail.ts`

Keep the `policy` validation and arg parsing. Replace the `finishRun` call with:

```typescript
appendSequencedEvent(STATE_DIR, {
  event:    'run_failed',
  run_id:   runId,
  agent_id: agentId,
  payload:  { reason: failureReason, code: failureCode, policy },
});
console.log(`run_failed: ${runId} (${agentId}) reason=${failureReason}`);
```

Remove imports of `finishRun` and `recordAgentActivity`.

### Step 5 — Rewrite cli/run-work-complete.ts

**File:** `cli/run-work-complete.ts`

Keep the read of `claims.json` to determine current `finalization_state`. Remove the calls to `heartbeat()` and `setRunFinalizationState()`. The event emission itself (already present via `appendSequencedEvent`) remains. Verify no lock-acquiring calls remain.

### Step 6 — Extend coordinator.ts processTerminalRunEvents

**File:** `coordinator.ts`

Find `processTerminalRunEvents` (search for the `'run_finished'` case). Add two new cases before the existing terminal-event handlers:

```typescript
case 'run_started': {
  // Coordinator drives claim transition claimed → in_progress
  startRun(stateDir, event.run_id, event.agent_id);
  recordAgentActivity(stateDir, event.agent_id);
  break;
}
case 'heartbeat': {
  // Coordinator renews lease on the claim
  heartbeat(stateDir, event.run_id, event.agent_id);
  recordAgentActivity(stateDir, event.agent_id);
  break;
}
```

Ensure `startRun`, `heartbeat`, and `recordAgentActivity` are already imported (they likely are; check imports at top of file).

Invariant: `processTerminalRunEvents` re-reads claims after this block (lines 752-755 in current code); this prevents stale-state false-nudge on the same tick. Do not remove that re-read.

### Step 7 — Update cli/run-reporting.test.ts

**File:** `cli/run-reporting.test.ts`

For `orc-run-start`:
- Remove assertion `expect(claim!.state).toBe('in_progress')` — claim state is now set by coordinator, not worker CLI.
- Keep `expect(events.some((e) => e.event === 'run_started'...)).toBe(true)`.
- Remove `expect(agents.agents[0].last_heartbeat_at).toBeTruthy()` from the run-start test.

For `orc-run-heartbeat`:
- Remove assertion `expect(claim!.last_heartbeat_at).toBeTruthy()`.
- Keep `expect(events.some((e) => e.event === 'heartbeat'...)).toBe(true)`.
- Remove `expect(agents.agents[0].last_heartbeat_at).toBeTruthy()` from the heartbeat test.

For `orc-run-finish`:
- Remove assertions checking `claim!.state === 'done'` and `agents.agents[0].last_heartbeat_at`.
- Keep `expect(events.some((e) => e.event === 'run_finished'...)).toBe(true)`.

For `orc-run-fail`:
- Remove assertions checking `claim!.state`, `claim!.failure_reason`, `task!.status`, and `agents.agents[0].last_heartbeat_at`.
- Keep `expect(events.some((e) => e.event === 'run_failed'...)).toBe(true)`.
- Add assertion that `run_failed` event payload contains `reason` and `policy`.

---

## Acceptance criteria

- [ ] `orc run-start --run-id=X --agent-id=Y` exits 0 and appends a `run_started` event; `claims.json` is unchanged immediately after the call.
- [ ] `orc run-heartbeat --run-id=X --agent-id=Y` exits 0 and appends a `heartbeat` event; `claims.json` is unchanged immediately after the call.
- [ ] `orc run-finish --run-id=X --agent-id=Y` exits 0 and appends a `run_finished` event; `claims.json` is unchanged immediately after the call.
- [ ] `orc run-fail --run-id=X --agent-id=Y --reason=R` exits 0 and appends a `run_failed` event with `reason` and `policy` in payload; `claims.json` is unchanged immediately after the call.
- [ ] Coordinator processes a `run_started` event and transitions the matching claim from `claimed` to `in_progress`.
- [ ] Coordinator processes a `heartbeat` event and renews `lease_expires_at` on the matching claim.
- [ ] None of the five worker CLI files import or call `withLock`, `atomicWriteJson`, `startRun`, `heartbeat` (from claimManager), `finishRun`, `setRunFinalizationState`, or `recordAgentActivity`.
- [ ] All tests in `cli/run-reporting.test.ts` pass with updated assertions.
- [ ] `orc run-fail --policy=invalid` still exits 1 with an error message (policy validation is preserved).
- [ ] No changes to files outside the stated scope.

---

## Tests

Update `cli/run-reporting.test.ts`:

```typescript
// orc-run-start: claims not mutated by CLI
it('appends run_started event without mutating claims.json', () => {
  seedClaimedRun({ runId: 'run-abc-001', agentId: 'worker-01' });
  const result = runCli('run-start.ts', ['--run-id=run-abc-001', '--agent-id=worker-01']);
  expect(result.status).toBe(0);
  const claim = readClaims().claims.find((c) => c.run_id === 'run-abc-001');
  expect(claim!.state).toBe('claimed'); // unchanged — coordinator drives transition
  const events = readEvents();
  expect(events.some((e) => e.event === 'run_started' && e.run_id === 'run-abc-001')).toBe(true);
});

// orc-run-fail: event payload includes reason and policy
it('appends run_failed event with reason and policy in payload', () => {
  seedInProgressRun({ runId: 'run-fail-001', agentId: 'worker-01' });
  runCli('run-fail.ts', ['--run-id=run-fail-001', '--agent-id=worker-01', '--reason=build error', '--policy=block']);
  const events = readEvents();
  const ev = events.find((e) => e.event === 'run_failed' && e.run_id === 'run-fail-001');
  expect((ev!.payload as Record<string, unknown>).reason).toBe('build error');
  expect((ev!.payload as Record<string, unknown>).policy).toBe('block');
});
```

---

## Verification

```bash
# Targeted: worker lifecycle CLI tests
npx vitest run cli/run-reporting.test.ts
```

```bash
# Coordinator event handler test (if it exists)
npx vitest run coordinator.test.ts
```

```bash
# Final repo-wide checks
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
# Smoke checks
orc doctor
orc status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** If the coordinator tick is slow or skips a cycle, the claim transition from `claimed` → `in_progress` will be delayed. During that window, `enforceRunStartLifecycle` could fire a false nudge. The coordinator already re-reads claims after `processTerminalRunEvents` (preventing false nudge within the same tick), but a stale-read race between ticks is possible if the tick interval is very long. This is an existing concern with any event-driven approach and is acceptable given the current tick interval.

**Risk:** Any worker CLI that is invoked before the coordinator processes the `run_started` event will see the claim still in `claimed` state. For `run-work-complete.ts` which reads `finalization_state`, this is safe because the claim state check is a guard only — the event is still appended.

**Rollback:** `git restore cli/run-start.ts cli/run-heartbeat.ts cli/run-finish.ts cli/run-fail.ts cli/run-work-complete.ts coordinator.ts cli/run-reporting.test.ts && npm test`
