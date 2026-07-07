---
ref: sibling-orchestration-repo/191-orc-init-sibling-scaffolding-and-health-checks
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: done
depends_on:
  - sibling-orchestration-repo/184-two-root-path-resolution-and-config-schema
---

# Task 191 — orc init --sibling scaffolding and health checks

Depends on Task 184.

## Scope

Add `orc init --sibling <target-repo-path>` to `cli/init.ts`: scaffold the orchestration repo in the current directory — `git init` if not already a repo, write a `.gitignore` containing `.orc-state/` and `.worktrees/`, write `orc-state.config.json` with `target_repo` set, create `backlog/` and `plans/`, and route the existing skill/agent/MCP install steps (`cli/install.ts`, `cli/install-skills.ts`, `cli/install-agents.ts`) into the orchestration repo instead of the target repo. Extend `cli/doctor.ts` and `cli/preflight.ts` to validate the sibling layout: `target_repo` resolves to an existing git repository, the state dir is writable, and a warning is emitted if orc framework artifacts are detected inside the target repo's working tree. Tests cover scaffolding output and each doctor check.

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
