---
ref: general/165-coordinator-pr-finalization
feature: general
priority: high
status: todo
review_level: full
depends_on:
  - general/161-pr-merge-config-schema
  - general/162-git-host-adapter
  - general/164-pr-templates
---

# Task 165 — Implement Coordinator PR Finalization Path

Depends on Tasks 161, 162, 163, 164.

## Scope

**In scope:**
- Add `resolveMergeStrategy()` helper to `coordinator.ts`
- Branch finalization handler on resolved strategy after `work_complete`
- Implement PR path: push branch → create PR → spawn reviewer worker
- Add tick handler for `pr_review_in_progress` (monitor reviewer completion)
- Add PR lease handling (`pr_finalize_lease_ms`)
- Reviewer owns entire PR lifecycle (review, fix, rebase, CI, merge) — coordinator only spawns and monitors
- Add `buildPrReviewerBootstrap()` to `lib/sessionBootstrap.ts`
- Add claim setters for PR fields in `lib/claimStateManager.ts`

**Out of scope:**
- Schema/config changes (Task 161 — already done)
- Git host adapter (Task 162 — already done)
- PR CLI commands (Task 163 — not needed by coordinator; used by reviewer at runtime)
- Templates (Task 164 — already done)
- Worker protocol/docs updates (Task 166)
- Direct finalization path — must remain unchanged

---

## Context

This is the core implementation task. The coordinator's finalization handler currently
assumes direct merge. After `work_complete`, it enters `awaiting_finalize` and manages
the rebase → merge → cleanup flow. The PR path replaces this with: push → create PR →
spawn reviewer → poll until merged.

The PR reviewer is a full worker agent. The coordinator spawns it the same way it spawns
regular workers — register agent, start session, send envelope. The reviewer handles
the review-fix loop, rebase, CI, and merge autonomously. The coordinator monitors
its completion via events.

**Start here:** `coordinator.ts` — search for `awaiting_finalize` and the `work_complete` event handler

**Affected files:**
- `coordinator.ts` — strategy resolver, finalization branching, tick handlers
- `lib/claimStateManager.ts` — PR field setters
- `lib/sessionBootstrap.ts` — PR reviewer bootstrap builder

---

## Goals

1. Must resolve `merge_strategy` per task: `task.merge_strategy ?? config.merge_strategy ?? 'direct'`.
2. Must branch after `work_complete` — direct path unchanged, PR path creates PR and spawns reviewer.
3. Must push the worktree branch to remote before creating the PR.
4. Must create PR with rendered `pr-template-v1.txt` body.
5. Must spawn PR reviewer worker with `pr-reviewer-bootstrap-v1.txt` and `pr-review-envelope-v1.txt`.
6. Must track `pr_review_in_progress` → check reviewer events each tick.
7. Must handle reviewer `work_complete` → merge PR via adapter → cleanup + release.
8. Must handle reviewer `run_failed` → set `pr_failed` → notify + requeue.
9. Must signal reviewer `run-finish` after successful merge.
10. Must use `pr_finalize_lease_ms` for PR claim leases.
11. Must cleanup reviewer agent registration after terminal event.
12. Must not change the direct finalization path.

---

## Implementation

### Step 1 — Strategy resolver

**File:** `coordinator.ts`

```typescript
function resolveMergeStrategy(
  task: { merge_strategy?: string },
  config: CoordinatorConfig,
): 'direct' | 'pr' {
  return (task.merge_strategy ?? config.merge_strategy ?? 'direct') as 'direct' | 'pr';
}
```

### Step 2 — Branch finalization after work_complete

**File:** `coordinator.ts`

In the `work_complete` event handler, after the existing finalization state setup:

```typescript
const strategy = resolveMergeStrategy(task, COORD_CONFIG);
if (strategy === 'pr') {
  // PR path: push, create PR, spawn reviewer
  const adapter = getGitHostAdapter(COORD_CONFIG.pr_provider!);
  const branch = runWorktree.branch;
  adapter.pushBranch(COORD_CONFIG.pr_push_remote, branch);
  const prBody = renderTemplate('pr-template-v1.txt', { task_ref, run_id, ... });
  const prRef = adapter.createPr(task.title, branch, prBody);
  setPrRef(STATE_DIR, runId, prRef);
  setPrCreatedAt(STATE_DIR, runId, new Date().toISOString());
  setRunFinalizationState(STATE_DIR, runId, 'pr_created');
  // Spawn PR reviewer (see Step 3)
  await spawnPrReviewer(claim, prRef, task);
  setRunFinalizationState(STATE_DIR, runId, 'pr_review_in_progress');
} else {
  // Direct path: existing logic unchanged
}
```

### Step 3 — Spawn PR reviewer

**File:** `coordinator.ts`

```typescript
async function spawnPrReviewer(claim, prRef, task) {
  const reviewerAgentId = `pr-reviewer-${claim.run_id}`;
  // Register reviewer agent (same pattern as managed worker registration)
  // Start session with pr-reviewer-bootstrap-v1.txt
  // Send PR_REVIEW envelope with pr-review-envelope-v1.txt
}
```

### Step 4 — Tick handler for pr_review_in_progress

**File:** `coordinator.ts`

The reviewer owns review, fixes, rebase, and CI. It signals `run-work-complete`
when CI is green — meaning "this PR is ready to merge." The coordinator then
merges (same authority model as direct mode).

```typescript
if (claim.finalization_state === 'pr_review_in_progress') {
  const reviewerAgentId = claim.pr_reviewer_agent_id;

  // If reviewer emitted work_complete (via events):
  //   CI is green, PR is ready. Coordinator merges:
  //   adapter.mergePr(claim.pr_ref)
  //   Set pr_merged, cleanup worktree + branch, mark task released.
  //   Signal reviewer to run-finish.
  //   Cleanup reviewer agent registration.

  // If reviewer emitted run_failed:
  //   Set pr_failed, notify master, requeue task.
  //   Cleanup reviewer agent registration.
}
```

No `pr_ci_pending` state. The coordinator merges immediately after the
reviewer's `work_complete` — the reviewer already confirmed CI is green.

### Step 5 — Lease handling

**File:** `coordinator.ts`

When creating claims for PR-mode tasks, or when transitioning to PR finalization states, use `pr_finalize_lease_ms` instead of the standard `finalize_ms`.

### Step 7 — Claim state setters

**File:** `lib/claimStateManager.ts`

Add: `setPrRef()`, `setPrCreatedAt()`, `setPrReviewerAgentId()`. Same pattern as existing setters (`setRunFinalizationState`, `setEscalationNotified`).

### Step 8 — PR reviewer bootstrap builder

**File:** `lib/sessionBootstrap.ts`

Add `buildPrReviewerBootstrap()` that renders `pr-reviewer-bootstrap-v1.txt` with agent_id, provider, session_token, orc_bin.

---

## Acceptance criteria

- [ ] `resolveMergeStrategy()` returns task override, config fallback, or `'direct'` default.
- [ ] PR path: pushes branch, creates PR, stores `pr_ref` and `pr_created_at` on claim.
- [ ] PR path: spawns reviewer worker with correct bootstrap and envelope.
- [ ] Tick handler detects reviewer `work_complete` → merges PR via `adapter.mergePr()` → sets `pr_merged` → cleanup + release.
- [ ] Tick handler signals reviewer `run-finish` after successful merge.
- [ ] Tick handler detects reviewer `run_failed` → sets `pr_failed` → notifies master → requeue.
- [ ] Reviewer agent registration cleaned up after terminal event.
- [ ] PR claims use `pr_finalize_lease_ms` for lease.
- [ ] Direct finalization path is completely unchanged.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `coordinator.test.ts`:

```typescript
describe('PR finalization', () => {
  it('resolveMergeStrategy: task override wins over config', () => { ... });
  it('resolveMergeStrategy: falls back to config, then direct', () => { ... });
  it('pushes branch and creates PR after work_complete when strategy=pr', () => { ... });
  it('spawns PR reviewer worker after PR creation', () => { ... });
  it('merges PR via adapter on reviewer work_complete and sets pr_merged', () => { ... });
  it('signals reviewer run-finish after successful merge', () => { ... });
  it('transitions to pr_failed on reviewer run_failed', () => { ... });
  it('cleans up worktree, branch, and releases task after pr_merged', () => { ... });
  it('cleans up reviewer agent registration after terminal event', () => { ... });
  it('uses pr_finalize_lease_ms for PR claim leases', () => { ... });
  it('direct path unchanged when merge_strategy=direct', () => { ... });
});
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
orc doctor
```

---

## Risk / Rollback

**Risk:** New coordinator finalization path could interfere with direct path if branching is incorrect. Mitigated by: strategy resolution is explicit, direct path code is untouched, PR states are distinct from direct states.
**Risk:** PR reviewer spawning could fail if session infrastructure doesn't support the reviewer bootstrap type. Mitigated by: reviewer uses the same session machinery as regular workers.
**Rollback:** `git restore coordinator.ts lib/claimStateManager.ts lib/sessionBootstrap.ts && npm test`
