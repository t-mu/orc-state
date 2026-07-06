---
ref: sibling-orchestration-repo/185-call-site-audit-orchestration-root-vs-target-repo-consumers
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: done
depends_on:
  - sibling-orchestration-repo/184-two-root-path-resolution-and-config-schema
---

# Task 185 — Call-site audit: orchestration-root vs target-repo consumers

Depends on Task 184.

## Scope

Enumerate every call site of `resolveRepoRoot()` and every path derived from repo root across `lib/`, `cli/`, `coordinator.ts`, and `mcp/`. Classify each as an orchestration-root consumer (state files, backlog specs, plans, config, locks, hook-event files) or a target-repo consumer (any git command that reads or mutates product history or working trees). Refactor target-repo consumers to use `TARGET_REPO_ROOT`. This step is mechanical and behavior-preserving: in single-repo mode both roots are identical, and the full existing test suite must pass without modification. Record the classification table in the step's commit message or a short doc comment so later steps can rely on it.

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
