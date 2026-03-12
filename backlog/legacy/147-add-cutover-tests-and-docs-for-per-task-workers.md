---
ref: orch/task-147-add-cutover-tests-and-docs-for-per-task-workers
epic: orch
status: todo
---

# Task 147 — Add Cutover Tests and Docs for Per-Task Workers

Depends on Tasks 145 and 146.

## Scope

**In scope:**
- orchestrator integration/e2e tests that cover the full per-task-worker lifecycle
- `orchestrator/README.md` and related docs — document the new default execution model and fallback/debug paths
- any remaining coordinator/docs defaults needed to make per-task workers the documented standard behavior

**Out of scope:**
- Foundational runtime changes that should have landed in earlier migration tasks
- New worker bootstrap or dispatch features beyond what verification exposes
- Backfilling old backlog task specs

---

## Context

By the time the earlier migration tasks land, the orchestrator should be functionally capable of running fresh workers per task and presenting that model to the operator. The final step is to prove the cutover with focused integration coverage and to align the top-level docs so the new behavior is the default documented path rather than an implementation detail.

This task is intentionally last. It should validate the end-to-end behavior after the runtime, status, and UX changes are already in place.

### Current state

Existing tests cover pieces of coordinator lifecycle and worker control, but they were written around the persistent-worker model. The top-level docs still describe manual worker management in places, and there is no single end-to-end verification pass for the new per-task-worker model.

### Desired state

The repo should have end-to-end coverage showing that the orchestrator can run with one master session and coordinator-managed per-task workers under a configured worker cap. The docs should present that as the normal model, with manual worker commands documented only as advanced/debug tools if they remain.

### Start here

- `e2e/orchestrationLifecycle.e2e.test.mjs` — current end-to-end lifecycle coverage
- `e2e/worker-control-flow.e2e.test.mjs` — current worker-oriented integration coverage
- `orchestrator/README.md` — current top-level orchestrator docs

<!-- Optional:
### Dependency context

Tasks 141-146 establish the new runtime, bootstrap, startup UX, and status model. This task verifies the full cutover and makes the new per-task-worker model the documented default.
-->

**Affected files:**
- `e2e/orchestrationLifecycle.e2e.test.mjs` — end-to-end lifecycle verification
- `e2e/worker-control-flow.e2e.test.mjs` — worker-control scenarios adjusted for debug-only/manual paths
- `orchestrator/README.md` — final cutover documentation
- any additional orchestrator integration tests needed to cover worker-cap enforcement

---

## Goals

1. Must add end-to-end verification for the per-task-worker execution model.
2. Must verify configured worker-cap behavior and queued work under load.
3. Must document the new model as the default operator workflow.
4. Must document any remaining manual worker commands as debug/fallback tools only.
5. Must leave the repo with a clear, test-backed migration landing point.

---

## Implementation

### Step 1 — Add end-to-end coverage for the new runtime model

**Files:**
- `e2e/orchestrationLifecycle.e2e.test.mjs`
- `e2e/worker-control-flow.e2e.test.mjs`

Add scenarios that prove the coordinator launches task-scoped workers on demand, respects `max_workers`, cleans up finished runs, and continues to operate with only a foreground master session.

### Step 2 — Verify queued-work and failure behavior under the worker cap

**Files:**
- integration/e2e tests under `e2e/`

Cover at least one case where more dispatchable tasks exist than available worker slots, and one case where a worker start or run fails and the system recovers deterministically.

### Step 3 — Finalize documentation

**File:** `orchestrator/README.md`

Document the new default startup and execution model, the meaning of worker capacity/status, and the role of any remaining manual worker commands.

---

## Acceptance criteria

- [ ] The repo contains end-to-end coverage for coordinator-managed per-task workers.
- [ ] Tests cover worker-cap enforcement and queued work behavior.
- [ ] Tests cover at least one startup or run failure recovery path in the new model.
- [ ] README presents per-task workers as the default behavior and manual worker commands as debug/fallback paths only.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `e2e/orchestrationLifecycle.e2e.test.mjs` — full per-task-worker lifecycle
- `e2e/worker-control-flow.e2e.test.mjs` — debug/manual worker paths in the new world
- any targeted integration test needed for worker-cap queueing

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.e2e.config.mjs e2e/orchestrationLifecycle.e2e.test.mjs e2e/worker-control-flow.e2e.test.mjs
npx vitest run -c orchestrator/vitest.integration.config.mjs
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

**Risk:** If the final docs and e2e coverage lag behind the runtime changes, the repo can appear “done” while still being difficult to operate or verify.
**Rollback:** Keep the runtime changes behind explicit documentation caveats until the e2e coverage and top-level docs reflect the new default path.
