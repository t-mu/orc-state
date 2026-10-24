---
ref: global-project-state/224-run-workers-against-a-registered-target-without-repo-local-framework-files
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/219-add-a-global-project-registry-and-configuration-store
  - global-project-state/223-move-dispatch-and-completion-into-sqlite-transactions
---

# Task 224 — Run workers against a registered target without repo-local framework files

Depends on Tasks 219, and 223.

## Scope

Resolve target Git operations from the selected project's registry entry and place run worktrees, provider settings, logs, plans, and state under the external project data directory. Propagate project identity and an authenticated local control endpoint to worker sessions; use the external state path only as a temporary compatibility bridge. Update sandbox grants for the assigned worktree, required target `.git` write subtrees, and the control transport. Verify Codex, Claude, CLI runtime, and structured runtime launches without `ORC_HOME` discovery or a config file in the target repo.

Depends on: 2, 6

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
