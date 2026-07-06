---
plan_id: 1
name: sibling-orchestration-repo
title: Sibling Orchestration Repo — Two-Root Model
created_at: 2026-07-06T11:12:41.760Z
updated_at: 2026-07-06T11:12:41.760Z
derived_task_refs: []
---
# Sibling Orchestration Repo — Two-Root Model

## Objective

Enable orc to orchestrate work on a target repository that must remain completely free of framework files (no .gitignore edits, no committed or untracked orc artifacts) by introducing a two-root model: an orchestration repo — a sibling git repository owned by the operator — holds the config, backlog specs, plan artifacts, runtime state, and worktrees, while the target repo receives only product-code commits. The existing single-repo layout remains the default and behaves byte-identically when no target repo is configured.

## Scope

- A `target_repo` config key in `orc-state.config.json` plus two-root path resolution: orchestration root (config, `.orc-state/`, `backlog/`, `plans/`, `.worktrees/`) resolved separately from the target repo root (all git operations on product code).
- Orchestration-root discovery that works from any cwd: `ORC_HOME` env override first, then directory walk-up locating `orc-state.config.json`, then the current `resolveRepoRoot()` behavior as fallback.
- A full audit of `resolveRepoRoot()` call sites, reclassifying each as an orchestration-root consumer (state, specs, plans, locks) or a target-repo consumer (worktree add/remove, merge, rebase, branch, push, PR operations).
- Worktrees of the target repo created under the orchestration root's `.worktrees/`; coordinator merge and PR-mode git operations run against the target repo.
- Sibling-mode task completion: workers no longer edit or commit spec markdown; after merge the coordinator writes `status: done` into the spec file in the orchestration repo and auto-commits it there.
- Mode-aware worker bootstrap prompts reflecting the changed Phase 4 contract.
- `ORC_HOME` propagation into worker PTY environments so `orc` commands invoked from inside target-repo worktrees resolve the correct state dir.
- Sandbox execution-mode scoping: grant the orchestration-root subtree as the worker workspace, assembled per provider.
- `orc init --sibling <target-repo-path>` scaffolding for the orchestration repo, plus doctor and preflight validation of the sibling layout.
- Documentation (new sibling-mode guide plus updates to configuration, architecture, concepts) and an end-to-end test covering the full lifecycle in a two-repo layout.

## Out of Scope

- A detached state home under `XDG_STATE_HOME` or a home-directory scheme (the earlier "option 2"); the resolution mechanism should not preclude adding it later as another preset, but it is not implemented here.
- A `.git/info/exclude`-based attached mode for the target repo.
- Multi-coordinator or cross-machine distributed task claiming; the contract remains one active coordinator per orchestration clone, documented rather than enforced by machinery.
- Automatic `git pull` of the orchestration repo on coordinator tick; syncing a shared orchestration repo stays manual.
- Sharing, exporting, or versioning `memory.db`, `events.db`, or any other runtime state.
- Changes to the PR reviewer workflow beyond making its git operations target-repo-aware.

## Constraints

- Backward compatibility is absolute: with no `target_repo` configured, orchestration root and target repo root are the same directory and every existing behavior and test passes unchanged.
- The target repo must never receive framework files in sibling mode: no `.gitignore` modifications (`ensureGitignore` must not run against it), no untracked orc artifacts in its working tree, and no spec/plan files carried in merges — merges contain product code only.
- Runtime state (`.orc-state/`) is never versioned, including inside the orchestration repo; scaffolding must gitignore it and `.worktrees/` there.
- All state mutation continues to flow through CLI commands and MCP tools backed by the existing lock/atomic-write layer; no new direct-write paths.
- Node 24 native type stripping, no build step, Vitest for tests, exact pinned dependency versions, and no new npm dependencies without prior approval.
- Existing `ORC_STATE_DIR`, `ORC_BACKLOG_DIR`, `ORC_PLANS_DIR`, `ORC_WORKTREES_DIR`, `ORC_CONFIG_FILE`, and `ORC_REPO_ROOT` env overrides keep their current precedence over any new resolution logic.
- The coordinator's spec status writeback commit in the orchestration repo must degrade gracefully when the orchestration root is not a git repository (write the file, skip the commit).

## Affected Areas

- `lib/paths.ts`, `lib/repoRoot.ts` — two-root resolution, `ORC_HOME`, walk-up discovery.
- `lib/runWorktree.ts`, `coordinator.ts`, `lib/runCommands.ts` — worktree/merge/rebase/PR git operations retargeted to the target repo.
- `lib/taskCompletion.ts`, `lib/backlogSync.ts`, `cli/task-mark-done.ts` — sibling-mode spec status writeback and auto-commit.
- `lib/prompts.ts` — mode-aware worker Phase 4 instructions.
- `lib/providerChildEnv.ts`, `lib/providers.ts` — `ORC_HOME` propagation and sandbox workspace scoping per provider.
- `lib/gitignore.ts` — suppressed for the target repo in sibling mode; applied to the orchestration repo instead.
- `cli/init.ts`, `cli/install.ts`, `cli/install-skills.ts`, `cli/install-agents.ts` — `--sibling` scaffolding and install destinations.
- `cli/doctor.ts`, `cli/preflight.ts` — sibling layout validation.
- `schemas/` — config schema extension for `target_repo`.
- `docs/` — new sibling-mode guide; updates to `configuration.md`, `architecture.md`, `concepts.md`, `README.md`, `AGENTS.md`.
- `e2e/` — two-repo lifecycle coverage.

## Implementation Steps

### Step 1 — Two-root path resolution and config schema

Add a `target_repo` key (relative-to-config or absolute path) to `orc-state.config.json`, its JSON schema under `schemas/`, and the config loader. Introduce `resolveOrchestrationRoot()` in `lib/repoRoot.ts` with precedence: `ORC_HOME` env var, then directory walk-up from cwd locating `orc-state.config.json`, then the existing `resolveRepoRoot()` git-based behavior as fallback. Introduce `resolveTargetRepoRoot()`: `target_repo` from config resolved against the orchestration root, defaulting to the orchestration root itself when absent. Export a `TARGET_REPO_ROOT` constant from `lib/paths.ts` alongside the existing constants; `STATE_DIR`, `BACKLOG_DOCS_DIR`, `PLANS_DIR`, and `WORKTREES_DIR` key off the orchestration root. All existing `ORC_*` env overrides keep top precedence. Unit tests cover the precedence chain, walk-up discovery from nested directories, relative `target_repo` resolution, and the single-repo default.

### Step 2 — Call-site audit: orchestration-root vs target-repo consumers

Enumerate every call site of `resolveRepoRoot()` and every path derived from repo root across `lib/`, `cli/`, `coordinator.ts`, and `mcp/`. Classify each as an orchestration-root consumer (state files, backlog specs, plans, config, locks, hook-event files) or a target-repo consumer (any git command that reads or mutates product history or working trees). Refactor target-repo consumers to use `TARGET_REPO_ROOT`. This step is mechanical and behavior-preserving: in single-repo mode both roots are identical, and the full existing test suite must pass without modification. Record the classification table in the step's commit message or a short doc comment so later steps can rely on it.

Depends on: 1

### Step 3 — Worktree and merge operations against the target repo

Update `lib/runWorktree.ts` so run worktrees are created as worktrees of the target repo but placed under the orchestration root's `WORKTREES_DIR`. Update the coordinator's direct-mode merge/cleanup sequence and the PR-mode operations (fetch, rebase, push, pr-status) in `coordinator.ts` and `lib/runCommands.ts` to execute git against the target repo root. Verify the AGENTS.md cleanup ordering (merge from main checkout, delete branch, remove worktree last) still holds when the main checkout is the target repo and the worktree lives under the orchestration root. Tests use two temporary git repos to assert worktree placement, merge target, and that no framework files appear in the target repo after a merge.

Depends on: 2

### Step 4 — Sibling-mode Phase 4: coordinator-side spec status writeback

In sibling mode, workers no longer edit or commit the task spec markdown; completion is signaled solely via `orc run-work-complete`. Extend the coordinator's post-merge completion path (`orc task-mark-done` / `lib/taskCompletion.ts`) so that in sibling mode it also writes `status: done` into the spec file under the orchestration repo's `backlog/` and creates an automatic commit in the orchestration repo with message `chore(backlog): <task-ref> done`. When the orchestration root is not a git repository, write the file and skip the commit without error. `markTaskDoneRuntimeOnly` remains runtime-only; the writeback is a distinct, tested layer on top. Guard `lib/backlogSync.ts` interactions so the writeback and the next sync tick do not fight (the existing active-status guard already protects claimed/in_progress tasks). Tests cover writeback content, commit creation, non-git graceful degradation, and sync convergence after writeback.

Depends on: 1

### Step 5 — Mode-aware worker prompts and gitignore behavior

Teach `lib/prompts.ts` to emit sibling-mode worker instructions: Phase 4 omits the edit-spec-in-worktree step and instead instructs the worker that the coordinator records completion, and adds an explicit prohibition on committing any framework files into the target repo. Attached-mode prompt text is unchanged. Update the AGENTS.md phased-workflow section with a sibling-mode callout describing the changed Phase 4 contract. Change `lib/gitignore.ts` usage so `ensureGitignore` never touches the target repo in sibling mode; scaffolding (step 8) owns ignoring `.orc-state/` and `.worktrees/` in the orchestration repo. Prompt snapshot tests cover both modes.

Depends on: 4

### Step 6 — ORC_HOME propagation and in-worktree discovery for worker orc commands

Pass `ORC_HOME` (the orchestration root) into worker PTY environments via `lib/providerChildEnv.ts` so every `orc` invocation from a worker shell resolves the correct state dir even though its cwd is a target-repo worktree (from which git-based discovery would wrongly resolve to the target repo). The walk-up discovery from step 1 serves as the fallback because worktrees physically live under the orchestration root. Integration test: in a two-repo temp layout, run `orc status` (or an equivalent state-reading command) from inside a worktree and assert it reads the orchestration repo's state dir both with and without `ORC_HOME` set.

Depends on: 1

### Step 7 — Sandbox execution-mode scoping for sibling layout

In `lib/providers.ts`, when `execution_mode` is `sandbox` and sibling mode is active, assemble per-provider flags so the worker's writable workspace is the orchestration-root subtree, which covers its assigned worktree, the state dir, and the backlog in a single grant (for the claude provider this is the workspace/add-dir mechanism; apply each provider's equivalent). Direct-mode merges remain coordinator-side and need no worker grant on the target repo main checkout; PR mode pushes from inside the worktree subtree. Unit tests assert the assembled flag sets per provider in both attached and sibling layouts.

Depends on: 3

### Step 8 — orc init --sibling scaffolding and health checks

Add `orc init --sibling <target-repo-path>` to `cli/init.ts`: scaffold the orchestration repo in the current directory — `git init` if not already a repo, write a `.gitignore` containing `.orc-state/` and `.worktrees/`, write `orc-state.config.json` with `target_repo` set, create `backlog/` and `plans/`, and route the existing skill/agent/MCP install steps (`cli/install.ts`, `cli/install-skills.ts`, `cli/install-agents.ts`) into the orchestration repo instead of the target repo. Extend `cli/doctor.ts` and `cli/preflight.ts` to validate the sibling layout: `target_repo` resolves to an existing git repository, the state dir is writable, and a warning is emitted if orc framework artifacts are detected inside the target repo's working tree. Tests cover scaffolding output and each doctor check.

Depends on: 1

### Step 9 — Documentation and end-to-end lifecycle coverage

Write `docs/sibling-mode.md` covering the layout diagram, setup via `orc init --sibling`, the operating contract (specs are shared, execution is per-machine, one active coordinator per orchestration clone, manual sync of a shared orchestration repo), and troubleshooting. Update `docs/configuration.md` (new `target_repo` key and `ORC_HOME`), `docs/architecture.md` and `docs/concepts.md` (two-root model), and `README.md`. Add an e2e test under `e2e/` exercising the full lifecycle in a two-repo temp layout: scaffold via init --sibling, author a task spec, simulate the worker run lifecycle through merge, then assert the target repo's main contains only product code and the orchestration repo contains the status writeback commit.

Depends on: 3, 4, 5, 6, 7
