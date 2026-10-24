---
ref: global-project-state/222-make-markdown-an-explicit-portable-interface
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/221-make-task-creation-and-revision-apis-storage-neutral
---

# Task 222 — Make Markdown an explicit portable interface

Depends on Task 221.

## Scope

Provide task import from a specified file or directory outside or inside a repo, and task export to a caller-chosen path. Render readable Markdown from SQLite task content and metadata. Import an old `status` field only during the migration in Step 9; ordinary imports ignore or reject lifecycle fields and never reset runtime status. Record optional source path and revision information for diagnostics, but do not auto-watch files or perform two-way status sync. Keep plans available as readable Markdown export while allowing their metadata and content to live in project state.

Depends on: 4

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
