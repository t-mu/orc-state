---
ref: global-project-state/219-add-a-global-project-registry-and-configuration-store
feature: global-project-state
review_level: full
priority: normal
status: todo
depends_on:
  - global-project-state/218-freeze-the-project-and-task-ownership-contracts
---

# Task 219 — Add a global project registry and configuration store

Depends on Task 218.

## Scope

Create a global `registry.db` in a platform-appropriate application data directory, overridable by `ORC_DATA_HOME`. Register a stable project id, canonical target Git root, external project state directory, and validated non-secret settings. Add `orc project add`, `list`, `select`, `show`, and `config` operations. Resolve an explicit project flag first, an environment project id second, and a unique registered Git-root match from cwd last; reject ambiguous matches. Define effective configuration precedence as CLI flags, environment, per-project settings, then global defaults. Do not require `orc-state.config.json` or an orchestration repository.

Depends on: 1

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
