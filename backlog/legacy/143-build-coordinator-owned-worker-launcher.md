---
ref: orch/task-143-build-coordinator-owned-worker-launcher
epic: orch
status: todo
---

# Task 143 — Build Coordinator-Owned Worker Launcher

Depends on Tasks 141 and 142.

## Scope

**In scope:**
- `coordinator.mjs` — add a coordinator-owned launch primitive that can start a worker session for an assigned slot/task pair
- adapter integration under `adapters/` — support task-scoped worker startup and teardown from the coordinator
- worker-runtime helpers under `lib/` — isolate slot/session launch concerns from dispatch logic
- session lifecycle events emitted when a coordinator-spawned worker comes online or fails to start

**Out of scope:**
- Claiming and dispatching specific tasks through the spawned worker
- Reworking status output or the startup wizard
- Removing manual worker commands entirely
- Final cleanup and retry policy after run completion

---

## Context

Once worker slots and bootstrap contracts exist, the coordinator needs a single owner for worker process management. Today session startup is spread across worker registration and session-readiness logic. That worked for persistent workers because the operator could pre-create sessions, but it does not fit per-task execution.

The coordinator needs an explicit worker launcher that can start a headless session for a slot/task assignment, inject the task-scoped bootstrap, detect startup failure, and surface lifecycle events. Without that launcher, later dispatch changes would still be coupled to the old persistent-session assumptions.

### Current state

`ensureSessionReady()` in the coordinator blurs together session existence, liveness checks, and persistent worker revival. It assumes a long-lived worker session tied to a durable agent record.

There is no isolated component that owns slot startup and shutdown on behalf of the coordinator.

### Desired state

The coordinator should have a dedicated launcher path responsible for starting a worker session for a managed slot, wiring in the fresh-worker bootstrap, and reporting success or failure in a deterministic way.

Session creation should become a reusable primitive that later dispatch code can call when assigning a task to an available slot. This task must not reintroduce eager startup for idle slots.

### Start here

- `coordinator.mjs` — current `ensureSessionReady()` and worker session logic
- `adapters/index.mjs` plus provider adapters — current session start/heartbeat/send interface
- `lib/sessionBootstrap.mjs` — bootstrap input for newly spawned workers

<!-- Optional:
### Dependency context

Task 141 establishes the managed slot model. Task 142 rewrites the worker bootstrap for fresh task-scoped sessions. This task connects those pieces by giving the coordinator a first-class worker launcher primitive that dispatch can call later.
-->

**Affected files:**
- `coordinator.mjs` — coordinator-owned worker launch path
- `adapters/index.mjs` and provider adapters — startup/teardown behavior for fresh worker sessions
- new worker-runtime helper under `lib/` — extracted slot/session launcher logic
- `orchestrator/coordinator.test.mjs` — launch-path coverage

---

## Goals

1. Must create a coordinator-owned worker launcher primitive separate from task dispatch logic.
2. Must start fresh worker sessions using the task-scoped bootstrap introduced in Task 142.
3. Must detect and surface startup failures deterministically.
4. Must keep provider-specific startup behavior behind adapter boundaries.
5. Must leave task claiming and run cleanup for later tasks instead of mixing concerns here.
6. Must not start worker sessions merely because capacity exists with no assigned task.

---

## Implementation

### Step 1 — Extract worker-session launch logic from ad hoc coordinator checks

**Files:**
- `coordinator.mjs`
- new helper under `lib/`

Move session startup concerns into a clear launcher primitive. Keep the coordinator tick readable by separating slot selection from actual provider startup. The primitive should require an assigned slot/task context rather than launching for idle capacity alone.

### Step 2 — Wire provider adapters into the launcher

**Files:**
- `adapters/index.mjs`
- provider adapter modules

Use the existing adapter abstraction for task-scoped worker startup. The coordinator-owned launcher should ask adapters to create a fresh session for a specific slot/task assignment, then persist the resulting handle on the worker slot runtime.

### Step 3 — Emit deterministic lifecycle signals

**Files:**
- `coordinator.mjs`
- related event/log helpers if needed

Emit clear success/failure events when the coordinator launches a worker session. Startup failures must be visible to later status and retry logic.

---

## Acceptance criteria

- [ ] The coordinator has a dedicated worker-launch primitive separate from task dispatch logic.
- [ ] Fresh worker sessions are launched using the task-scoped worker bootstrap.
- [ ] Startup success and startup failure are surfaced deterministically in coordinator-managed state/events.
- [ ] Provider-specific launch behavior remains behind adapter interfaces.
- [ ] Worker sessions are not launched merely because a slot is available with no assigned task.
- [ ] The change is covered by targeted coordinator/adapter tests.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `orchestrator/coordinator.test.mjs` — assert the launcher primitive starts a worker session only when a slot/task assignment exists
- adapter tests near the touched adapter modules — assert launcher inputs are passed correctly and startup failures are surfaced cleanly

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs orchestrator/coordinator.test.mjs adapters/*.test.mjs
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

**Risk:** A partially extracted launcher can leave startup logic split across old and new code paths, making later dispatch and cleanup work much harder.
**Rollback:** Restore the prior coordinator session logic, remove the new launcher helper, and rerun the targeted coordinator tests.
