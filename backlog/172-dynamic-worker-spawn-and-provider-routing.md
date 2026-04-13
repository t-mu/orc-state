---
ref: dynamic-workers/172-dynamic-worker-spawn-and-provider-routing
feature: dynamic-workers
review_level: full
priority: high
status: done
depends_on:
  - dynamic-workers/171-ephemeral-worker-naming-and-capacity
---

# Task 172 — Spawn Task-Scoped Workers and Resolve Provider at Dispatch

Depends on Task 171. Blocks Task 173.

## Scope

**In scope:**
- Refactor coordinator dispatch to spawn fresh task-scoped workers instead of selecting from pre-existing worker slots.
- Resolve worker provider dynamically from task state, using `required_provider` when present and a configured default when absent.
- Register the spawned worker as a live ephemeral agent, launch its session, and remove it on terminal cleanup.
- Update failure and recovery paths so dead worker sessions free capacity and do not leave synthetic worker state behind.

**Out of scope:**
- TUI/status rendering and operator-facing CLI presentation updates.
- Changing scout/master provider selection behavior.
- Reworking unrelated task-routing semantics beyond what is required for per-task worker provider dispatch.

---

## Context

The current coordinator path assumes a fixed pool of registered worker slots that already exist before dispatch. That assumption blocks mixed-provider execution and couples dispatch to worker inventory instead of task requirements.

After Task 171, capacity will be tracked without synthetic idle workers. The next step is to make dispatch create the actual worker needed for the task at the moment of claim. That means provider selection moves into the dispatch path: when a task requires Claude, spawn Claude; when it requires Codex, spawn Codex; when it specifies nothing, use the configured default worker provider.

This task defines the new runtime behavior that the user-facing architecture depends on: no permanent worker pool, no provider-bound slot identities, and task-scoped live workers that exist only for the life of the run.

**Start here:**
- `coordinator.ts` — current dispatch and worker-start flow
- `lib/workerRuntime.ts` — worker session launch path using `agent.provider`
- `lib/taskRouting.ts` — existing `required_provider` routing logic

**Affected files:**
- `coordinator.ts` — switch from slot selection to capacity-based worker spawning
- `lib/workerRuntime.ts` — register and launch ephemeral workers with resolved providers
- `lib/taskRouting.ts` — preserve and tighten provider-eligibility checks if needed
- `lib/providers.ts` — define default worker-provider fallback without implying homogeneous pools
- `types/backlog.ts` — confirm task-level provider field contract
- `coordinator.test.ts` and related runtime tests — cover dynamic provider spawning and cleanup

---

## Goals

1. Must spawn a fresh worker when dispatching an eligible task and capacity is available.
2. Must choose the worker provider from task state at dispatch time, honoring `required_provider`.
3. Must use a deterministic configured default provider when a task does not require a specific provider.
4. Must register the worker as a live ephemeral agent only for the duration of that run.
5. Must remove the worker record on terminal success or failure.
6. Must free capacity immediately when a task-scoped worker dies or is cleaned up.
7. Must define explicit cleanup and claim handling when registration, session launch, or envelope delivery fails after the task has been claimed.
8. Must allow different worker providers to run in parallel when multiple tasks are active.

---

## Implementation

### Step 1 — Resolve worker provider at dispatch time

**Files:** `coordinator.ts`, `lib/providers.ts`, `types/backlog.ts`

Add a single dispatch-time resolver:

```ts
const provider = task.required_provider ?? workerDefaults.provider;
```

Keep the fallback deterministic and explicit in config. Do not preserve the old assumption that all workers come from one homogeneous provider pool.

### Step 2 — Replace slot selection with worker spawning

**File:** `coordinator.ts`

Refactor dispatch so it:
- checks computed available capacity
- claims the task
- generates a live worker name
- registers a fresh worker agent with the resolved provider
- launches the PTY session
- hands the task envelope to that worker

Do not keep a pre-existing worker-selection branch for the normal path.

If any step after claim creation fails, the implementation must perform explicit cleanup:
- remove any partially registered worker record
- stop any PTY/session handle that was already created
- release consumed capacity
- fail or requeue the claim with a clear reason according to the current lifecycle contract

Do not leave the task stranded in `claimed` or `in_progress` because worker boot failed mid-dispatch.

### Step 3 — Make cleanup task-scoped

**Files:** `coordinator.ts`, `lib/workerRuntime.ts`

On terminal success or failure:
- stop the session if still live
- remove the worker record
- release capacity

When a worker dies unexpectedly, treat it as loss of that run’s task-scoped session, not as a dead reusable slot that needs repair.

### Step 4 — Update routing and failure tests

**Files:** `coordinator.test.ts`, `lib/taskRouting.test.ts`, `lib/workerRuntime.test.ts`

Cover these cases:
- task with `required_provider: claude` spawns Claude
- task without `required_provider` uses default worker provider
- two active tasks can spawn different providers in parallel
- dead task-scoped worker cleanup removes the agent and frees capacity

---

## Acceptance criteria

- [ ] Dispatch spawns fresh workers instead of selecting from a persistent worker slot pool.
- [ ] `required_provider` controls worker provider selection when present.
- [ ] A configured default provider is used only when a task does not require a provider.
- [ ] Different worker providers can be active at the same time under one coordinator.
- [ ] Worker agent records exist only while the live task-scoped session exists.
- [ ] Terminal cleanup removes the worker record and frees capacity.
- [ ] Unexpected worker death is handled as run/session loss, not slot repair.
- [ ] Registration, session-launch, and task-envelope send failures after claim creation stop any live session handle, clean up partial state, and leave no stranded claim or live worker record.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update tests in `coordinator.test.ts`:

```ts
it('spawns a claude worker when task.required_provider is claude', () => { ... });
it('spawns a default-provider worker when task.required_provider is absent', () => { ... });
it('runs codex and claude workers in parallel when separate tasks require different providers', () => { ... });
it('removes a task-scoped worker record after terminal cleanup', () => { ... });
it('cleans up worker state and requeues when session launch fails after claim creation', () => { ... });
it('cleans up worker state and requeues when task envelope delivery fails after launch', () => { ... });
it('stops a launched PTY session when post-claim dispatch fails', () => { ... });
```

Add or update tests in `lib/workerRuntime.test.ts`:

```ts
it('launches a worker session using the provider resolved at dispatch time', () => { ... });
it('treats dead worker cleanup as terminal session cleanup rather than slot repair', () => { ... });
```

---

## Verification

```bash
npx vitest run coordinator.test.ts lib/taskRouting.test.ts lib/workerRuntime.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Dispatch-time worker spawning touches the coordinator’s core lifecycle and can introduce double-dispatch, leaked runs, stranded claims, or provider misrouting if capacity accounting and cleanup diverge.
**Rollback:** `git restore coordinator.ts lib/workerRuntime.ts lib/taskRouting.ts lib/providers.ts types/backlog.ts && npm test`
