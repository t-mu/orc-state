---
ref: sibling-orchestration-repo/188-mode-aware-worker-prompts-and-gitignore-behavior
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: todo
depends_on:
  - sibling-orchestration-repo/187-sibling-mode-phase-4-coordinator-side-spec-status-writeback
---

# Task 188 — Mode-aware worker prompts and gitignore behavior

Depends on Task 187.

## Scope

Teach `lib/prompts.ts` to emit sibling-mode worker instructions: Phase 4 omits the edit-spec-in-worktree step and instead instructs the worker that the coordinator records completion, and adds an explicit prohibition on committing any framework files into the target repo. Attached-mode prompt text is unchanged. Update the AGENTS.md phased-workflow section with a sibling-mode callout describing the changed Phase 4 contract. Change `lib/gitignore.ts` usage so `ensureGitignore` never touches the target repo in sibling mode; scaffolding (step 8) owns ignoring `.orc-state/` and `.worktrees/` in the orchestration repo. Prompt snapshot tests cover both modes.

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
