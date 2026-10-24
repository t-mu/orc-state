---
ref: global-project-state/221-make-task-creation-and-revision-apis-storage-neutral
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/220-put-task-definitions-and-lifecycle-state-in-project-sqlite
---

# Task 221 — Make task creation and revision APIs storage-neutral

Depends on Task 220.

## Scope

Route CLI, MCP, and control API task creation and edits through the project task store. Save each accepted spec edit as an immutable revision with a content hash and parsed metadata. On claim, bind the run to the selected revision and deliver that exact body to the worker. Add compare-and-swap revision checks so concurrent edits cannot silently overwrite each other. A task created through the API must require no Markdown file or repo-local artifact.

Depends on: 3

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
