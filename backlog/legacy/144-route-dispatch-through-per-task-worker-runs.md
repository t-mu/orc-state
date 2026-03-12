---
ref: orch/task-144-route-dispatch-through-per-task-worker-runs
epic: orch
status: todo
---

# Task 144 — Route Dispatch Through Per-Task Worker Runs

Depends on Task 143.

## Scope

**In scope:**
- `coordinator.mjs` — claim, assign, and dispatch tasks through a fresh worker session attached to an available slot
- `lib/claimManager.mjs` — align claim/run state with task-scoped worker execution
- `lib/dispatchPlanner.mjs` and related scheduling helpers — treat worker slots as capacity instead of persistent manually registered workers
- worker session teardown / retry handling required when a run finishes, fails, or never starts

**Out of scope:**
- Startup UX changes for the master session
- Operator-facing status formatting changes
- Master bootstrap or input-request flow changes beyond what the new dispatch path needs
- Final documentation cleanup

---

## Context

Once the coordinator can launch a worker for a slot, dispatch must stop treating workers as always-on background sessions. The real migration happens here: a claim should consume worker capacity, start a fresh worker session, hand off the task, monitor the run lifecycle, and then release capacity when the run ends.

This task is where the persistent-worker model actually becomes a per-task-worker model. Without it, the earlier slot and launcher tasks only add infrastructure around the old dispatch semantics.

### Current state

The coordinator plans dispatch against durable agent records and keeps worker sessions alive across tasks. Claims and run-lifecycle handling assume the same worker session persists while the agent waits for future tasks.

Cleanup and requeue behavior are tied to stale persistent sessions rather than to the lifecycle of one task-scoped worker run.

### Desired state

Dispatch should treat worker slots as capacity. When a slot is available, the coordinator should claim an eligible task, launch a fresh worker for that slot, send the task payload, watch for `run_started`, and then cleanly tear the worker down when the run finishes or fails.

If startup fails, `run_started` never arrives, or the run expires, the coordinator should clean up the session deterministically and return the task to the appropriate backlog state.

### Start here

- `coordinator.mjs` — current dispatch loop, run-start nudging, and session assumptions
- `lib/claimManager.mjs` — claim and finish/release behavior
- `lib/dispatchPlanner.mjs` — how dispatchable agents are selected today

<!-- Optional:
### Dependency context

Task 143 creates the coordinator-owned worker launcher. This task uses that launcher in the actual dispatch path and makes task execution fully task-scoped.
-->

**Affected files:**
- `coordinator.mjs` — dispatch and teardown orchestration
- `lib/claimManager.mjs` — claim/run cleanup alignment
- `lib/dispatchPlanner.mjs` — capacity-aware dispatch planning
- related run-activity helpers under `lib/`

---

## Goals

1. Must dispatch tasks through fresh worker sessions bound to managed worker slots.
2. Must treat worker capacity separately from durable human-managed worker identities.
3. Must clean up worker sessions deterministically after success, failure, or startup timeout.
4. Must requeue or release tasks correctly when a spawned run cannot proceed.
5. Must preserve clear run lifecycle semantics for `claimed`, `in_progress`, `done`, `released`, and failure paths.

---

## Implementation

### Step 1 — Make dispatch capacity-aware

**Files:**
- `lib/dispatchPlanner.mjs`
- `coordinator.mjs`

Update dispatch planning so it selects available worker slots rather than persistent registered worker sessions. An idle slot should represent available capacity, not a live session waiting forever.

### Step 2 — Dispatch by spawning and handing off one task-scoped run

**Files:**
- `coordinator.mjs`
- `lib/claimManager.mjs`

Claim an eligible task, start the worker session for a slot, send the task envelope, and move the claim through the expected run lifecycle. The slot must become available again when the run ends or aborts.

### Step 3 — Add deterministic cleanup and retry behavior

**Files:**
- `coordinator.mjs`
- any worker teardown helper created in Task 143

Handle the cases where startup fails, `run_started` never arrives, or the worker becomes inactive. Cleanup must happen on the task-scoped worker session, not on an imagined persistent worker process.

---

## Acceptance criteria

- [ ] Dispatch assigns tasks by consuming worker-slot capacity and spawning a fresh worker session for that task.
- [ ] Worker slots return to available capacity after run success, failure, or startup timeout.
- [ ] Tasks are requeued or released correctly when a spawned worker run cannot proceed.
- [ ] Claim/run state remains coherent throughout the task-scoped worker lifecycle.
- [ ] The new dispatch path is covered by focused coordinator and claim-manager tests.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `orchestrator/coordinator.test.mjs` — assert claim -> spawn -> task handoff -> cleanup behavior
- `lib/claimManager.test.mjs` — assert claim/requeue/release behavior remains coherent with task-scoped runs
- `e2e/orchestrationLifecycle.e2e.test.mjs` or `e2e/worker-control-flow.e2e.test.mjs` — assert a task can run end-to-end on a spawned worker session

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs orchestrator/coordinator.test.mjs lib/claimManager.test.mjs
npx vitest run -c orchestrator/vitest.e2e.config.mjs e2e/orchestrationLifecycle.e2e.test.mjs e2e/worker-control-flow.e2e.test.mjs
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
node cli/orc.mjs doctor
node cli/orc.mjs status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** This is the main behavioral cutover. A broken dispatch/cleanup loop can leak sessions, strand claims, or repeatedly requeue work.
**Rollback:** Restore the prior persistent dispatch path, revert claim/dispatch changes together, and rerun the coordinator and e2e test suites.
