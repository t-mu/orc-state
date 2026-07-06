---
ref: sibling-orchestration-repo/187-sibling-mode-phase-4-coordinator-side-spec-status-writeback
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: done
depends_on:
  - sibling-orchestration-repo/184-two-root-path-resolution-and-config-schema
---

# Task 187 — Sibling-mode Phase 4: coordinator-side spec status writeback

Depends on Task 184.

## Scope

In sibling mode, workers no longer edit or commit the task spec markdown; completion is signaled solely via `orc run-work-complete`. Extend the coordinator's post-merge completion path (`orc task-mark-done` / `lib/taskCompletion.ts`) so that in sibling mode it also writes `status: done` into the spec file under the orchestration repo's `backlog/` and creates an automatic commit in the orchestration repo with message `chore(backlog): <task-ref> done`. When the orchestration root is not a git repository, write the file and skip the commit without error. `markTaskDoneRuntimeOnly` remains runtime-only; the writeback is a distinct, tested layer on top. Guard `lib/backlogSync.ts` interactions so the writeback and the next sync tick do not fight (the existing active-status guard already protects claimed/in_progress tasks). Tests cover writeback content, commit creation, non-git graceful degradation, and sync convergence after writeback.

Depends on: 1

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
