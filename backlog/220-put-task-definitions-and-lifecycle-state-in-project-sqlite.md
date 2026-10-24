---
ref: global-project-state/220-put-task-definitions-and-lifecycle-state-in-project-sqlite
feature: global-project-state
review_level: full
priority: normal
status: done
depends_on:
  - global-project-state/218-freeze-the-project-and-task-ownership-contracts
  - global-project-state/219-add-a-global-project-registry-and-configuration-store
---

# Task 220 — Put task definitions and lifecycle state in project SQLite

Depends on Tasks 218, and 219.

## Scope

Add versioned task, task-spec-revision, dependency, and task-transition tables to each project's runtime database. Store the complete Markdown body as text alongside indexed metadata so a database-only task is executable and exportable. Keep task status, attempts, block reason, and timestamps in transactional rows. Use SQLite constraints and migration tests to preserve stable refs and prevent invalid transitions or duplicate active claims. Keep an optional read-only `backlog.json` projection only for callers that cannot migrate in the same step.

Depends on: 1, 2

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
