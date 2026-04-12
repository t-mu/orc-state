---
ref: general/169-harden-pr-finalization-state-machine
feature: general
priority: high
status: todo
review_level: full
depends_on: []
---

# Task 169 — Harden PR Finalization State Machine

## Scope

**In scope:**
- Fix `coordinator.ts` so PR merge finalization only reacts to reviewer-owned completion events.
- Prevent `pr_review_in_progress` from being entered when reviewer registration/startup/envelope delivery fails.
- Clean up synthetic PR reviewer agents after terminal PR outcomes instead of leaving them as idle workers.
- Extend coordinator/e2e tests for the PR reviewer lifecycle and failure paths.

**Out of scope:**
- Git host adapter command semantics such as upstream push flags.
- PR template content changes.
- Worker/bootstrap documentation updates.

## Context

The PR strategy path is implemented, but the state machine has several correctness holes:

- once a claim enters `pr_review_in_progress`, any later `work_complete` on the main run can trigger merge, even if it came from the original worker rather than the PR reviewer;
- reviewer startup failure still advances the claim into PR review mode, which can strand the run with no live reviewer;
- synthetic reviewers are registered as ordinary `worker` agents and are only idled after success/failure, so they remain in `agents.json` and can pollute future dispatch capacity.

These are runtime bugs, not just test gaps. They can cause premature merge, stuck finalization, or leaked reviewer capacity.

**Affected files:**
- `coordinator.ts` — PR finalization branching, reviewer startup, cleanup, and event gating.
- `lib/agentRegistry.ts` — use existing removal semantics if needed by coordinator cleanup.
- `coordinator.test.ts` — coordinator state-machine regression coverage.
- `e2e/pr-lifecycle.e2e.test.ts` — full-path assertions for reviewer lifecycle correctness.

## Goals

1. Must merge a PR only when the event comes from `claim.pr_reviewer_agent_id`, not from the original worker.
2. Must not transition to `pr_review_in_progress` unless reviewer registration, startup, and envelope delivery all succeed.
3. Must fail or block the claim with a clear reason when reviewer startup fails, rather than leaving it stranded.
4. Must remove synthetic PR reviewer agents from runtime state after terminal PR outcomes.
5. Must preserve the existing direct finalization path.
6. Must add regression tests for duplicate original-worker `work_complete`, reviewer startup failure, and reviewer cleanup.

## Implementation

### Step 1 — Gate PR merge on reviewer-owned completion

**File:** `coordinator.ts`

Tighten the `pr_review_in_progress` branch inside `finalizeRun()` and the event trigger path so merge only occurs when the current event is attributable to the reviewer agent.

Use one of these patterns:
- pass the triggering `agent_id`/event into `finalizeRun()`, or
- guard before calling `finalizeRun()` when the claim is in PR review mode.

Required invariant:

```ts
if (claim.finalization_state === 'pr_review_in_progress' && event.agent_id !== claim.pr_reviewer_agent_id) {
  // ignore stale/original worker event
}
```

Do not allow duplicate `work_complete` from the original worker to short-circuit review/CI.

### Step 2 — Fail cleanly when reviewer spawn fails

**File:** `coordinator.ts`

Change the PR handoff path so `pr_review_in_progress` is only set after:
- reviewer agent registration succeeds
- reviewer session starts
- PR review envelope is sent successfully

If any of those fail:
- do not set `pr_review_in_progress`
- leave the claim in a recoverable blocked/failed finalization state with a precise reason
- do not extend the PR review lease into a long-lived stuck window without a reviewer
- if a synthetic reviewer agent was already registered before startup failed, or was registered/started before envelope delivery failed, remove it immediately rather than leaving an idle/leaked worker record behind

### Step 3 — Remove reviewer agents after terminal or partial PR-review outcomes

**Files:** `coordinator.ts`, optionally `lib/agentRegistry.ts`

After:
- reviewer registration succeeds but session startup fails
- reviewer registration/session startup succeeds but envelope delivery fails
- successful PR merge
- reviewer `run_failed`

the synthetic `pr-reviewer-<run_id>` agent must be removed from runtime state, not merely marked idle.

Use existing agent-removal primitives rather than inventing a PR-specific partial cleanup path.

### Step 4 — Strengthen coordinator and E2E tests

**Files:** `coordinator.test.ts`, `e2e/pr-lifecycle.e2e.test.ts`

Add or update tests for:
- original worker emits duplicate `work_complete` after PR handoff → no merge
- reviewer startup failure → claim does not get stuck in `pr_review_in_progress`
- terminal PR outcomes remove the reviewer agent from `agents.json`
- direct mode remains unchanged

## Acceptance criteria

- [ ] The coordinator ignores `work_complete`/`ready_to_merge` from the original worker once `pr_review_in_progress` begins.
- [ ] PR merge occurs only after reviewer-owned completion.
- [ ] Reviewer startup failure does not leave the claim stranded in `pr_review_in_progress`.
- [ ] Reviewer startup failure produces a clear blocked/failed reason.
- [ ] Partial reviewer startup failures, including startup failure after registration and envelope-delivery failure after registration/startup, do not leak synthetic reviewer agents.
- [ ] Synthetic PR reviewer agents are removed from runtime state after terminal PR outcomes and after partial reviewer startup failures that occur after registration.
- [ ] Direct merge strategy behavior remains unchanged.
- [ ] `npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

- Add a `coordinator.test.ts` case where the original worker emits a duplicate `work_complete` after PR handoff and assert `mergePr()` is not called.
- Add a `coordinator.test.ts` case where reviewer session startup returns failure and assert the claim does not advance to `pr_review_in_progress`.
- Add a `coordinator.test.ts` case where reviewer registration succeeds but session startup fails, and assert the synthetic reviewer agent is removed.
- Add a `coordinator.test.ts` case where reviewer registration/session startup succeeds but envelope delivery fails, and assert the synthetic reviewer agent is removed.
- Update `e2e/pr-lifecycle.e2e.test.ts` to assert reviewer agent removal from `agents.json`, not just `session_handle === null`.
- Keep a direct-mode regression test proving PR logic does not interfere with normal finalization.

## Verification

```bash
nvm use 24 && npm test
```

```bash
npx vitest run coordinator.test.ts e2e/pr-lifecycle.e2e.test.ts
```

## Risk / Rollback

**Risk:** Tightening PR finalization gating can accidentally suppress legitimate reviewer completion events if event identity is wired incorrectly.

**Rollback:** `git restore coordinator.ts coordinator.test.ts e2e/pr-lifecycle.e2e.test.ts lib/agentRegistry.ts && npm test`
