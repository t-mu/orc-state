---
ref: global-project-state/218-freeze-the-project-and-task-ownership-contracts
feature: global-project-state
review_level: full
priority: normal
status: done
---

# Task 218 — Freeze the project and task ownership contracts

Independent.

## Scope

Document a stable project identifier, the global data-home layout, project selection precedence, and the task lifecycle state machine. Separate task definition, immutable spec revision, lifecycle status, run state, and derived dispatch readiness. Specify that `done` is committed only after merge, that explicit `blocked` differs from dependency waiting, and that no Markdown status field controls dispatch. Map current attached and sibling behavior to each new contract and add contract tests before replacing storage.

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
