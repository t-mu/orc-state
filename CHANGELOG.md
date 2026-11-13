# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-13

A rewrite of orc's core. No upgrade path from 0.3: register the repository again ([Upgrading from 0.3](docs/getting-started.md#upgrading-from-03)).

### Highlights

- **State outside the repository**: SQLite stores (tasks, runs, events, registry) under orc's data home; projects are registered once and selected by directory or `--project`.
- **Coordinator and control API**: one coordinator per project dispatches task-scoped workers (Claude, Codex, Gemini) into their own worktrees, drives their run lifecycle (explore → implement → review → complete → finalize), resumes or requeues crashed sessions, and serves a local control API (`orc-state/client`: `ControlClient`, `ProjectWatcher`, `listProjects`).
- **The War Room** (`orc start-session`, `orc cockpit`): a terminal UI with its own renderer — campaigns, the active project's settings and its grunts in the sidebar, tabs for the master, workers, shells and ad-hoc agent sessions, themes (`orc` by default), a project settings dialog and a Ctrl-Space leader keymap ([cockpit design](docs/cockpit-design.md)).
- **Workers use the configured model**: a task without its own `model` runs the pool's default for its provider (`worker_pool.provider_models` / `worker_pool.model`), and every agent records the model it runs.
- **One MCP tool and one command per read**: events (`query_events` / `orc events`), runs (`list_runs` / `orc runs`), status, doctor and terminal snapshots for the master.
- **Requirements**: Node 24, tmux 3.2+, macOS or Linux (Windows via WSL). Tested in CI on both (tmux 3.4 on Linux, 3.8 on macOS).

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
