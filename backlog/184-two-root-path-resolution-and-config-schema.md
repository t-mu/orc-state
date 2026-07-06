---
ref: sibling-orchestration-repo/184-two-root-path-resolution-and-config-schema
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: todo
---

# Task 184 — Two-root path resolution and config schema

Independent.

## Scope

Add a `target_repo` key (relative-to-config or absolute path) to `orc-state.config.json`, its JSON schema under `schemas/`, and the config loader. Introduce `resolveOrchestrationRoot()` in `lib/repoRoot.ts` with precedence: `ORC_HOME` env var, then directory walk-up from cwd locating `orc-state.config.json`, then the existing `resolveRepoRoot()` git-based behavior as fallback. Introduce `resolveTargetRepoRoot()`: `target_repo` from config resolved against the orchestration root, defaulting to the orchestration root itself when absent. Export a `TARGET_REPO_ROOT` constant from `lib/paths.ts` alongside the existing constants; `STATE_DIR`, `BACKLOG_DOCS_DIR`, `PLANS_DIR`, and `WORKTREES_DIR` key off the orchestration root. All existing `ORC_*` env overrides keep top precedence. Unit tests cover the precedence chain, walk-up discovery from nested directories, relative `target_repo` resolution, and the single-repo default.

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
