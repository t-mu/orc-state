---
ref: global-project-state/228-prove-the-clean-repo-cli-and-tui-workflow
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/225-expose-project-aware-operations-in-cli-and-tui
  - global-project-state/226-migrate-attached-and-sibling-installations-safely
  - global-project-state/227-retire-sibling-specific-behavior-and-the-status-mirror
---

# Task 228 — Prove the clean-repo CLI and TUI workflow

Depends on Tasks 225, 226, and 227.

## Scope

Use a disposable target Git repo with no orc files to register a project, create a database-only task, import and export a Markdown task outside the repo, dispatch concurrent workers, inspect and attach through the CLI/TUI, recover a coordinator restart, and finish through merge. Assert that only intended product commits appear in the target working tree, task status and config survive new sessions, `orc doctor` passes, and a stale Markdown export cannot requeue a completed task. Run the existing unit and E2E suites plus focused migration tests before declaring the old sibling path retired.

Depends on: 8, 9, 10

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
