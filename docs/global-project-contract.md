# Global project and task ownership contract

This is the target contract for [plan 3](../plans/3-global-project-state.md). Task definitions, revisions, Markdown import/export and transactional lifecycle state are implemented for project state directories (see `docs/configuration.md` → Project tasks). A legacy attached installation continues to operate, with status owned by its runtime and spec definitions only registered from Markdown, until `orc project migrate` cuts it over (see `docs/configuration.md` → Migrating an existing installation). The sibling layout is retired and must be migrated before it runs. This document defines the behavior those tasks must preserve and prove.

## Project identity and storage

A project has a generated, opaque, stable `project_id`, a display name, and one canonical target Git root. Moving the repository changes its registered path, not its identity or task history. Task refs are unique within a project; equal refs in different projects do not share status or runs. Registration rejects two active project records for the same canonical Git root.

`ORC_DATA_HOME` overrides the harness data home. Its default is the platform's per-user application data directory: `~/Library/Application Support/orc-state` on macOS and `${XDG_DATA_HOME:-~/.local/share}/orc-state` on Linux. The data home contains `registry.db` for project identities and non-secret configuration. Each project has `projects/<project_id>/runtime.db`, plus external worktree, log, provider-settings, and export directories as needed. No harness file or `.gitignore` entry is required in the target working tree. Git's own worktree metadata still lives under the target repository's `.git` directory.

Provider credentials remain with the provider's login store or a dedicated secret store. The registry may record a provider choice or model but must not contain access tokens. One coordinator owns a project's write transactions at a time; workers and clients use an authorized project-scoped command API. In a project, every worker lifecycle command (`orc run-start`, `progress`, `run-work-complete`, `run-fail`, `run-finish`, `run-input-request`, `review-submit`, `memory-record`, `report-for-duty`) is sent to the coordinator's control socket with the worker's session credential, and the coordinator applies it in its own process, refusing a credential that does not own the named run. Master and operator mutations (MCP `cancel_task`, `reset_task`, `delegate_task`, `respond_input`; `orc task-reset`, `task-unblock`, `delegate`, `run-input-respond`) go through the same API: the coordinator applies them, authorized by the master's session secret or as an operator holding the operator token. Only with no coordinator running do these recovery commands write the project state themselves, and they say so. Other writers outside the coordinator remain: task authoring (`orc project task …`, MCP `create_task`/`update_task`, which write the task store in their own transaction), worker registration and removal (`register-worker`, `worker-remove`, `kill-all`), and the master's scout launch (`request_scout`). Every session authenticates with a per-session secret held only in its own environment; the state keeps its hash, so a session id read from the state directory authenticates nobody. **Remaining limit:** the secrets are as private as the provider sandbox makes them — an unsandboxed process of the same user, or one in a sandbox without its own process namespace (Codex's), can read other processes' environments, and a Codex sandbox cannot hide the operator token. A sandboxed project worker is therefore not granted the state directory, only its worktree, the target's `.git` write subtrees and the control socket.

## Project selection

The selection order is `--project` identifier, `ORC_PROJECT_ID`, a unique registered match for the current canonical Git root, then a selected project when the command is outside every Git repository. A command inside an unregistered Git repository fails rather than silently using the selected project. An unknown, empty, or ambiguous higher-priority selection fails rather than falling through to another project. `orc project select` records the optional outside-repo selection in the global registry; it does not write to the target repository. Worktree callers receive the project identity explicitly from the coordinator. The resolver's caller canonicalizes Git roots, including worktrees and symlinks, before matching.

## Separate task concepts

| Concept | Authority | Meaning |
|---|---|---|
| Task definition | Project SQLite | Stable ref and editable title, dependencies, provider requirements, priority, and full Markdown body. No file path is required. |
| Spec revision | Project SQLite | Immutable body and parsed metadata with a revision id and content hash. A run pins one revision when claimed. |
| Task status | Project SQLite | Current lifecycle state, attempt count, block reason, and timestamps. Only lifecycle commands change it. |
| Run | Project SQLite | One attempt, worker binding, pinned revision, phase, finalization, and terminal outcome. A task may have several runs. |
| Dispatch readiness | Derived at read or claim time | Combines task status, dependency states, retry delay, planning state, agent compatibility, and capacity. It is not another persisted status. |
| Event | Project SQLite | Auditable transition record (`task_transitions`) appended in the same transaction as the task and run-binding change. The `events.db` notification stream and `claims.json` are written in a separate step; startup reconciliation repairs a crash between the two. |

Markdown import and export carry task instructions and metadata. They do not carry an authoritative lifecycle `status`. Ordinary imports cannot complete, block, or reopen a task. An imported file may be edited later, but no implicit two-way sync is performed; a new explicit import creates a new revision. A run continues with its pinned revision.

## Lifecycle and dispatch invariants

| Transition | Cause and owner |
|---|---|
| `todo → claimed` | Coordinator atomically verifies readiness and creates a run. |
| `claimed → in_progress` | Worker reports `run-start` through the framework. |
| `in_progress → done` | Coordinator confirms a successful merge, once. A worker's `run-work-complete` changes run finalization state only. |
| `done → released` | Coordinator performs the existing post-merge release step. Both states satisfy dependencies. |
| `claimed/in_progress → todo` | A failed run is requeued under policy, with retry metadata. |
| `claimed/in_progress → blocked` | A failed run uses explicit block policy and records a reason. |
| `todo → blocked` and `blocked → todo` | An operator explicitly blocks or unblocks a task. |
| `non-todo → todo` | An operator explicitly resets a task, including a completed one. Stale import or migration replay cannot do this. |
| `todo/claimed/in_progress/blocked → cancelled` | An authorized cancellation ends pending work. |
| `todo → blocked/done/released/cancelled` | Installation migration carries a task's legacy runtime status, only as the task's first transition (`migration_import`). |

`blocked` means an explicit decision or execution failure. A `todo` task with an unfinished or missing dependency remains `todo` and is reported as waiting for that dependency. Dependencies are satisfied only by `done` or `released` tasks in the same project. Scheduler policy may additionally filter by retry delay, planning state, provider, owner, and capacity. Completion and failure retries are idempotent and cannot append a second terminal event or silently change a completed task's status.

## Mapping existing layouts

| Current behavior | Target behavior |
|---|---|
| Attached mode uses the product repo for config, `backlog/`, plans, state, and worktrees. | Registration points to that Git repo; harness artifacts move to its external project data directory. Product files remain in the repo. |
| Sibling mode uses a separate orchestration repo and `target_repo` config. | Registration points directly to the target Git repo; the sibling repo may be imported and archived but is not required to run the project. |
| Markdown frontmatter plus `backlog.json` both contain status. | Migration takes the current runtime status as authority, preserves history, and then removes status ownership from Markdown. |
| `events.db` already contains runs and events; JSON files hold other operational fields. | Project SQLite transactionally owns task status, runs, and events. Compatibility projections are read-only until callers have moved. |
| Workers use `ORC_HOME` to find state from a target worktree. | The coordinator passes project identity and an authenticated local endpoint; a legacy external state path may be passed during migration. |

Migration must offer a dry-run inventory and backup, be repeatable, and verify task refs, status, revisions, runs, events, and plans before cutover. It must not delete old files automatically. CLI and TUI must complete a task in a clean target repository before sibling-specific paths are retired.

`e2e/clean-repo-project.e2e.test.ts` (`npm run test:e2e`) proves this. A disposable repository with no orc files is registered. A database-only task and an imported Markdown task run on concurrent workers through the real coordinator (`main()`/`doShutdown()`) over the real tmux transport, and only the provider is a stand-in. The CLI and TUI inspect and attach. The coordinator shuts down mid-run, leaving its sessions running; a new coordinator instance (with its own owner identity) adopts the live session and merges the finished one; both runs complete through the merge. The test then checks that only the two product commits reached the target and its working tree is clean, that status and config survive into new CLI sessions, that `orc doctor` exits 0, and that a re-imported stale export (even one carrying `status: todo`) leaves the completed tasks done and dispatches nothing. The focused migration tests are `lib/projectMigration.test.ts` (dry run, cutover, retries, sibling layouts, status direction, cleanup report), `lib/backlogSync.test.ts` (definitions-only sync and the migration-only status mirror) and the `migration_import` cases in `lib/projectTaskStore.test.ts`; they run in `npm test`.
