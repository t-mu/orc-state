---
ref: sibling-orchestration-repo/192-documentation-and-end-to-end-lifecycle-coverage
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: done
depends_on:
  - sibling-orchestration-repo/186-worktree-and-merge-operations-against-the-target-repo
  - sibling-orchestration-repo/187-sibling-mode-phase-4-coordinator-side-spec-status-writeback
  - sibling-orchestration-repo/188-mode-aware-worker-prompts-and-gitignore-behavior
  - sibling-orchestration-repo/189-orc-home-propagation-and-in-worktree-discovery-for-worker-orc-commands
  - sibling-orchestration-repo/190-sandbox-execution-mode-scoping-for-sibling-layout
---

# Task 192 — Documentation and end-to-end lifecycle coverage

Depends on Tasks 186, 187, 188, 189, and 190.

## Scope

Write `docs/sibling-mode.md` covering the layout diagram, setup via `orc init --sibling`, the operating contract (specs are shared, execution is per-machine, one active coordinator per orchestration clone, manual sync of a shared orchestration repo), and troubleshooting. Update `docs/configuration.md` (new `target_repo` key and `ORC_HOME`), `docs/architecture.md` and `docs/concepts.md` (two-root model), and `README.md`. Add an e2e test under `e2e/` exercising the full lifecycle in a two-repo temp layout: scaffold via init --sibling, author a task spec, simulate the worker run lifecycle through merge, then assert the target repo's main contains only product code and the orchestration repo contains the status writeback commit.

Depends on: 3, 4, 5, 6, 7

---

## Acceptance criteria

- [ ] Implementation matches the plan step.
- [ ] No changes to files outside the stated scope.

---

## Verification

```bash
nvm use 24 && npm test
```
