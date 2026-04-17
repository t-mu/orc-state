---
name: orc-commands
description: >
  Reference for all orc CLI subcommands, their usage, flags, and common operational
  patterns. Use when you need to run any orchestrator CLI command, reset task/agent
  state, inject input to a worker, or understand the run lifecycle.
argument-hint: "[command name or operation]"
---

# Orc Commands Reference

## Critical: State Directory

All orc commands resolve state from `process.cwd()/.orc-state` unless overridden.
**Always run from the repo root**, or prefix with the env var:

```bash
ORC_STATE_DIR=<your-project>/.orc-state orc <cmd>
```

Commands that forget this will hit `ENOENT` errors or read wrong state. The `kill-all`
command is especially dangerous to run accidentally — it stops the coordinator and
clears all agents.

---

## All Subcommands

## Blessed Path First

Normal workflow:

1. `orc start-session`
2. write/edit the backlog markdown spec
3. coordinator auto-syncs specs to runtime state on each tick (no explicit verify step needed)
4. `orc delegate`
5. worker lifecycle via `run-start` -> `run-work-complete` -> `run-finish`
6. inspect with `orc status` / `orc doctor`; `orc backlog-sync-check` is available ad-hoc if you want to double-check state

Outside the blessed workflow, use only:

- supported inspection commands for observability
- advanced / specialized commands for setup or niche workflows
- recovery/debug commands for exceptional cases

### Session / Coordinator Management

| Command | Usage | Notes |
|---------|-------|-------|
| `start-session` | `orc start-session [--provider=<claude\|codex\|gemini>]` | Starts coordinator + master session interactively. Requires TTY. |
| `status` | `orc status [--mine] [--agent-id=<id>]` | Print agent/task/claim table. |
| `doctor` | `orc doctor` | Validate state files, check provider keys/binaries, find orphaned claims. |
| `preflight` | `orc preflight` | Lightweight environment health check. |
| `init` | `orc init [--force]` | Initialise state directory. `--force` overwrites existing files. |
| `kill-all` | `orc kill-all` | ⚠️ Stops coordinator + clears ALL agents. Use only to fully reset. **Never run in a loop or batch script** — it has no `--help` guard and executes immediately. |
| `install-agents` | `orc install-agents [--global] [--provider=claude,codex] [--dry-run]` | Install the packaged provider-agnostic agent prompts into `.claude/agents/` or `.codex/agents/`. |
| `install-skills` | `orc install-skills [--global] [--provider=claude,codex] [--dry-run]` | Install the packaged provider-agnostic skills into `.claude/skills/` or `.codex/skills/`. |

### Worker Management

These commands are recovery/debug only. Do not choose them when the blessed workflow applies.

| Command | Usage | Notes |
|---------|-------|-------|
| `register-worker` | `orc register-worker <id> --provider=<claude\|codex\|gemini>` | Register a new worker agent. |
| `start-worker-session` | `orc start-worker-session <id> --provider=<claude\|codex\|gemini> [--role=<worker\|reviewer>] [--force-rebind]` | Launch a headless PTY session for a worker. |
| `attach` | `orc attach <id>` | Print tail of a worker's PTY output log. Read-only. |
| `control-worker` | `orc control-worker <id>` | Attach to a running worker session for inspection. |
| `deregister` | `orc deregister <id>` | Remove a specific agent registration. |
| `worker-remove` | `orc worker-remove <id>` | Remove a worker (stops session + deregisters). |
| `worker-gc` | `orc worker-gc` | Mark stale workers offline. |
| `worker-clearall` | `orc worker-clearall` | Remove all offline/stale workers. |

### Supported Inspection

These commands are for observability. They are supported, but they are not alternate workflow entry points.

| Command | Usage | Notes |
|---------|-------|-------|
| `watch` | `orc watch` | Live-refresh status display. |
| `runs-active` | `orc runs-active` | List all in-progress/claimed runs. |
| `events-tail` | `orc events-tail` | Tail the persisted event stream. |

### Task Management

| Command | Usage | Notes |
|---------|-------|-------|
| `task-create` | `orc task-create --feature=<ref> --title=<text> [options]` | Add a task to backlog. Recovery path only — the normal path is to save a `backlog/<N>-<slug>.md` spec and let the coordinator auto-sync on its next tick. |
| `task-mark-done` | `orc task-mark-done <feature/task>` | Mark a task done in runtime state after the markdown spec has already been updated. |
| `task-reset` | `orc task-reset <feature/task>` | Reset a task to `todo`, cancelling any active claim. Use when a blocked or stuck task needs another attempt. |
| `task-unblock` | `orc task-unblock <feature/task>` | Transition a blocked task back to `todo`. |
| `backlog-sync` | `orc backlog-sync` | Repair runtime backlog metadata from authoritative markdown specs. |
| `backlog-sync-check` | `orc backlog-sync-check` | Validate that runtime backlog metadata matches active markdown specs. Ad-hoc only — not part of the task-creation flow. |
| `delegate` | `orc delegate --task-ref=<feature/task> [--target-agent-id=<id>] [--task-type=<implementation\|refactor>] [--note=<text>] [--actor-id=<id>]` | Assign a task to a worker. |

### Run Lifecycle (Worker Commands)

Workers emit these from inside their PTY session via Bash tool:

| Command | Usage | Notes |
|---------|-------|-------|
| `run-start` | `orc run-start --run-id=<id> --agent-id=<id>` | **Required first.** Acknowledge task start. |
| `run-work-complete` | `orc run-work-complete --run-id=<id> --agent-id=<id>` | Signal implementation+review+rebase done. Remain alive for coordinator finalization. |
| `run-finish` | `orc run-finish --run-id=<id> --agent-id=<id>` | Terminal success. Emit only after `run-work-complete` handoff. |
| `run-fail` | `orc run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--policy=requeue\|block]` | Terminal failure. Default policy is `requeue`. |
| `progress` | `orc progress --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue\|block>]` | Emit a named lifecycle event (e.g. `phase_started`, `phase_finished`). |

### Lifecycle verbs (MCP tools + skills)

Agent-agnostic workflows for authoring plans and backlog tasks. Any caller
may invoke them from inside a fresh worktree — they have no master affinity.
See the individual skills for the full flow.

| MCP tool | Skill | Purpose |
|----------|-------|---------|
| `plan_write` | `/plan` (`skills/plan/SKILL.md`) | Persist a fully-specified plan artifact to `plans/<plan_id>-<slug>.md` within the current worktree. Allocates `plan_id` atomically, validates all required sections, writes `derived_task_refs: []`, rejects unresolved placeholders, and hard-fails on unrelated feature-slug collisions unless `acknowledge_feature_collision: true` is set. Does NOT touch `.orc-state/backlog.json`, git, or any file outside the worktree — commit and merge are the skill's responsibility. |
| `spec_preview` | `/spec` (`skills/spec/SKILL.md`) | Preview the backlog task specs that would be generated from `plans/<plan_id>-*.md`. Pure read — no files written, no state mutated. Pair with `spec_publish`. |
| `spec_publish` | `/spec` (`skills/spec/SKILL.md`) | Publish generated specs into the current worktree's `backlog/` and write `derived_task_refs` back into the plan file. Stages under `<state_dir>/plan-staging/<plan_id>/` as a concurrency lock. Hard-fails if `confirm !== true`, if the plan already has non-empty `derived_task_refs`, or if the staging directory already exists. Does NOT touch `.orc-state/backlog.json` or git — the caller commits and merges per AGENTS.md. |

Both `spec_*` tools accept an optional `worktree_path` that targets a
specific worktree. Recommended for worker-initiated calls — the MCP
server's own cwd is the main checkout, not the worktree. `/spec plan <id>`
uses a saved plan artifact directly; `/spec` (no args) takes the most
recent printed plan from the conversation, persists it via `plan_write`,
then continues through preview/publish.

### Input Request / Response

For workers that need master input (e.g. blocked on a decision):

| Command | Usage | Notes |
|---------|-------|-------|
| `run-input-request` | `orc run-input-request --run-id=<id> --agent-id=<id> --question=<text> [--timeout-ms=<ms>]` | Worker calls this to ask master a question. Blocks until response or timeout. |
| `run-input-respond` | `orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>]` | Master calls this to answer a worker's input request. |

### Memory (Worker)

Workers use these to persist and recall drawer-scoped memories. Store lives at `.orc-state/memory.db` (SQLite).

| Command | Usage | Notes |
|---------|-------|-------|
| `memory-wake-up` | `orc memory-wake-up [--wing=<wing>] [--budget=<N>]` | Recall essential memories at session start. |
| `memory-record` | `orc memory-record --content="..." [--wing=<wing>] [--hall=<hall>] [--room=<room>] [--importance=<N>]` | Store a memory. |
| `memory-search` | `orc memory-search <query> [--wing=<wing>] [--room=<room>]` | FTS5 search across stored memories. |
| `memory-status` | `orc memory-status` | Memory store statistics. |

---

## Common Operational Patterns

### Reset a blocked/failed task to todo

```bash
orc task-reset <feature>/<N>-<slug>
```

Use the CLI or MCP tools for orchestrator state changes. Do not mutate state
files through internal library helpers from an agent session.

### Restart coordinator cleanly

Recovery/debug only:

```bash
# 1. Kill existing
ps aux | grep "coordinator.ts" | grep -v grep | awk '{print $2}' | xargs kill

# 2. Start with explicit state dir (avoids cwd ambiguity)
ORC_STATE_DIR=/path/to/repo/.orc-state node /path/to/repo/coordinator.ts \
  >> /path/to/repo/.orc-state/coordinator.out.log 2>&1 &
```

---

## Run Lifecycle State Machine

```
claim_created  →  run_started  →  [phase_started / phase_finished / heartbeat]
                                           ↓
                                   run_work_complete  (non-terminal; wait for coordinator)
                                           ↓
                              run_finished  |  run_failed
```

Coordinator also emits:
- `claim_expired` — when run hits idle timeout (30 min default); task requeued
