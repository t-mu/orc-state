# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
