---
ref: global-project-state/223-move-dispatch-and-completion-into-sqlite-transactions
feature: global-project-state
review_level: full
priority: normal
status: done
depends_on:
  - global-project-state/220-put-task-definitions-and-lifecycle-state-in-project-sqlite
  - global-project-state/221-make-task-creation-and-revision-apis-storage-neutral
---

# Task 223 — Move dispatch and completion into SQLite transactions

Depends on Tasks 220, and 221.

## Scope

Change scheduler, claims, run commands, coordinator finalization, and status queries to use project-scoped task rows. Claim creation must atomically verify status and dependencies, claim the task, create the run, and append its event. Failure and reset must atomically update run and task status with the corresponding event. Work-complete leaves the task in progress; successful merge records `done` once. Keep terminal retries idempotent. Remove any requirement for a worker or coordinator to edit `status:` in a task file.

Depends on: 3, 4

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
