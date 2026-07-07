---
ref: sibling-orchestration-repo/193-codex-sibling-sandbox-writable-root
feature: sibling-orchestration-repo
review_level: full
priority: normal
status: todo
depends_on:
  - sibling-orchestration-repo/190-sandbox-execution-mode-scoping-for-sibling-layout
---

# Task 193 — Codex sibling-layout sandbox: grant the target repo .git

Depends on Task 190.

## Scope

Task 190 fixed Claude sandbox scoping for the sibling layout: in
`adapters/pty.ts`, `claudeSandboxFilesystem` adds `<target-repo>/.git` to the
Claude settings `allowWrite` list so a sandboxed worker's commits (which write
to the worktree's shared object store in the target repo, outside the
orchestration subtree) succeed.

The equivalent Codex grant was deferred because the Codex CLI's
additional-writable-root mechanism could not be verified at the time. Codex
sandbox mode currently passes only `--sandbox workspace-write`, which scopes
writes to the launch cwd (the orchestration root). In the sibling layout a
Codex worker running under `execution_mode: sandbox` would be unable to commit
inside its worktree because `<target-repo>/.git` is outside that scope.

This task must:

- Determine the correct Codex mechanism for adding a writable root (likely a
  `-c sandbox_workspace_write.writable_roots=[...]` config override, or the
  current documented equivalent) — verify against the installed Codex CLI, do
  not guess.
- In `adapters/pty.ts` `buildStartArgs` (codex branch), when
  `execution_mode` is `sandbox`, `IS_SIBLING_LAYOUT` is true, and the worker is
  not read-only, grant `<TARGET_REPO_ROOT>/.git` as an additional writable
  root, mirroring the Claude behavior. Attached-mode and read-only (scout)
  flag sets stay unchanged.
- Remove the deferral comment in the codex branch that points at this task.
- Update `docs/configuration.md` → Execution Modes with the Codex sibling-layout
  writable-root behavior.

## Acceptance criteria

- [ ] Codex sandbox flag set includes the target repo `.git` writable root in
      the sibling layout, and is unchanged in the attached layout and for
      read-only scouts.
- [ ] Unit tests assert the Codex flag set in attached vs sibling layouts.
- [ ] No changes to files outside the stated scope.

## Verification

```bash
nvm use 24 && npm test
```
