# CLI reference

All commands are invoked as `orc <subcommand> [args...]`.
Run `orc --help` for the full list.

---

## Session management

These are the commands you'll use to start and stop the orchestrator.

### `orc init`

Interactive first-time setup. Walks you through provider selection, initializes
state files, and installs skills, agents, and MCP configuration for your chosen
providers.

```bash
orc init                           # interactive (TTY)
orc init --provider=claude         # non-interactive
orc init --provider=claude,codex   # multiple providers
orc init --force                   # reinitialize (backs up existing state)
```

**Flags:** `[--provider=<providers>]` `[--worker-provider=<name>]` `[--feature=<ref>]` `[--feature-title=<title>]` `[--skip-skills]` `[--skip-agents]` `[--skip-mcp]` `[--force]`

### `orc start-session`

Start the coordinator (background process) and master agent session (foreground).
The coordinator manages the task lifecycle — dispatching work to workers, monitoring
health, and merging completed tasks. The master is your interactive session.

```bash
orc start-session                          # uses default provider from config
orc start-session --provider=claude        # explicit provider
```

**Flags:** `[--provider=claude|codex|gemini]` `[--agent-id=<id>]`

### `orc kill-all`

Full reset. Stops the coordinator, terminates all worker sessions, clears the
agent registry, and requeues any in-flight tasks. Use when the system is in a
bad state and you want a clean slate.

```bash
orc kill-all
```

**Flags:** `[--keep-sessions]`

---

## Monitoring

Commands for checking what the orchestrator is doing.

### `orc status`

Print a summary of agents, tasks, claims, and worker capacity. This is the
first command to run when you want to know what's going on.

```bash
orc status                # one-shot summary
orc status --watch        # auto-refresh
orc status --json         # machine-readable
```

**Flags:** `[--json]` `[--mine --agent-id=<id>]` `[--watch|-w]` `[--interval-ms=<ms>]` `[--once]`

### `orc watch`

Live-updating TUI dashboard. Shows agents, active runs, task progress, and
worker capacity in real time. Falls back to plain text refresh if no TTY.

```bash
orc watch
```

**Flags:** `[--interval-ms=<ms>]` `[--once]`

### `orc doctor`

Comprehensive health check. Validates state files, checks provider binaries
are installed, detects stale workers, orphaned claims, lifecycle invariant
violations, sandbox dependencies, and memory store integrity.

```bash
orc doctor
orc doctor --json
```

If doctor reports issues, follow its suggested fixes.

**Flags:** `[--json]`

### `orc preflight`

Lightweight environment validation. Checks that the repo is set up correctly,
state files exist, and provider CLIs are available. Faster than `doctor` — use
before `start-session` to catch obvious problems.

```bash
orc preflight
```

**Flags:** `[--json]`

---

## Setup

These commands are called by `orc init` automatically. You typically don't need
to run them directly unless you're updating an existing installation.

| Command | Description |
|---------|-------------|
| `install` | Install skills, agents, and MCP config for configured providers. |
| `install-skills` | Install skill definitions for supported provider targets. |
| `install-agents` | Install agent configuration files for supported provider targets. |

**Flags:**

| Command | Flags |
|---------|-------|
| `install` | `[--provider=<providers>]` `[--global]` `[--dry-run]` `[--skip-skills]` `[--skip-agents]` `[--skip-mcp]` |
| `install-agents` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |
| `install-skills` | `[--provider=<providers>]` `[--global]` `[--dry-run]` |

---

## Worker management

Recovery and debug commands for managing worker agents directly. In normal
operation, the coordinator spawns and manages workers automatically — these
commands are for when you need to intervene manually.

| Command | Description |
|---------|-------------|
| `register-worker <id>` | Manually create a worker agent record. |
| `start-worker-session <id>` | Launch a headless PTY session for an existing worker. |
| `attach <id>` | Print the tail of a worker's PTY output log (read-only). |
| `control-worker <id>` | Interactive PTY control of a running worker session. |
| `deregister <id>` | Remove an agent registration. Blocks if active claims exist. |
| `worker-remove <id>` | Stop a worker's session and remove it. |
| `worker-gc` | Mark workers with dead PIDs as offline. |
| `worker-clearall` | Remove all offline and stale workers. |
| `worker-status [agent_id]` | Show worker state, active task, and session info. |

**Flags:**

| Command | Flags |
|---------|-------|
| `register-worker` | `<id>` `--provider=codex\|claude\|gemini` `[--role=worker\|reviewer\|scout]` `[--capabilities=<a,b>]` |
| `start-worker-session` | `<id>` `[--provider=codex\|claude\|gemini]` `[--force-rebind]` |
| `worker-remove` | `<id>` `[--keep-session]` |
| `worker-gc` | `[--deregister]` |
| `worker-status` | `[<agent_id>]` `[--json]` |

---

## Task management

Commands for creating, completing, and managing tasks. In normal operation,
the master agent handles task creation and the coordinator handles dispatch.
These are available for manual intervention and debugging.

| Command | Description |
|---------|-------------|
| `task-create` | Register a task from an existing markdown spec in `backlog/`. |
| `task-mark-done <task-ref>` | Mark a task done. Updates spec frontmatter and runtime state. |
| `task-reset <task-ref>` | Reset a task to `todo`, cancelling any active claims. |
| `task-unblock <task-ref>` | Transition a blocked task back to `todo`. |
| `delegate` | Dispatch a task to an available worker agent. |
| `feature-create <ref>` | Create a new feature grouping in the backlog. |

**Flags:**

| Command | Flags |
|---------|-------|
| `task-create` | `--feature=<ref>` `--title=<text>` `[--ref=<slug>]` `[--task-type=implementation\|refactor]` `[--description=<text>]` `[--ac=<criterion>]` `[--depends-on=<task-ref>]` `[--owner=<agent_id>]` `[--required-capabilities=<cap>]` `[--required-provider=<provider>]` |
| `task-mark-done` | `<task-ref>` `[--actor-id=<id>]` |
| `task-reset` | `<task-ref>` `[--actor-id=<id>]` |
| `task-unblock` | `<task-ref>` `[--reason=<text>]` |
| `delegate` | `--task-ref=<feature/task>` `[--target-agent-id=<id>]` `[--task-type=implementation\|refactor]` `[--note=<text>]` |
| `feature-create` | `<ref>` `[--title=<text>]` |

---

## Backlog

Commands for inspecting and repairing the backlog — the set of markdown task
specs in `backlog/` and their runtime state in `.orc-state/backlog.json`.

| Command | Description |
|---------|-------------|
| `backlog-sync` | Repair runtime state from markdown specs. |
| `backlog-sync-check` | Validate specs match runtime state. Exits 1 on mismatch. |
| `backlog-ready` | List tasks eligible for dispatch (todo + deps satisfied). |
| `backlog-blocked` | List blocked tasks with reasons. |
| `backlog-orient` | Print backlog summary: next task seq, features, task counts. |

**Flags:**

| Command | Flags |
|---------|-------|
| `backlog-sync-check` | `[--refs=<ref1,ref2,...>]` |
| `backlog-ready` | `[--json]` |
| `backlog-blocked` | `[--json]` |

---

## Plans

Plans live alongside the backlog as a first-class artifact directory. A plan
artifact is a markdown file at `plans/<plan_id>-<slug>.md` that captures the
approved design for a chunk of work before it becomes backlog tasks.

**On-disk contract:**

- Required frontmatter: `plan_id`, `name`, `title`, `created_at`, `updated_at`,
  `derived_task_refs`. `derived_task_refs: []` is valid for fresh plans.
- Required sections: `## Objective`, `## Scope`, `## Out of Scope`,
  `## Constraints`, `## Affected Areas`, `## Implementation Steps`.
- `## Implementation Steps` is an ordered sequence of `### Step N — Title`
  sub-headings. Steps may declare dependencies with the exact structured cue
  `Depends on: N` or `Depends on: N, M`. The structured cue is plans-only;
  backlog specs continue to use the prose `Depends on Task N.` form.
- Plan bodies must not contain unresolved placeholders: `TBD`, `TODO`, three or
  more `?` characters, or bare bracketed fill-ins (`[like this]`) outside fenced
  code blocks and outside markdown link syntax (`[text](url)`).
- Plan files must be UTF-8 without a byte-order mark.
- `plan_id` numbering is an independent sequence from backlog task numbers.
  Collisions across the two sequences are expected and benign.

See `plans/TEMPLATE.md` for the baseline artifact. Parsing, lookup
(`findPlanById`), and id allocation (`nextPlanId`) helpers live in
`lib/planDocs.ts`.

### Turning a plan into backlog tasks — `/spec`

`/spec` is an agent-agnostic skill (`skills/spec/SKILL.md`) that converts a
plan into backlog task specs. It has two invocation forms; both flow through
the same MCP tools (`spec_preview`, `spec_publish`) and the same file-backed
engine (`lib/planToBacklog.ts`).

- **`/spec plan <id>`** — reads the saved plan at `plans/<id>-*.md`, shows a
  preview of the proposed backlog specs, asks for confirmation, then
  publishes. Runs entirely inside the invoking agent's worktree.
- **`/spec` (no args)** — conversational fallback. Extracts the most recent
  numbered plan printed in the conversation, persists it via `plan_write`
  into `plans/`, then continues through the same preview/publish pipeline so
  every plan ends up on disk with the same contract.

`spec_publish` stages generated specs under
`.orc-state/plan-staging/<plan_id>/` as its concurrency lock, then moves them
into the worktree's `backlog/` and writes `derived_task_refs` back into the
plan file. It does NOT touch `.orc-state/backlog.json` or git — the skill
commits the worktree and merges to main using the AGENTS.md cleanup ordering.
The coordinator's auto-sync tick picks up the new specs from main on its
next pass.

Hard failures (no overrides):

- `confirm !== true` on `spec_publish`
- plan already has non-empty `derived_task_refs` (regeneration is a future
  task — create a new plan instead)
- stale `.orc-state/plan-staging/<plan_id>/` directory already exists

---

## Inspection

Commands for digging into active runs and the event stream.

| Command | Description |
|---------|-------------|
| `runs-active` | List in-progress and claimed runs with idle/age metrics. |
| `run-info <run_id>` | Show claim state, task, worktree path, and idle time for a run. |
| `run-expire <run_id>` | Force-expire a claim and requeue the task. |
| `waiting-input` | List runs blocked waiting for master input. |
| `events-tail` | Print the last N events. |
| `events-filter` | Query events by run, agent, or event type. |

**Flags:**

| Command | Flags |
|---------|-------|
| `runs-active` | `[--json]` |
| `run-info` | `<run_id>` `[--json]` |
| `events-tail` | `[--n=<N>]` `[--event=<name>]` `[--json]` |
| `events-filter` | `[--run-id=<id>]` `[--agent-id=<id>]` `[--event=<type>]` `[--last=<N>]` `[--json]` |
| `waiting-input` | `[--json]` |

---

## Memory

The memory system stores persistent knowledge across sessions. Agents use
`memory-wake-up` and `memory-record` during task execution. These commands
are also available for manual inspection.

| Command | Description |
|---------|-------------|
| `memory-status` | Show store statistics: drawer count, wings, rooms, DB size. |
| `memory-search <query>` | Full-text search across memory drawers. |
| `memory-wake-up` | Recall essential memories for session context (agent use). |
| `memory-record` | Store a memory manually (agent use). |

**Flags:**

| Command | Flags |
|---------|-------|
| `memory-search` | `<query>` `[--wing=<wing>]` `[--room=<room>]` |
| `memory-wake-up` | `[--wing=<wing>]` `[--budget=<N>]` |
| `memory-record` | `--content=<text>` `[--wing=<wing>]` `[--hall=<category>]` `[--room=<topic>]` `[--importance=<N>]` |

---

## Run lifecycle

Worker agents call these commands from inside their PTY sessions to report
progress through the task lifecycle. Not for human use.

| Command | Description |
|---------|-------------|
| `report-for-duty` | Worker announces session is ready after bootstrap. |
| `run-start` | Acknowledge task start; transitions claim to `in_progress`. |
| `run-work-complete` | Signal implementation, review, and rebase are done. |
| `run-finish` | Terminal success. Ends the run. |
| `run-fail` | Terminal failure. Requeues or blocks the task. |
| `progress` | Emit a phase lifecycle event (phase_started, phase_finished). |
| `run-input-request` | Worker asks the master a blocking question. |
| `run-input-respond` | Master answers a worker's pending input request. |

**Flags:**

| Command | Flags |
|---------|-------|
| `report-for-duty` | `--agent-id=<id>` `--session-token=<token>` |
| `run-start` | `--run-id=<id>` `--agent-id=<id>` |
| `run-work-complete` | `--run-id=<id>` `--agent-id=<id>` |
| `run-finish` | `--run-id=<id>` `--agent-id=<id>` |
| `run-fail` | `--run-id=<id>` `--agent-id=<id>` `[--reason=<text>]` `[--code=<code>]` `[--policy=requeue\|block]` |
| `progress` | `--event=<type>` `--run-id=<id>` `--agent-id=<id>` `[--phase=<name>]` `[--reason=<text>]` |
| `run-input-request` | `--run-id=<id>` `--agent-id=<id>` `--question=<text>` `[--timeout-ms=<ms>]` |
| `run-input-respond` | `--run-id=<id>` `--agent-id=<id>` `--response=<text>` `[--actor-id=<id>]` |

---

## Review

Sub-agent reviewers use these to submit findings. The worker that spawns
them uses `review-read` to collect results. Not for human use.

| Command | Description |
|---------|-------------|
| `review-submit` | Submit review outcome (approved or findings) for a run. |
| `review-read` | Retrieve all submitted review findings for a run. |

**Flags:**

| Command | Flags |
|---------|-------|
| `review-submit` | `--run-id=<id>` `--agent-id=<id>` `--outcome=approved\|findings` `--reason=<text>` |
| `review-read` | `--run-id=<id>` `[--json]` |

---

## Pull Request

Commands for interacting with pull requests. Used by PR reviewer workers —
not for direct human use. Require `pr_provider` in config.

| Command | Description |
|---------|-------------|
| `pr-diff <pr_ref>` | Print PR diff to stdout. |
| `pr-review <pr_ref>` | Submit PR review (approve or request changes). |
| `pr-merge <pr_ref>` | Merge the PR. |
| `pr-status <pr_ref>` | Show PR status and CI state. |

**Flags:**

| Command | Flags |
|---------|-------|
| `pr-diff` | `<pr_ref>` |
| `pr-review` | `<pr_ref>` `--approve\|--request-changes` `[--body=<text>]` |
| `pr-merge` | `<pr_ref>` |
| `pr-status` | `<pr_ref>` |

---

## MCP server

Starts the Model Context Protocol server for tool-based orchestrator access.
Used internally by agent integrations.

| Command | Description |
|---------|-------------|
| `mcp-server` | Start the MCP server. |

---

## Skills

The `orc install-skills` command installs provider-agnostic skill definitions
into `.claude/skills/` or `.codex/skills/`. The packaged skills include:

| Skill | Purpose |
|-------|---------|
| `create-task` | Create a single backlog task spec file. |
| `plan` | Interactive plan authoring. Normalizes a user request into a candidate feature slug and title, asks only the high-value follow-ups needed to remove ambiguity, and persists a validated plan artifact under `plans/<plan_id>-<slug>.md` via the `plan_write` MCP tool. Run in a fresh worktree; commit and merge to main follow the standard worker worktree workflow. |
| `spec` | Convert a saved plan artifact (`plans/<plan_id>-*.md`, preferred) or a conversational plan (fallback) into a full batch of registered backlog task specs. Invoked as `/spec plan <id>` or `/spec`. |
| `orc-commands` | Inline reference for orc CLI subcommands. |
| `worker-inspect` | Inspect worker state via MCP orchestrator tools. |

The `spec` skill delegates structural decisions to a pure engine at
[`lib/planToBacklog.ts`](../lib/planToBacklog.ts) (authoritative source of the
`PlanInput` and `ProposedTask` types). Given a parsed plan input, the engine
returns a list of proposed backlog tasks with inferred dependencies and
grouped steps. Each `ProposedTask` carries a title, a `<N>-<kebab-title>`
slug, a `<feature>/<slug>` ref, a description, an intra-batch `dependsOn`
ref list, a `reviewLevel` matching the enum consumed by
`lib/backlogSync.ts`, the merged plan step numbers, and a `feature` stamp
copied from the plan's `name` field.

### `/plan` lifecycle verb

`/plan` is an agent-agnostic interactive workflow that produces a plan
artifact any later caller can pick up via `/spec plan <id>`. Invoke from a
fresh worktree:

1. The skill normalizes the request into a candidate kebab-case `name` and
   human-readable `title`.
2. It checks `.orc-state/backlog.json` for feature-slug collisions. If the
   derived slug matches an unrelated feature, the skill prompts the invoker
   to disambiguate (new slug or cancel). Same-feature re-use is accepted
   explicitly.
3. It asks only the high-value follow-ups needed to fill every required
   section (`Objective`, `Scope`, `Out of Scope`, `Constraints`,
   `Affected Areas`, `Implementation Steps`).
4. Once every section is concrete, it calls the `plan_write` MCP tool,
   which allocates the next `plan_id` atomically via `nextPlanId()`,
   validates the rendered artifact through `parsePlan` (round-trip), and
   writes `plans/<plan_id>-<slug>.md` inside the current worktree. The
   tool does not touch `.orc-state/backlog.json`, main, or git.
5. The skill commits the new plan file in the worktree and merges to main
   following the worker worktree workflow in AGENTS.md.

The `plan_write` MCP tool accepts the fields listed in the `/plan` skill:
`name`, `title`, `objective`, `scope`, `out_of_scope`, `constraints`,
`affected_areas`, `steps: [{ title, body, depends_on? }]`, and the optional
`acknowledge_feature_collision: boolean` flag used by the skill to accept a
same-feature collision after confirming with the user. The tool returns
`{ planId, path }` on success.
