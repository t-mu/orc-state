---
plan_id: 3
name: global-project-state
title: Global project state and sibling-mode retirement
created_at: 2026-10-24T19:49:28Z
updated_at: 2026-10-24T19:49:28Z
derived_task_refs:
  - global-project-state/218-freeze-the-project-and-task-ownership-contracts
  - global-project-state/219-add-a-global-project-registry-and-configuration-store
  - global-project-state/220-put-task-definitions-and-lifecycle-state-in-project-sqlite
  - global-project-state/221-make-task-creation-and-revision-apis-storage-neutral
  - global-project-state/222-make-markdown-an-explicit-portable-interface
  - global-project-state/223-move-dispatch-and-completion-into-sqlite-transactions
  - global-project-state/224-run-workers-against-a-registered-target-without-repo-local-framework-files
  - global-project-state/225-expose-project-aware-operations-in-cli-and-tui
  - global-project-state/226-migrate-attached-and-sibling-installations-safely
  - global-project-state/227-retire-sibling-specific-behavior-and-the-status-mirror
  - global-project-state/228-prove-the-clean-repo-cli-and-tui-workflow
---

# Global project state and sibling-mode retirement

## Objective

Run orc against registered Git repositories without creating configuration, task specs, plans, runtime state, or ignored files in their working trees. Make SQLite the durable authority for project settings, task specifications, task status, claims, and lifecycle events while retaining optional readable Markdown import and export.

## Scope

- Register multiple target repositories in a global harness data directory and select one by explicit project identifier or by the current directory's canonical Git root.
- Persist non-secret global defaults and per-project settings outside target repositories, with CLI and environment overrides defined explicitly.
- Store complete task specifications and immutable spec revisions in project SQLite databases; support database-only tasks with no Markdown source file.
- Move task lifecycle state into SQLite and update task, run, and event records transactionally through one framework API.
- Support explicit Markdown import and export from arbitrary external paths without requiring files in the target repository or treating frontmatter status as authoritative.
- Migrate existing attached and sibling installations without discarding task history, runs, plans, settings, or current statuses.
- Retire sibling-mode scaffolding, status writeback, file-based backlog synchronization, and layout-specific branches after the new project model passes CLI and TUI end-to-end checks.

## Out of Scope

- Cross-machine simultaneous coordination or replication of a local SQLite project database.
- Implementation of Isolagent, the desktop client, or remote provider authentication.
- Removing Git worktree metadata from the target repository's `.git` directory; Git needs that metadata even when worktree directories are external.
- Automatic bidirectional synchronization with independently edited Markdown files.

## Constraints

- A target repository must receive only intended product-code changes. Orc must not write `.orc-state`, `backlog`, `plans`, config, provider settings, or `.gitignore` entries into its working tree.
- Preserve stable task refs and existing run and event history. A completed task must never become dispatchable because of a stale Markdown export or migration replay.
- One coordinator owns a project's write transactions at a time. CLI, TUI, control API, and isolated workers must use that project's identity and authorized API rather than edit SQLite directly.
- A worker receives a snapshot of one immutable task-spec revision when claimed. Later edits affect only future runs.
- Store provider credentials in provider-owned login stores or an appropriate secret store, not in task or configuration tables.
- Keep local CLI and TUI usable without a desktop client. Existing installations remain operable until migration is verified, and migration is repeatable with a dry-run and backup.

## Affected Areas

- Project discovery, path resolution, configuration loading, `orc init`, and provider launch settings in `lib/repoRoot.ts`, `lib/paths.ts`, `lib/providers.ts`, `cli/`, and adapters.
- SQLite schema, task and run stores, event transactions, task scheduling, coordinator dispatch and finalization, and MCP/control API handlers.
- Plan and task authoring, Markdown parsing, spec revision snapshots, `backlog/` synchronization, and `backlog.json` compatibility code.
- Git worktree placement, worker bootstrap, sandbox writable roots, preflight, doctor, and TUI project selection.
- Sibling-mode checks, status writeback, tests, templates, `AGENTS.md`, and operator documentation.

## Implementation Steps

### Step 1 — Freeze the project and task ownership contracts

Document a stable project identifier, the global data-home layout, project selection precedence, and the task lifecycle state machine. Separate task definition, immutable spec revision, lifecycle status, run state, and derived dispatch readiness. Specify that `done` is committed only after merge, that explicit `blocked` differs from dependency waiting, and that no Markdown status field controls dispatch. Map current attached and sibling behavior to each new contract and add contract tests before replacing storage.

### Step 2 — Add a global project registry and configuration store

Create a global `registry.db` in a platform-appropriate application data directory, overridable by `ORC_DATA_HOME`. Register a stable project id, canonical target Git root, external project state directory, and validated non-secret settings. Add `orc project add`, `list`, `select`, `show`, and `config` operations. Resolve an explicit project flag first, an environment project id second, and a unique registered Git-root match from cwd last; reject ambiguous matches. Define effective configuration precedence as CLI flags, environment, per-project settings, then global defaults. Do not require `orc-state.config.json` or an orchestration repository.

Depends on: 1

### Step 3 — Put task definitions and lifecycle state in project SQLite

Add versioned task, task-spec-revision, dependency, and task-transition tables to each project's runtime database. Store the complete Markdown body as text alongside indexed metadata so a database-only task is executable and exportable. Keep task status, attempts, block reason, and timestamps in transactional rows. Use SQLite constraints and migration tests to preserve stable refs and prevent invalid transitions or duplicate active claims. Keep an optional read-only `backlog.json` projection only for callers that cannot migrate in the same step.

Depends on: 1, 2

### Step 4 — Make task creation and revision APIs storage-neutral

Route CLI, MCP, and control API task creation and edits through the project task store. Save each accepted spec edit as an immutable revision with a content hash and parsed metadata. On claim, bind the run to the selected revision and deliver that exact body to the worker. Add compare-and-swap revision checks so concurrent edits cannot silently overwrite each other. A task created through the API must require no Markdown file or repo-local artifact.

Depends on: 3

### Step 5 — Make Markdown an explicit portable interface

Provide task import from a specified file or directory outside or inside a repo, and task export to a caller-chosen path. Render readable Markdown from SQLite task content and metadata. Import an old `status` field only during the migration in Step 9; ordinary imports ignore or reject lifecycle fields and never reset runtime status. Record optional source path and revision information for diagnostics, but do not auto-watch files or perform two-way status sync. Keep plans available as readable Markdown export while allowing their metadata and content to live in project state.

Depends on: 4

### Step 6 — Move dispatch and completion into SQLite transactions

Change scheduler, claims, run commands, coordinator finalization, and status queries to use project-scoped task rows. Claim creation must atomically verify status and dependencies, claim the task, create the run, and append its event. Failure and reset must atomically update run and task status with the corresponding event. Work-complete leaves the task in progress; successful merge records `done` once. Keep terminal retries idempotent. Remove any requirement for a worker or coordinator to edit `status:` in a task file.

Depends on: 3, 4

### Step 7 — Run workers against a registered target without repo-local framework files

Resolve target Git operations from the selected project's registry entry and place run worktrees, provider settings, logs, plans, and state under the external project data directory. Propagate project identity and an authenticated local control endpoint to worker sessions; use the external state path only as a temporary compatibility bridge. Update sandbox grants for the assigned worktree, required target `.git` write subtrees, and the control transport. Verify Codex, Claude, CLI runtime, and structured runtime launches without `ORC_HOME` discovery or a config file in the target repo.

Depends on: 2, 6

### Step 8 — Expose project-aware operations in CLI and TUI

Make status, watch, task editing, run inspection, terminal attach, doctor, preflight, and configuration commands accept the selected project and show its identity. Ensure a user can switch projects without changing repository files or restarting a provider login. Keep the control API's task and run responses consistent with the SQLite store so future desktop and Isolagent clients use the same contract.

Depends on: 4, 6, 7

### Step 9 — Migrate attached and sibling installations safely

Add a dry-run migration command that detects the old layout, inventories specs, config, `backlog.json`, plans, runs, events, and worktrees, and reports conflicting refs or statuses. On execution, back up original state, import definitions and revisions, preserve runtime task status over stale frontmatter, preserve history, and register the target repository. Make retries idempotent and verify parity before switching the project to SQLite authority. Do not delete old directories automatically; provide a separate cleanup report after verification.

Depends on: 5, 6, 7, 8

### Step 10 — Retire sibling-specific behavior and the status mirror

Remove `orc init --sibling` scaffolding, config-file walk-up as the primary selector, sibling-only spec writeback, attached-versus-sibling worker instructions, and runtime backlog sync from Markdown. Replace sibling layout checks with project health checks for target Git access, external data-home writability, worktree placement, and accidental target-repo artifacts. Keep the reusable two-root Git and sandbox plumbing under project-oriented names. Update docs, templates, and old task-flow instructions to point at the project registry and SQLite status API.

Depends on: 9

### Step 11 — Prove the clean-repo CLI and TUI workflow

Use a disposable target Git repo with no orc files to register a project, create a database-only task, import and export a Markdown task outside the repo, dispatch concurrent workers, inspect and attach through the CLI/TUI, recover a coordinator restart, and finish through merge. Assert that only intended product commits appear in the target working tree, task status and config survive new sessions, `orc doctor` passes, and a stale Markdown export cannot requeue a completed task. Run the existing unit and E2E suites plus focused migration tests before declaring the old sibling path retired.

Depends on: 8, 9, 10
