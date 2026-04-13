# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
