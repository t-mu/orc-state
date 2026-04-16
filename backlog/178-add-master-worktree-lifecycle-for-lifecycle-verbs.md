---
ref: lifecycle-verbs/178-add-master-worktree-lifecycle-for-lifecycle-verbs
feature: lifecycle-verbs
review_level: full
priority: normal
status: todo
---

# Task 178 — Add Master Worktree Lifecycle for Lifecycle Verbs

Independent. Blocks Tasks 179 and 180.

## Scope

**In scope:**
- Add reusable master-side worktree helpers for file-writing lifecycle verbs such as `/spec task <id>` and `/plan`.
- Make worktree creation/select/resume behavior automatic for those verb flows.
- Add completion-gated merge and cleanup behavior so branch removal and worktree removal happen only after explicit completion.

**Out of scope:**
- Worker run worktrees managed by the coordinator.
- Generic worktree cleanup for unrelated commands.
- Implementing plan parsing or task generation logic.

---

## Context

The approved lifecycle-verbs design requires file-writing master workflows to stay out of the main checkout by default. Users should be able to issue `/plan ...` or `/spec task <id>` without also having to remind the master to create a separate worktree, merge back through a branch, and keep the worktree alive for review until satisfaction.

The repo already has worker run-worktree support and bootstrap text describing a master worktree policy, but there is no dedicated reusable helper that lifecycle verbs can call to enforce this behavior as runtime logic.

### Current state

`templates/master-bootstrap-v1.txt` documents a manual master worktree workflow, while `lib/runWorktree.ts` only covers coordinator-managed worker runs. There is no shared master-side utility that tracks a long-lived lifecycle-verbs worktree, prevents direct writes on `main`, or gates cleanup on explicit completion.

### Desired state

Lifecycle-verb commands can acquire a dedicated master worktree automatically, resume the same worktree while the user iterates, merge back to `main` only through the worktree branch, and defer branch/worktree cleanup until an explicit completion action is recorded.

### Start here

- `lib/runWorktree.ts` — existing worktree lifecycle helpers for workers
- `templates/master-bootstrap-v1.txt` — current master worktree policy text
- `lib/paths.ts` — path helpers for `.worktrees/` and state

**Affected files:**
- `lib/masterWorktree.ts` — new helper module for master-authored lifecycle work
- `lib/masterWorktree.test.ts` — master worktree lifecycle tests
- `templates/master-bootstrap-v1.txt` — document the new automatic behavior
- `lib/sessionBootstrap.ts` — ensure master bootstrap references stay in sync if needed

---

## Goals

1. Must create or select a dedicated master worktree automatically for file-writing lifecycle verbs.
2. Must support resuming the same worktree while a plan or generated backlog specs are still under review.
3. Must keep integration path merge-only; direct writes on `main` are invalid.
4. Must delay branch deletion and worktree removal until an explicit completion gate is satisfied.
5. Must preserve the existing worker run-worktree lifecycle unchanged.

---

## Implementation

### Step 1 — Add master worktree helper primitives

**File:** `lib/masterWorktree.ts`

Implement a narrow helper layer for:
- allocating a master worktree branch from a slug or workflow handle
- resuming an existing lifecycle-verbs worktree
- marking a worktree ready for merge
- merging back to `main`
- completion-gated cleanup

Do not reuse worker run ids or mutate `run-worktrees.json`; this is master-authored work and should have separate metadata if persistence is needed.

### Step 2 — Cover merge and cleanup ordering

**File:** `lib/masterWorktree.test.ts`

Add tests that prove:
- merge happens before cleanup
- branch deletion happens before `git worktree remove`
- cleanup is blocked until explicit completion state is present
- resume/open behavior does not allocate duplicate worktrees for the same handle

### Step 3 — Align bootstrap guidance with enforced behavior

**File:** `templates/master-bootstrap-v1.txt`

Update the lifecycle-verbs guidance so `/plan` and `/spec task <id>` are described as automatic worktree-backed flows, not a manual “remember to create one” convention.

---

## Acceptance criteria

- [ ] A master-side helper exists for automatic worktree allocation/resume/merge/cleanup for lifecycle-verbs work.
- [ ] Cleanup is gated on explicit completion and does not happen immediately after generation.
- [ ] Cleanup ordering is merge → branch delete → worktree remove.
- [ ] Worker run-worktree behavior remains unchanged.
- [ ] Bootstrap guidance states that `/plan` and `/spec task <id>` default to isolated master worktrees.
- [ ] No changes to plan parsing or task generation land in this task.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to `lib/masterWorktree.test.ts`:

```ts
it('reuses an existing lifecycle-verbs worktree for the same handle', () => { ... });
it('blocks cleanup until explicit completion is recorded', () => { ... });
it('deletes the branch before removing the worktree', () => { ... });
```

---

## Verification

```bash
npx vitest run lib/masterWorktree.test.ts lib/sessionBootstrap.test.ts
```

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Incorrect merge/cleanup ordering could strand branches or remove the worktree before cleanup commands finish.
**Rollback:** git restore lib/masterWorktree.ts lib/masterWorktree.test.ts templates/master-bootstrap-v1.txt lib/sessionBootstrap.ts && npm test
