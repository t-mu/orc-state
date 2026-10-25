---
ref: global-project-state/227-retire-sibling-specific-behavior-and-the-status-mirror
feature: global-project-state
review_level: full
priority: normal
status: done
depends_on:
  - global-project-state/226-migrate-attached-and-sibling-installations-safely
---

# Task 227 — Retire sibling-specific behavior and the status mirror

Depends on Task 226.

## Scope

Remove `orc init --sibling` scaffolding, config-file walk-up as the primary selector, sibling-only spec writeback, attached-versus-sibling worker instructions, and runtime backlog sync from Markdown. Replace sibling layout checks with project health checks for target Git access, external data-home writability, worktree placement, and accidental target-repo artifacts. Keep the reusable two-root Git and sandbox plumbing under project-oriented names. Update docs, templates, and old task-flow instructions to point at the project registry and SQLite status API.

Depends on: 9

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
