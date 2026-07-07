---
ref: sibling-orchestration-repo/189-orc-home-propagation-and-in-worktree-discovery-for-worker-orc-commands
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: done
depends_on:
  - sibling-orchestration-repo/184-two-root-path-resolution-and-config-schema
---

# Task 189 — ORC_HOME propagation and in-worktree discovery for worker orc commands

Depends on Task 184.

## Scope

Pass `ORC_HOME` (the orchestration root) into worker PTY environments via `lib/providerChildEnv.ts` so every `orc` invocation from a worker shell resolves the correct state dir even though its cwd is a target-repo worktree (from which git-based discovery would wrongly resolve to the target repo). The walk-up discovery from step 1 serves as the fallback because worktrees physically live under the orchestration root. Integration test: in a two-repo temp layout, run `orc status` (or an equivalent state-reading command) from inside a worktree and assert it reads the orchestration repo's state dir both with and without `ORC_HOME` set.

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
