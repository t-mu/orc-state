---
ref: orch/task-148-launch-provider-sessions-inside-assigned-worktrees
epic: orch
status: todo
---

# Task 148 — Launch Provider Sessions Inside Assigned Worktrees

Independent.

## Scope

**In scope:**
- `adapters/pty.mjs` — launch provider CLIs in an assigned worktree path instead of always using `process.cwd()`
- `adapters/index.mjs` and any adapter contract helpers — carry provider-agnostic session launch options such as working directory
- `coordinator.mjs` or a new coordinator-owned runtime helper — create and persist per-run worktree metadata before launching the provider session
- worktree mapping metadata stored in orchestrator state/runtime files needed to resume the same run deterministically

**Out of scope:**
- Agent merge/finalization protocol
- Retry/block behavior for failed finalize rebases
- Provider-specific worktree flags such as `claude --worktree`
- Final merge and cleanup logic after the run is complete

---

## Context

The current PTY adapter launches every provider from `process.cwd()`, and workers are expected to create or enter their own git worktree after startup. That makes worktree isolation dependent on agent reasoning rather than on trusted orchestration code.

The framework is provider-agnostic, so the fix cannot be “Codex gets special worktree logic.” The coordinator should allocate the worktree and pass a generic working-directory launch option into the adapter layer. Each provider then starts inside that assigned directory, regardless of whether it has provider-specific worktree flags.

### Current state

`createPtyAdapter()` spawns provider CLIs with `cwd: process.cwd()`. Worker instructions then tell the agent to create a worktree itself and `cd` into it before doing any work.

There is no durable coordinator-owned mapping from a run to its assigned worktree path and task branch.

### Desired state

The coordinator should allocate a worktree for the run before launching the provider session, persist that mapping, and pass the target working directory into the provider-agnostic adapter launch contract.

The provider session should begin life already inside the correct worktree, so the agent does not need to discover or create its own isolated checkout.

### Start here

- `adapters/pty.mjs` — current provider PTY launch path and hardcoded `cwd`
- `adapters/index.mjs` — current adapter contract surface
- `coordinator.mjs` — current worker startup and dispatch path

<!-- Optional:
### Dependency context

This is the foundation for the finalization refactor. Later tasks will keep the agent alive in its assigned worktree for rebases and merge retries, so the coordinator must own worktree allocation up front.
-->

**Affected files:**
- `adapters/pty.mjs` — provider launch working directory
- `adapters/index.mjs` — provider-agnostic launch options
- `coordinator.mjs` — assign worktree path and branch for a run
- new coordinator/runtime helper under `lib/` — create/reuse worktrees deterministically

---

## Goals

1. Must let the coordinator launch any provider session inside an assigned worktree path.
2. Must keep the launch contract provider-agnostic at the coordinator/adapter boundary.
3. Must persist enough run metadata to find the same worktree and branch again during later finalization.
4. Must stop relying on the agent to create its own worktree before coding starts.
5. Must preserve compatibility with existing provider binaries even if they have no special worktree flags.

---

## Implementation

### Step 1 — Extend the adapter launch contract with working-directory support

**Files:**
- `adapters/index.mjs`
- `adapters/pty.mjs`

Add a provider-agnostic launch option such as `working_directory` or equivalent. The PTY adapter should use that path as the process `cwd` when spawning the provider CLI.

Do not add provider-specific logic at the coordinator call site. Any provider quirks should remain inside adapter code.

### Step 2 — Add coordinator-owned worktree allocation

**Files:**
- `coordinator.mjs`
- new runtime helper under `lib/`

Create a helper that allocates or reuses the worktree for a run, derives the task branch name, and returns the path the provider should start in. The helper must be deterministic when the same run is resumed later.

### Step 3 — Persist run-to-worktree mapping

**Files:**
- coordinator runtime/state helper(s)
- any touched state/runtime metadata file

Store the worktree path and branch name in run-associated metadata so later finalization tasks can reopen the same worktree instead of guessing.

---

## Acceptance criteria

- [ ] The coordinator can launch provider sessions inside an assigned worktree path.
- [ ] The launch contract is provider-agnostic at the coordinator/adapter boundary.
- [ ] Each run has durable metadata linking it to its worktree path and branch.
- [ ] Agents no longer need to create their own worktree before beginning task work.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add or update:

- `adapters/pty.test.mjs` — assert the adapter launches in the requested working directory
- `orchestrator/coordinator.test.mjs` — assert the coordinator allocates/persists worktree metadata for a run
- integration coverage near the touched runtime helper — assert the same run reuses the same worktree metadata

---

## Verification

```bash
# Targeted verification for this task only
npx vitest run -c orchestrator/vitest.config.mjs adapters/pty.test.mjs orchestrator/coordinator.test.mjs
```

```bash
# Final required repo-wide checks before marking the task done
nvm use 24 && npm run build
nvm use 24 && npm test
```

```bash
# Smoke checks — include only when schema, state, or CLI changes are in scope
node cli/orc.mjs doctor
node cli/orc.mjs status
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** A half-complete launch-path change can strand provider sessions in the wrong directory or make resumed runs point at inconsistent worktrees.
**Rollback:** Revert the adapter/worktree-allocation changes together and rerun the targeted adapter/coordinator tests.
