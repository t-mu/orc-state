---
ref: global-project-state/226-migrate-attached-and-sibling-installations-safely
feature: global-project-state
review_level: full
priority: normal
status: done
depends_on:
  - global-project-state/222-make-markdown-an-explicit-portable-interface
  - global-project-state/223-move-dispatch-and-completion-into-sqlite-transactions
  - global-project-state/224-run-workers-against-a-registered-target-without-repo-local-framework-files
  - global-project-state/225-expose-project-aware-operations-in-cli-and-tui
---

# Task 226 — Migrate attached and sibling installations safely

Depends on Tasks 222, 223, 224, and 225.

## Scope

Add a dry-run migration command that detects the old layout, inventories specs, config, `backlog.json`, plans, runs, events, and worktrees, and reports conflicting refs or statuses. On execution, back up original state, import definitions and revisions, preserve runtime task status over stale frontmatter, preserve history, and register the target repository. Make retries idempotent and verify parity before switching the project to SQLite authority. Do not delete old directories automatically; provide a separate cleanup report after verification.

Depends on: 5, 6, 7, 8

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
