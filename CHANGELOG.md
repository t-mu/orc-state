# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking

- The task status `released` and the `post_merge_release` transition are removed; nothing ever set them. `done` is the single terminal success status. `runtime.db` migrates to schema version 5, which rewrites any `released` task to `done`. `list_tasks` and `orc project task list --status` no longer accept `released`.
- `phase_started` and `phase_finished` events need a top-level `phase` of `explore`, `implement`, `review`, `complete` or `finalize`; `orc progress` rejects any other `--phase`. Events already stored without one stay readable.
- `setRunFinalizationState` rejects a move outside the documented finalization graph ([contracts.md → Invariants](docs/contracts.md#invariants)); `finalization_state` is not strictly forward-only (`ready_to_merge → finalize_rebase_requested` after a failed merge).
- Event reads are one MCP tool and one command. MCP `get_recent_events` and `get_notifications` are removed: use `query_events` (`notifications_only: true` for the notification class), which now returns `{ events, last_seq, has_more }` pages (default 25, max 100; with `after_seq` the oldest events after it, without it the newest) with compact events unless `verbose: true`. `orc events-tail` and `orc events-filter` are removed, with no aliases: use `orc events`, which takes the same filters as `query_events` and prints the same JSON with `--json`. Differences from the removed commands: `--event` takes one type (no repeats or comma lists); `--last`/`--n` become `--limit` (max 100, page on with `--after`), so no single call returns the whole log; an `agent_id` filter matches only the event's `agent_id`, not its `actor_id` as `get_recent_events` did. A master starts its notification cursor at `get_status.last_notification_seq` instead of replaying history.
- Run listings are one MCP tool and one command. MCP `list_active_runs`, `list_stalled_runs` and `list_waiting_input` are removed: use `list_runs(state?: "active" | "stalled" | "waiting_input", stale_after_ms?)`, which returns `{ runs }` with rows `run_id`, `task_ref`, `agent_id`, `state`, `phase`, `age_seconds`, `idle_seconds`, `stalled`, plus `question`, `request_id`, `waiting_seconds` on a run waiting for input. `orc runs-active` and `orc waiting-input` are removed, with no aliases: use `orc runs [--state=active|stalled|waiting-input] [--stale-after-ms=N] [--json] [--via-control]`, which prints the same JSON. The old `runs-active` JSON fields `project`, `total`, `event_read_error`, `awaiting_run_started`, `last_activity_*`, `lease_expires_at`, `task_status` and `spec_revision` are gone (`orc run-info` and `orc control snapshot` still carry the per-run ones). A claimed run whose TASK_START has not been delivered has no idle time and is no longer counted as stalled.
- MCP `memory_recall` is removed: `memory_search` without `query` browses a `wing` (and `room`) and returns full drawers. `memory_search` now always returns `{ results }`.
- `orc start-session` adopts live worker sessions instead of resetting runtime state. `--reset` is the explicit fresh start and is refused while a master runs.

### Added

- MCP `doctor` (the `orc doctor` checks, one `{ name, ok, detail }` line each, same verdict) and `terminal_snapshot(run_id, lines?)` (a read-only, ANSI-stripped look at the last lines of a run's tmux provider terminal, as `orc terminal provider --once`). Neither needs the master secret.
- Control API `GET /v1/runs?state=&stale_after_ms=` and `ControlClient.runs()` (with the `RunListRow`/`RunListState` types on `orc-state/client`): the `orc runs --json` / MCP `list_runs` view.
- MCP `get_status` reports `coordinator` (`{ running, pid, version, started_at, stale }`, as `orc coordinator status`) and a `waiting_input` count; `orc status --json` adds the same `coordinator` and counts waiting runs in `claims.waiting_input`.
- **`orc-state/client` entry**: a side-effect-free import for apps and TUIs with `ControlClient`, `ControlError`, `listProjects`, `RegistrySchemaError` and the protocol types ([Embedding orc](docs/embedding.md)).
- **`listProjects()`**: every registered project as `ProjectListEntry` (`id`, `name`, `target_repo_root`, `state_dir`, `repo_present`, `control_socket`, `coordinator_running`), read from `registry.db` without creating anything. `control_socket` is set only while the coordinator runs. `orc project list --json` returns the same shape.
- **Control API**: typed `status` and `health` routes (`version`, `build_id`); event filters by run, agent and event type; run detail; a task summary list; task revisions; plan import and scout request/report over the API; stream frames that show an open stream is alive, closed or resized.
- **Operator**: answer a worker's input request with `respond-input`; waiting-input rows carry `request_id`.
- **Events**: one for every run and finalization state change (`finalization_changed` and the run lifecycle events), `session_opened` and `session_state_changed` for every session-row write, `session_reconciled`, `session_resumed`, `session_resume_failed`, `scout_launched`, `scout_launch_failed`.
- **Stale coordinator detection**: `orc doctor`, `orc start-session` and `/v1/health` compare the running coordinator's `version` and `build_id` with the code on disk; `orc start-session --restart-stale` restarts it and keeps state.
- **Terminals**: input is sent in one async tmux call, a writer lease honours `ttl_ms`, and `orc terminal --takeover` (operator only) takes the write lease.
- **Docs and CI**: [Embedding orc](docs/embedding.md); a test that `docs/cli.md` and `cli/usage.ts` list the same flags; CI runs `pack:smoke`, `install:smoke` and a consumer `tsc --noEmit` against `dist/*.d.ts` on Linux and macOS.

### Changed

- The master bootstrap (`MASTER_BOOTSTRAP v3`) is rewritten as workflow guidance only (under 5 KB, was 15 KB): tools are named, not restated; successful runs are reported together instead of one prompt each; it covers provider permission prompts, workers waiting in `orc run-input-request`, and rebuilding plus `restart_coordinator` after orc changes.
- **CLI output**: operator commands and `orc coordinator start|stop|status` return JSON with `--json` (one compact line when piped); commands that read project state parse arguments strictly (unknown flag → exit 1) and fail loudly when no project resolves.
- Cancelled runs are kept as failed rows, and run ids cannot collide.
- A worker is torn down only after consecutive dead probes, not one.
- `orc status` reads the event cursor before the state it describes.
- `orc watch` keeps its frame below the terminal height, so it stops flickering.
- `GET /v1/sessions` lists every session that is not offline, with `state` and `state_reason` (`SessionTerminalView` gains both), so `recoverable` and `unknown` sessions show up.
- Agent reads report a `running` agent whose latest session is offline as `offline`, without a `session_token`; the coordinator resumes or requeues its run on the next tick.
- A worker launch whose run was cancelled meanwhile stops the session it started and fails, instead of leaving a running agent without a session record.
- The stop hook allows a stop before `TASK_START`.

## [1.0.0] - 2026-11-08

### Breaking

- No upgrade path from 0.3: register the repository again and re-create tasks ([Upgrading from 0.3](docs/getting-started.md#upgrading-from-03)).
- State has moved out of the repository: `.orc-state/`, `backlog/` and `plans/` are no longer read.
- tmux 3.2+ is required. Platforms: macOS and Linux. Windows needs WSL.
- Package exports are now only the root and `./schemas/*`; the `./adapters` and `./coordinator` subpaths are gone.
- The root API now exports `ControlClient` and the control protocol types; `validateBacklog`, `validateClaims` and `validateStateDir` are removed.

### Added

- **Project registry**: `orc project add|list|select|show` registers repositories; `orc project config` holds settings globally or per project.
- **Repo-external SQLite state**: tasks, runs, sessions and events live in SQLite under the data home, so nothing is written into the repository.
- **Task store**: `orc project task create|edit|import|export` and `orc project plan import|export`. Each run pins the revision of its task spec.
- **Local control API**: a versioned daemon API (protocol v1) on a local socket. Every session authenticates with its own secret, and worker, master and operator writes all go through the coordinator.
- **Session resume**: a worker that crashes is resumed in place, up to twice per run, instead of the run being requeued (`sessions.resume`).
- **Master detach/reattach**: the master runs in orc's tmux server. `Ctrl-b d` detaches, `orc start-session` reattaches, and a dead Claude master resumes its conversation.
- **Terminal streams**: `orc terminal provider|shell <run_id>` streams a run's terminal live, with an exclusive `--write` input lease. A shell in the worktree persists across detaches.
- `orc attach` opens a real tmux client, read-only by default; pass `--write` to type.
- Recovery and inspection: `orc run-close` (for manually merged runs), `orc task-cancel`, `orc sessions`, `orc worker-gc`.
- Run health: the coordinator infers run phases, escalates runs that are alive but not progressing, and blocks a worker from stopping while its run is unfinished.
- Codex structured worker runtime: `codex app-server`, which runs as `app:` sessions.
- CI runs on Ubuntu and macOS.

### Changed

- `orc init` records provider settings in the registry and writes nothing into the repository.
- MCP write tools require the master session.
- `orc status` lists scouts by id and state instead of reporting a scout capacity pool.
- Every command prints its usage from one source.

### Removed

- The node-pty session transport: workers and the master run only in tmux, or as structured `app:` sessions.
- Markdown backlog and plan verbs (`/plan`, `/spec`) and the backlog commands: `backlog-sync`, `backlog-sync-check`, `backlog-ready`, `backlog-blocked`, `backlog-orient`.
- `task-create` and `feature-create`: use `orc project task create`.
- Persistent workers and capability routing: `register-worker`, `start-worker-session`, `control-worker`, `deregister` and `worker-clearall` are gone. Use `worker-remove` and `worker-gc`.
- The sibling layout, the legacy JSON layout and the 0.x migration.

## [0.3.0] - 2026-04-18

### Added

- add integration coverage for /plan + /spec round-trip
- randomize orc-themed worker names
- add task spec to randomize orc-themed worker names
- implement /spec from saved plans
- add /plan skill and plan_write MCP tool
- extract file-backed plan-to-backlog engine
- add plan artifact contract, parser, lookup, and id allocator
- add backlog tasks for plan and spec verbs

### Changed

- mark task 183 done
- audit plan, spec, and orc-commands skills
- clean up create-task skill
- prune plan-to-tasks-workspace eval harness
- mark task 181 done
- mark task 182 done
- drop sync-check gate from agent instructions
- mark task 179 done
- mark task 180 done
- mark task 176 done
- revise plan/spec task specs after review

### Fixed

- clear ambient ORC env vars before paths/runWorktree mocks
- set ORC_PLANS_DIR in runWorktree tests
- address review findings on /spec publisher
- address review findings on /plan authoring
- address review findings on plan-to-backlog engine

### Other

- address critic findings on integration tests## [0.2.5] - 2026-04-15

### Fixed

- filter internal changelog commits
- preserve shell cwd spelling
- repair dispatch assertion typing
- align smoke tests with task-scoped workers## [0.2.4] - 2026-04-15

### Fixed

- wire codex mcp config
- add orc version flag

## [0.2.3] - 2026-04-14

### Fixed

- exclude non-skill artifacts from installs

## [0.2.2] - 2026-04-14

### Changed

- add changelog filtering task

## [0.2.1] - 2026-04-14

### Fixed

- repair node-pty spawn helper permissions

## [0.2.0] - 2026-04-14

### Added

- add interactive worker provider prompt
- spawn task-scoped workers with dynamic provider routing
- update live worker views and remove persistent-slot assumptions
- introduce ephemeral worker naming and shared capacity

### Changed

- add --worker-provider flag to orc init documentation
- explain start-session behavior between quick start and how it works
- fix quick start — drop --provider flag, explain orc init
- mark task done
- mark task done
- update architecture docs for ephemeral task-scoped workers
- mark task done
- mark task done
- add dynamic worker architecture tasks

### Fixed

- validate --worker-provider, add tests, fix stale getting-started text
- always show worker provider prompt, not just for multi-provider
- move env var cleanup to afterEach for test isolation
- update e2e tests for dynamic ephemeral worker model

### Other

- address review findings, fix coordinator test regressions

## [0.1.2] - 2026-04-13

### Fixed

- clean published tarball contents

## [0.1.1] - 2026-04-13

### Changed

- add "How it works" section explaining master agent interaction

## [0.1.0] - 2026-04-08

### Added

- CLI tool (`orc`) with 60+ subcommands for orchestration lifecycle
- Provider-agnostic coordinator with autonomous task dispatch
- PTY adapter for headless worker sessions (Claude, Codex, Gemini)
- File-based state management (backlog, agents, claims, events)
- Backlog system with markdown task specs and frontmatter sync
- Five-phase worker lifecycle (explore → implement → review → complete → finalize)
- Sub-agent review system with structured findings format
- Memory system with spatial taxonomy, FTS5 search, and pruning
- MCP server for master agent orchestration tools
- Interactive TUI dashboard (`orc watch`)
- Git worktree isolation for parallel task execution
- Input request/response flow for worker-master communication
- Scout role for on-demand read-only investigations
- Configurable execution modes (full-access, sandbox)
- Multi-provider support with per-worker provider selection
