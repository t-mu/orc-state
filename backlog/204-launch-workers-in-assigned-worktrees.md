---
ref: vnext-control-plane/204-launch-workers-in-assigned-worktrees
feature: vnext-control-plane
review_level: full
priority: high
status: todo
depends_on:
  - vnext-control-plane/196-pin-markdown-task-revisions
---

# Task 204 — Launch workers in assigned worktrees

Depends on Task 196.

## Scope

**In scope:** Set actual provider process cwd to assigned worktree and align sandbox/Git paths in attached and sibling layouts.

**Out of scope:** Git workflow redesign or per-run clones.

---

## Context

### Current state

`lib/workerRuntime.ts` passes `working_directory`, but `adapters/pty.ts` prefers `ORC_REPO_ROOT`; workers must follow a later `cd` instruction.

### Desired state

The provider starts in its worktree, and CLI state lookup still resolves the orchestration root.

### Start here

- `adapters/pty.ts` — `pty.spawn` cwd and sandbox roots.
- `lib/workerRuntime.ts` — environment assembly.

**Affected files:** PTY adapter, sandbox path helpers, worker launch tests and docs.

---

## Goals

1. Must start worker process in assigned worktree for every provider.
2. Must preserve state lookup through `ORC_HOME` and Git metadata writes in sibling mode.
3. Must fail clearly if assigned worktree is missing or invalid.

## Implementation

1. Change launch cwd and compute explicit sandbox roots from actual worktree and state locations.
2. Update bootstraps to describe existing cwd rather than require navigation.
3. Test attached/sibling layouts, sandbox modes, and missing worktree.

## Acceptance criteria

- [ ] Child process reports assigned worktree as cwd before any instruction.
- [ ] Worker commit/rebase and `orc` CLI calls still work in both layouts.
- [ ] No broader filesystem grant than required by current policy.

## Tests

Add PTY integration tests for cwd, CLI state resolution and sibling Git write paths.

## Verification

`npm test`; opt-in real-provider smoke for each provider.

## Risk / Rollback

**Risk:** Provider sandbox may reject shared Git metadata paths. **Rollback:** Restore prior launch mode behind a temporary flag while fixing scoped roots; document the regression.
