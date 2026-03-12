# Task 116 — Review and Update All Orchestrator Documentation

Independent.

## Scope

### In scope
- `orchestrator/README.md` — full review and update to match current runtime behaviour
- `docs/orchestrator-robustness-plan.md` — mark completed items, remove stale entries
- Any other `.md` files under `orchestrator/` or `docs/` that describe orchestrator behaviour
- Accuracy of CLI command examples, env-var table, session model description

### Out of scope
- Game/scene documentation (`docs/specs/`, `docs/art/`, `docs/beat-em-up-*`)
- Writing new architecture docs not already started
- Changes to source code

## Context

Multiple waves of orchestrator work (tasks 85–115) have landed since the README and robustness plan were last updated. Key changes that are currently undocumented or misdocumented:

- Master session now uses **node-pty** (not `child_process.spawn`), enabling PTY-based interaction
- **TASK_COMPLETE notification injection** via `masterPtyForwarder` — not documented anywhere
- **Multi-provider support** (Codex, Gemini) with per-provider bootstrap templates, prompt patterns, and submit sequences — only partially in README
- `orc-master-check` CLI command added (task 92) — not in README
- `delegate_task` now guards against assigning to agents with active claims (task 108)
- Queue compaction and atomic read-mark in `masterNotifyQueue` (task 109)
- `startMasterPtyForwarder` / bracketed paste handling — no user-facing docs
- `docs/orchestrator-robustness-plan.md` lists many issues as open; most have been resolved by tasks 85–115

**Affected files:**
- `orchestrator/README.md` — primary operator reference
- `docs/orchestrator-robustness-plan.md` — execution roadmap (partially stale)

## Goals

- Must update `orchestrator/README.md` to accurately describe the current session model (node-pty, master forwarder, TASK_COMPLETE notifications, multi-provider support).
- Must add a section or bullet for `orc-master-check` to the README's monitoring commands.
- Must update `docs/orchestrator-robustness-plan.md` to mark all items resolved by tasks 85–115 as ✅ done, and remove or flag any items that are no longer relevant.
- Must ensure all CLI command examples in the README are runnable and correct.
- Must not introduce factual errors about unimplemented features.

## Implementation

### Step 1 — Audit current docs against the codebase

Read the following files to understand the current state:
- `orchestrator/README.md`
- `docs/orchestrator-robustness-plan.md`
- `cli/start-session.mjs` (session spawn, PTY, forwarder wiring)
- `lib/masterPtyForwarder.mjs` (notification injection)
- `lib/masterNotifyQueue.mjs` (queue operations)
- `lib/binaryCheck.mjs` (provider binaries, prompt patterns)
- `cli/master-check.mjs` (orc-master-check command)
- `orchestrator/package.json` (npm scripts — source of truth for CLI commands)

### Step 2 — Update `orchestrator/README.md`

Update the following sections:

**Session Model** — add:
- Master session spawns provider CLI via node-pty (PTY, not bare child process)
- Worker TASK_COMPLETE notifications are injected automatically into the master PTY when Claude is idle at its `>` prompt

**Quick Start** — verify all `npm run` commands match `package.json` scripts exactly

**Monitoring** — add `orc-master-check` with a one-line description

**Provider support** — expand the env-var table or add a section noting that Codex and Gemini are supported providers, with their bootstrap templates and prompt-detection patterns

**File:** `orchestrator/README.md`

### Step 3 — Update `docs/orchestrator-robustness-plan.md`

For each numbered issue in the plan:
- Mark as ✅ if resolved by any task in 85–115 (note which task)
- Mark as ⚠️ if partially addressed
- Mark as ❌ if still open

Add a brief "Completed in tasks 85–115" summary section at the top.

**File:** `docs/orchestrator-robustness-plan.md`

### Step 4 — Scan for other stale orchestrator docs

Check `orchestrator/` and `docs/` for any other `.md` files describing orchestrator behaviour. If found and stale, update them. If no others exist, note that in a comment.

## Acceptance criteria

- [ ] `orchestrator/README.md` mentions node-pty and the master PTY forwarder / TASK_COMPLETE injection
- [ ] `orchestrator/README.md` lists `orc-master-check` under monitoring commands
- [ ] All `npm run` command examples in the README match the scripts in `orchestrator/package.json`
- [ ] `docs/orchestrator-robustness-plan.md` has every item from tasks 85–115 marked ✅
- [ ] No factual claims about unimplemented behaviour added to either doc
- [ ] No changes to source code files (`.mjs`, `.json` schemas, tests)
- [ ] No changes to files outside the stated scope.

## Tests

No automated tests — this is a documentation-only task.

Manual verification: read the updated docs and confirm each acceptance criterion above is satisfied by inspection.

## Verification

```bash
# Confirm no source files were modified
git diff --name-only | grep -v '\.md$' | grep -v 'docs/' | grep -v 'orchestrator/README'
# Should produce no output
```

```bash
# Confirm orc-master-check appears in README
grep -i 'master-check\|orc-master-check' orchestrator/README.md
```

```bash
# Confirm node-pty or PTY is mentioned
grep -i 'node-pty\|pty\|forwarder' orchestrator/README.md
```
