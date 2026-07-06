---
ref: sibling-orchestration-repo/186-worktree-and-merge-operations-against-the-target-repo
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: todo
depends_on:
  - sibling-orchestration-repo/185-call-site-audit-orchestration-root-vs-target-repo-consumers
---

# Task 186 — Worktree and merge operations against the target repo

Depends on Task 185.

## Scope

Update `lib/runWorktree.ts` so run worktrees are created as worktrees of the target repo but placed under the orchestration root's `WORKTREES_DIR`. Update the coordinator's direct-mode merge/cleanup sequence and the PR-mode operations (fetch, rebase, push, pr-status) in `coordinator.ts` and `lib/runCommands.ts` to execute git against the target repo root. Verify the AGENTS.md cleanup ordering (merge from main checkout, delete branch, remove worktree last) still holds when the main checkout is the target repo and the worktree lives under the orchestration root. Tests use two temporary git repos to assert worktree placement, merge target, and that no framework files appear in the target repo after a merge.

Depends on: 2

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
