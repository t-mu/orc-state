---
ref: global-project-state/225-expose-project-aware-operations-in-cli-and-tui
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/221-make-task-creation-and-revision-apis-storage-neutral
  - global-project-state/223-move-dispatch-and-completion-into-sqlite-transactions
  - global-project-state/224-run-workers-against-a-registered-target-without-repo-local-framework-files
---

# Task 225 — Expose project-aware operations in CLI and TUI

Depends on Tasks 221, 223, and 224.

## Scope

Make status, watch, task editing, run inspection, terminal attach, doctor, preflight, and configuration commands accept the selected project and show its identity. Ensure a user can switch projects without changing repository files or restarting a provider login. Keep the control API's task and run responses consistent with the SQLite store so future desktop and Isolagent clients use the same contract.

Depends on: 4, 6, 7

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
