---
ref: general/168-eliminate-separate-pr-reviewer
feature: general
priority: high
status: todo
review_level: full
---

# Task 168 — Eliminate Separate PR Reviewer, Reuse Existing Worker

Independent.

## Scope

**In scope:**
- Remove `spawnPrReviewer()` function and all separate reviewer agent logic from `coordinator.ts`
- Remove `pr_reviewer_agent_id` from claim schema and types
- Delete `templates/pr-reviewer-bootstrap-v1.txt`
- Repurpose `templates/pr-review-envelope-v1.txt` as a coordinator-to-worker message
- Remove `buildPrReviewerBootstrap()` from `lib/sessionBootstrap.ts`
- Update `templates/worker-bootstrap-v2.txt` Phase 5: worker receives `PR_REVIEW` message and handles review/rebase/CI/push/work_complete
- Update `AGENTS.md` Phase 5 to match single-worker PR flow
- Update coordinator: after PR created, send `PR_REVIEW` into existing worker session
- Update all PR-related tests to single-worker flow

**Out of scope:**
- Git host adapter changes (`general/169-fix-pr-cli-body-upstream`)
- PR CLI config path fix (`general/169-fix-pr-cli-body-upstream`)
- PR body rendering fix (`general/169-fix-pr-cli-body-upstream`)
- Do not modify the `renderTemplate('pr-template-v1.txt', ...)` call — that's Task 169's scope
- Direct finalization path — must remain unchanged

---

## Context

The current PR strategy spawns a separate `pr-reviewer-<run_id>` agent for each PR.
This causes 5 bugs: premature merge from wrong agent's `work_complete`, stuck claims
on reviewer spawn failure, leaked reviewer agents in `agents.json`, the original worker's
session staying alive after reviewer spawn, and external PR closure not detected.

Four of these bugs (premature merge, stuck claims, leaked agents, stale session) are
eliminated by reusing the existing worker. External PR closure detection remains a
separate contract choice — not automatically solved by same-worker reuse, but mitigated
by the worker's own CI polling which will fail if the PR is closed.

The worker is already alive, has context, has the worktree. The coordinator sends a
`PR_REVIEW` message into the worker's existing PTY session — the same pattern as
`FINALIZE_REBASE_REQUEST` in direct mode.

The worker's Phase 5 becomes:
- **Direct mode:** Receive finalize rebase request → rebase → `run-work-complete` → coordinator merges → `run-finish`
- **PR mode:** Receive `PR_REVIEW` message → rebase onto main → review-fix loop (spawn sub-agents per review_level) → pre-push rebase → push → wait for CI (`orc pr-status --wait`) → `run-work-complete` → coordinator merges PR → `run-finish`

Same lifecycle, same signals, same agent. Coordinator always owns merge.

**Start here:** `coordinator.ts` line 623 (`spawnPrReviewer` function)

**Affected files:**
- `coordinator.ts` — remove spawnPrReviewer, send PR_REVIEW to existing worker
- `schemas/claims.schema.json` — remove `pr_reviewer_agent_id`
- `types/claims.ts` — remove `pr_reviewer_agent_id`
- `lib/sessionBootstrap.ts` — remove `buildPrReviewerBootstrap()`
- `lib/claimStateManager.ts` — remove `setPrReviewerAgentId()` if present
- `templates/pr-reviewer-bootstrap-v1.txt` — delete
- `templates/pr-review-envelope-v1.txt` — add review_level and acceptance_criteria fields
- `templates/worker-bootstrap-v2.txt` — add PR mode Phase 5 instructions
- `AGENTS.md` — update Phase 5
- `coordinator.test.ts` — update PR finalization tests
- `e2e/pr-lifecycle.e2e.test.ts` — update to single-worker flow

---

## Goals

1. Must eliminate all separate PR reviewer agent logic (spawn, register, bootstrap).
2. Must send `PR_REVIEW` message into existing worker's PTY session after PR creation.
3. Must handle worker's `run-work-complete` during `pr_review_in_progress` as "PR is ready to merge."
4. Must have coordinator merge PR via `adapter.mergePr()` after worker signals ready.
5. Must signal worker `run-finish` after successful PR merge.
6. Must handle worker `run-fail` during PR review as `pr_failed` → requeue.
7. Must preserve direct finalization path unchanged.
8. Must remove `pr_reviewer_agent_id` from schema and types.
9. Must delete `pr-reviewer-bootstrap-v1.txt`.

---

## Implementation

### Step 1 — Remove spawnPrReviewer and reviewer bootstrap

**Files:** `coordinator.ts`, `lib/sessionBootstrap.ts`

Delete `spawnPrReviewer()` (lines 623-690). Delete `buildPrReviewerBootstrap()` from `lib/sessionBootstrap.ts`. Delete `templates/pr-reviewer-bootstrap-v1.txt`.

### Step 2 — Send PR_REVIEW to existing worker

**File:** `coordinator.ts`

In the PR finalization path (after pushing branch and creating PR, around line 835), replace the `spawnPrReviewer()` call with:

```typescript
const agent = getAgent(STATE_DIR, claim.agent_id);
if (!agent?.session_handle) {
  // Worker session is gone — cannot deliver PR_REVIEW. Block finalization.
  return markFinalizeBlocked(claim, workerPoolConfig,
    'worker session_handle missing at PR_REVIEW send time');
}
const prReviewMessage = renderTemplate('pr-review-envelope-v1.txt', {
  pr_ref: prRef,
  run_id: claim.run_id,
  task_ref: claim.task_ref,
  review_level: task?.review_level ?? 'full',
  acceptance_criteria: task?.acceptance_criteria?.join('\n') ?? '',
  assigned_worktree: runWorktree.worktree_path,
  orc_bin: resolveOrcBinSh(REPO_ROOT),
});
const adapter = getAdapter(agent.provider);
await adapter.send(agent.session_handle, prReviewMessage);
setRunFinalizationState(STATE_DIR, claim.run_id, claim.agent_id,
  { finalizationState: 'pr_review_in_progress' });
```

### Step 3 — Simplify PR merge trigger in finalizeRun

**File:** `coordinator.ts`

The existing `pr_review_in_progress` branch in `finalizeRun()` (line 733) already merges. Remove all `pr_reviewer_agent_id` checks — the original worker is the only agent. `work_complete` from the worker during `pr_review_in_progress` means "CI green, PR ready."

### Step 4 — Simplify run_failed handling

**File:** `coordinator.ts`

In the `run_failed` handling (line 1870), remove the `pr_reviewer_agent_id === agentId` check. Replace with `claim.agent_id === agentId` (same agent).

### Step 5 — Remove pr_reviewer_agent_id

**Files:** `schemas/claims.schema.json`, `types/claims.ts`, `coordinator.ts`, `lib/claimStateManager.ts`

Remove field from schema, type, and all code references. Remove `setPrReviewerAgentId()`.

### Step 6 — Update PR_REVIEW envelope

**File:** `templates/pr-review-envelope-v1.txt`

Add `review_level` and `acceptance_criteria` fields so the worker knows how to spawn reviewers:

```
PR_REVIEW
pr_ref: {{pr_ref}}
run_id: {{run_id}}
task_ref: {{task_ref}}
review_level: {{review_level}}
acceptance_criteria: {{acceptance_criteria}}
assigned_worktree: {{worktree_path}}
orc_bin: {{orc_bin}}
PR_REVIEW_END
```

### Step 7 — Add PR mode Phase 5 to worker bootstrap

**File:** `templates/worker-bootstrap-v2.txt`

Add after the direct mode Phase 5 instructions:

```
PR MODE — when you receive a PR_REVIEW message:

STEP A — Rebase onto main:
  git fetch origin main && git rebase origin/main
  Resolve conflicts iteratively. run-fail if unresolvable.

STEP B — Review-fix loop (max 3 iterations):
  Generate diff: git diff main...HEAD
  Spawn sub-agents per review_level from PR_REVIEW message
  (none=self-review, light=one reviewer, full=critic+integrator).
  Collect findings via orc review-read.
  If findings: fix, commit, loop.
  If approved: exit loop.
  If iteration > 3: run-fail --policy=requeue.

STEP C — Pre-push rebase:
  git fetch origin main && git rebase origin/main
  npm test — if fails, back to Step B (counts against limit).

STEP D — CI loop (max 3 iterations):
  git push --force-with-lease
  orc pr-status <pr_ref> --wait
  If passing: exit loop.
  If failing: diagnose, fix, commit, loop.
  If iteration > 3: run-fail --policy=requeue.

STEP E — Signal ready:
  orc run-work-complete
  Wait for coordinator to merge PR and signal run-finish.
```

### Step 8 — Update AGENTS.md Phase 5

**File:** `AGENTS.md`

Replace the current PR mode text ("session ends, separate reviewer takes over") with the single-worker flow matching Step 7.

### Step 9 — Update tests

**Files:** `coordinator.test.ts`, `e2e/pr-lifecycle.e2e.test.ts`

Remove all reviewer agent spawn/cleanup/deregister assertions. Update:
- PR finalization: `adapter.send()` called with PR_REVIEW message to existing worker
- `work_complete` from original worker during `pr_review_in_progress` triggers `mergePr()`
- `run_failed` during `pr_review_in_progress` sets `pr_failed`
- No reviewer agent in `agents.json` at any point
- Direct mode regression tests unchanged

---

## Acceptance criteria

- [ ] `spawnPrReviewer()` deleted.
- [ ] `buildPrReviewerBootstrap()` deleted.
- [ ] `pr-reviewer-bootstrap-v1.txt` deleted.
- [ ] `pr_reviewer_agent_id` removed from claims schema and type.
- [ ] Coordinator sends `PR_REVIEW` into existing worker's PTY after PR creation.
- [ ] Worker `work_complete` during `pr_review_in_progress` triggers PR merge via adapter.
- [ ] Worker `run_fail` during `pr_review_in_progress` sets `pr_failed` and requeues.
- [ ] Coordinator signals worker `run-finish` after PR merge.
- [ ] Worker bootstrap Phase 5 has PR mode instructions (rebase → review → CI → work_complete).
- [ ] AGENTS.md Phase 5 updated for single-worker PR flow.
- [ ] No separate reviewer agent registered at any point in PR path.
- [ ] Direct finalization path completely unchanged.
- [ ] `npm test` passes.
- [ ] `npm run test:e2e` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Update `coordinator.test.ts`:
```typescript
it('sends PR_REVIEW to existing worker instead of spawning reviewer', () => { ... });
it('merges PR on worker work_complete during pr_review_in_progress', () => { ... });
it('sets pr_failed on worker run_fail during pr_review_in_progress', () => { ... });
it('no reviewer agent registered during PR path', () => { ... });
it('direct path unchanged', () => { ... });
```

Update `e2e/pr-lifecycle.e2e.test.ts`:
```typescript
it('single worker handles entire PR lifecycle', () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm test
npm run test:e2e
```

---

## Risk / Rollback

**Risk:** Worker's PTY session must accept PR_REVIEW message format. Mitigated by: same `adapter.send()` as FINALIZE_REBASE_REQUEST.
**Rollback:** `git restore coordinator.ts lib/sessionBootstrap.ts lib/claimStateManager.ts schemas/claims.schema.json types/claims.ts templates/ AGENTS.md coordinator.test.ts e2e/ && npm test`
