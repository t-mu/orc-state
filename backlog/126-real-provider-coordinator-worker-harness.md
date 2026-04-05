---
ref: general/126-real-provider-coordinator-worker-harness
feature: general
priority: high
status: todo
depends_on:
  - general/125-real-provider-suite-skeleton-and-isolation
---

# Task 126 — Build Real-Provider Coordinator/Worker Harness

Depends on Task 125. Blocks Task 127.

## Scope

**In scope:**
- Add shared harness code for provider readiness, coordinator startup, staged timeouts, task polling, event assertions, and cleanup
- Seed the exact managed-worker/coordinator state needed for the blessed dispatch path without using a real master session
- Add static blessed-path backlog fixtures for two sequential tasks
- Add path-boundary checks to ensure orchestrator-managed state/worktrees/artifacts stay under the temp repo
- Define failure diagnostics for provider spawnability, dispatch, task completion, and cleanup

**Out of scope:**
- Adding the actual Claude/Codex provider smoke test cases
- Testing `orc start-session` or real master startup
- Testing `input_request`, sandbox-specific behaviors, or cross-provider combinations
- Claiming generic auth verification for provider CLIs

---

## Context

After Task 125 lands, the suite has a safe temp-repo boundary and a worker-visible `orc` command. The next shared layer is the coordinator/worker harness itself: readiness checks, blessed-path fixture tasks, exact managed-worker state seeding, coordinator runner, bounded waits, and containment assertions. This is the context every real-provider smoke case will reuse.

### Current state

The existing `e2e/` tests exercise coordinator logic with mocked adapters or fixture-only boundaries. They do not start a real coordinator against a temp git repo and let it dispatch a real worker provider. There is no reusable harness for staged timeouts, provider spawnability checks, or containment assertions over runtime-managed paths.

### Desired state

The repo should have one reusable coordinator/worker harness that can:
- decide whether a real provider test should run
- seed the exact runtime state for managed dispatch
- start the real coordinator in the temp repo
- wait for lifecycle transitions with explicit per-stage timeouts
- validate that worktrees, artifacts, and state all stay under the temp root
- tear everything down cleanly even after failures

This harness should be provider-agnostic so the final smoke cases can differ only by worker provider.

### Start here

- `coordinator.ts` — understand what state must exist before dispatch happens
- `lib/workerRuntime.ts` — see how worker sessions are launched from coordinator-managed state
- `cli/run-reporting.test.ts` — reference lifecycle event expectations
- `e2e/orchestrationLifecycle.e2e.test.ts` — reference existing coordinator-path assertions, even though it is mocked today

**Affected files:**
- `e2e-real/harness/providerReadiness.ts` — binary/PTY/spawnability gate
- `e2e-real/harness/coordinatorRunner.ts` — real coordinator process lifecycle
- `e2e-real/harness/assertions.ts` — task/run/path polling and staged timeout helpers
- `e2e-real/fixtures/blessedTasks.ts` — two static backlog task specs and temp config seeds
- `e2e-real/harness/managedWorkerSeed.ts` — exact runtime state needed for managed-worker dispatch

---

## Goals

1. Must seed the exact coordinator/worker runtime state needed for the normal managed-worker dispatch path without involving a real master session.
2. Must define provider readiness as binary existence, PTY support, and noninteractive spawnability only, with clear failure diagnostics.
3. Must start and stop the real coordinator in the temp repo through one shared harness.
4. Must enforce explicit staged timeouts for provider readiness, coordinator startup, first dispatch, per-task completion, worker shutdown, coordinator shutdown, and overall test duration.
5. Must provide reusable assertions for task transitions, run event sequencing, worker reuse, and path containment.
6. Must fail if any orchestrator-managed path escapes the temp repo.

---

## Implementation

### Step 1 — Add provider readiness helper

**File:** `e2e-real/harness/providerReadiness.ts`

Implement a helper that checks:
- provider binary exists
- PTY support exists
- CLI is spawnable noninteractively

It must not claim to verify auth unless a provider-specific noninteractive auth probe actually exists. If the provider later fails during startup, the harness should report that as a runtime failure, not as a false “auth passed.”

### Step 2 — Add managed-worker state seeding

**File:** `e2e-real/harness/managedWorkerSeed.ts`

Write the exact temp-repo backlog/agents/claims/state needed for coordinator-managed dispatch so the real coordinator launches one real worker session instead of idling. This should mirror the blessed worker-pool path, not a fake manual dispatch path.

Invariant: do not introduce a real master session or any master-only state.

### Step 3 — Add blessed-path fixtures

**File:** `e2e-real/fixtures/blessedTasks.ts`

Create two static backlog task specs intended for sequential dispatch in the temp repo. Keep them simple and deterministic, but do not make the suite depend on exact byte-stable provider output. The tasks may create temp-repo-local marker files, but the main assertions should remain lifecycle/event/path based.

### Step 4 — Add coordinator runner

**File:** `e2e-real/harness/coordinatorRunner.ts`

Implement start/stop helpers for the real coordinator process using the temp-repo env from Task 125. Capture stdout/stderr for failure diagnostics and expose explicit startup/shutdown waits.

### Step 5 — Add staged timeout and assertion helpers

**File:** `e2e-real/harness/assertions.ts`

Implement helpers like:

```ts
waitForTaskStatus(ref, status, { timeoutMs, stage });
waitForRunEvent(runId, event, { timeoutMs, stage });
waitForWorkerReuse(agentId, { timeoutMs, stage });
assertRuntimePathsInside(repoRoot);
```

Each timeout must fail with a stage-specific message so provider hangs are diagnosable.

---

## Acceptance criteria

- [ ] Provider readiness is defined as binary presence, PTY support, and noninteractive spawnability only.
- [ ] The harness seeds coordinator/worker state so the real coordinator takes the managed dispatch path without a real master.
- [ ] Two static blessed-path task fixtures exist for sequential dispatch in the temp repo.
- [ ] The coordinator runner can start and stop the real coordinator with captured diagnostics.
- [ ] Every wait in the harness uses an explicit stage-specific timeout.
- [ ] The harness can assert task transitions, run events, worker reuse, and runtime path containment.
- [ ] The harness fails when any orchestrator-managed path escapes the temp repo.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add harness-focused tests covering:

```ts
it('seeds the managed-worker dispatch baseline without a master session', () => { ... });
it('reports provider readiness failures with stage-specific diagnostics', async () => { ... });
it('fails when an orchestrator-managed path escapes the temp root', async () => { ... });
it('times out first dispatch with a stage-specific error', async () => { ... });
```

---

## Verification

```bash
npx vitest run e2e-real/harness/*.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** If the harness seeds the wrong runtime baseline, the coordinator may idle or follow a non-blessed path, giving false confidence while never exercising real managed dispatch.
**Rollback:** git restore e2e-real/harness e2e-real/fixtures && npm test
