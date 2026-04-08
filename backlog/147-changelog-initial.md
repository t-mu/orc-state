---
ref: general/147-changelog-initial
feature: general
priority: high
status: todo
---

# Task 147 — Add CHANGELOG.md with 0.1.0 Release Entry

Independent.

## Scope

**In scope:**
- Create `CHANGELOG.md` at repo root following Keep a Changelog format
- Single `[0.1.0]` section summarizing the initial release
- Add `"CHANGELOG.md"` to the `files` array in `package.json`

**Out of scope:**
- Automating changelog generation from git history
- Adding changelog entries for unreleased work
- Modifying any source code

---

## Context

The package is at version 0.1.0 with no changelog. Consumers evaluating the
package cannot assess release history, stability trajectory, or what shipped.
`package.json` `files` array (line ~80) currently includes `["dist", "docs",
"README.md"]` — CHANGELOG.md would not be included in the npm tarball without
adding it.

**Affected files:**
- `CHANGELOG.md` — new file
- `package.json` — add to `files` array

---

## Goals

1. Must follow [Keep a Changelog](https://keepachangelog.com/) format.
2. Must contain a `[0.1.0]` section with categorized summary of initial release.
3. Must be included in the npm tarball via the `files` array in `package.json`.

---

## Implementation

### Step 1 — Create CHANGELOG.md

**File:** `CHANGELOG.md`

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
```

### Step 2 — Add to package.json files array

**File:** `package.json`

Change the `files` array from:
```json
"files": ["dist", "docs", "README.md"],
```
to:
```json
"files": ["dist", "docs", "README.md", "CHANGELOG.md"],
```

---

## Acceptance criteria

- [ ] `CHANGELOG.md` exists at repo root.
- [ ] Follows Keep a Changelog format with proper header and semver note.
- [ ] Contains `[0.1.0]` section dated `2026-04-08`.
- [ ] Categories cover the major features shipped.
- [ ] `package.json` `files` array includes `"CHANGELOG.md"`.
- [ ] `npm pack --dry-run` output includes `CHANGELOG.md`.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new test files — this is a documentation-only change.

Verify inclusion in tarball:

```bash
npm pack --dry-run 2>&1 | grep CHANGELOG.md
```

---

## Verification

```bash
nvm use 24 && npm test
```
