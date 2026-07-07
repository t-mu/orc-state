---
ref: sibling-orchestration-repo/190-sandbox-execution-mode-scoping-for-sibling-layout
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: done
depends_on:
  - sibling-orchestration-repo/186-worktree-and-merge-operations-against-the-target-repo
---

# Task 190 — Sandbox execution-mode scoping for sibling layout

Depends on Task 186.

## Scope

In `lib/providers.ts`, when `execution_mode` is `sandbox` and sibling mode is active, assemble per-provider flags so the worker's writable workspace is the orchestration-root subtree, which covers its assigned worktree, the state dir, and the backlog in a single grant (for the claude provider this is the workspace/add-dir mechanism; apply each provider's equivalent). Direct-mode merges remain coordinator-side and need no worker grant on the target repo main checkout; PR mode pushes from inside the worktree subtree. Unit tests assert the assembled flag sets per provider in both attached and sibling layouts.

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
