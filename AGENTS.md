# Orchestrator — Agent Guide

This file is the single authoritative reference for any coding agent (Codex, Claude, Gemini)
working in this repository. Read it before touching any file.

---

## Project Overview

A provider-agnostic, file-state multi-agent orchestration runtime for autonomous coding agents.
The coordinator dispatches backlog tasks to headless PTY worker sessions, manages their
lifecycle, and surfaces status to the foreground master agent.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Language | TypeScript (`.ts`) — Node 24 native type stripping, no build step |
| Tests | Vitest |
| Runtime | Node.js 24 (pinned in `.nvmrc`) |

---

## Environment

```bash
nvm use 24        # activate correct Node version
npm install       # install dependencies
npm test          # run full test suite
```

Never use version range matchers (`~`, `^`) in `package.json` — always exact pinned versions.

---

## Worktree Workflow

Every task must be executed in a dedicated git worktree. Never make changes
directly on the main checkout while a run is active.

Worktree lifecycle commands are pre-authorized — do not stop to ask for permission before running: `git worktree add`, `git worktree remove`, `git branch -d`, `git commit`, `git rebase main`, and `git -C ../.. merge ... --no-ff`.

Your assigned worktree path is in the TASK_START payload (`assigned_worktree`). Worker sessions start with that path as their working directory; confirm with `pwd`. Do not create a second worktree unless the task payload explicitly tells you to recover a missing one. Run all builds, tests, and edits from inside the assigned worktree (`<state>/worktrees/<run_id>` in the project state directory).

### Worktree cleanup ordering (direct mode)

This ordering applies to direct mode only. In PR mode the coordinator delegates
merge and cleanup to the PR reviewer worker.

When merging and cleaning up a worktree, run every command from the main
checkout with `git -C <main-repo>`, and **remove the worktree before deleting
the branch**. Git refuses to delete a branch that is still checked out in a
worktree, and removing the worktree invalidates a shell whose cwd is inside it,
so a relative `git` command issued afterwards from that shell fails. The
correct order is:

```bash
# 1. Merge from the main checkout (not from inside the worktree)
git -C <main-repo> merge <branch> --no-ff -m "task(<ref>): merge worktree"
# 2. Remove the worktree — the branch is no longer checked out anywhere
git -C <main-repo> worktree remove <worktree-path>
# 3. Delete the merged branch
git -C <main-repo> branch -d <branch>
```

## Phased Workflow

Every task MUST follow these five phases in order. Each phase has a gate —
a command that MUST exit 0 before you proceed to the next phase.
Do NOT skip phases. Do NOT reorder phases.

### Phase 1 — Explore

Signal phase: `orc progress --event=phase_started --phase=explore --run-id=<run_id> --agent-id=<agent_id>`
Read the full task spec at `task_spec_path` from TASK_START (the pinned task revision). Identify all affected files.
Check existing patterns in those files before writing any code.

**Gate:** Run `orc run-start --run-id=<run_id> --agent-id=<agent_id>`.
Do NOT write code until run-start succeeds.

### Phase 2 — Implement

Signal phase: `orc progress --event=phase_started --phase=implement --run-id=<run_id> --agent-id=<agent_id>`
Write code changes. Write tests for all new logic. Run `npm test`.

**Gate:** `npm test` MUST exit 0. Do NOT proceed to Phase 3 with failing tests.

### Phase 3 — Review

Signal phase: `orc progress --event=phase_started --phase=review --run-id=<run_id> --agent-id=<agent_id>`
1. Commit your changes: `git commit -m "feat(<scope>): <outcome>"`
2. Spawn two independent sub-agent reviewers. Give each:
   - the acceptance criteria from the task spec
   - the full diff: `git diff --stat --patch main...HEAD` (not just file names)
   - their run_id, the **worker's** agent_id (the claim owner, not a
     made-up reviewer name), and reviewer number
   IMPORTANT: instruct each reviewer to call before returning:
   ```bash
   orc review-submit --run-id=<run_id> --agent-id=<agent_id> \
     --outcome=<approved|findings> --reason="<findings text>"
   ```
   `--agent-id` MUST be the worker's own agent_id (e.g. `broken-nose`), NOT a
   reviewer label like `reviewer-1`. The coordinator uses this field to
   match events to claims — a mismatched agent_id blocks event processing.
   Findings written this way survive context compaction.
   Instruct all reviewers — built-in (critic, integrator) or general-purpose
   — to wrap their entire output in this block (format must be last in
   constraints, immediately before END marker, for recency bias):
   ```
   REVIEW_FINDINGS
   verdict: approved | findings

   <one finding per issue, or "No issues found.">
   REVIEW_FINDINGS_END
   ```
   No text outside the block. This format is grep-able and survives context
   compaction regardless of reviewer type.
   Reviewers are instructed to review the inlined diff only — not to explore
   the codebase independently.
3. Retrieve findings: `orc review-read --run-id=<run_id>`
   If a reviewer failed or is non-responsive, proceed with the reviews
   that were submitted. `orc review-read` exits 0 whatever the reviews say;
   a non-zero exit means the reviews could not be read — retry it shortly.
   When reading reviewer output from an output file, grep for
   `REVIEW_FINDINGS_END` — if absent, the reviewer did not finish and
   should be treated as non-responsive.
4. Retry for missing structured output (conversational reviewers only): for each
   reviewer that submitted via `review-submit` but whose text output lacks
   `REVIEW_FINDINGS_END`, and whose conversation context is still active, send one
   follow-up message: "Your review-submit was received but the structured
   REVIEW_FINDINGS block is missing from your output. Emit only the block now."
   PTY-based reviewers cannot receive follow-up messages — treat them as
   non-responsive immediately. If retry fails, treat as non-responsive.
5. Address ALL findings in a fixup commit.

**Gate:** Parse `orc review-read` output — all submitted reviewers report `approved`.
`orc review-read` exits 0 whatever the reviews say; you MUST inspect the output for outcomes
(a non-zero exit means they could not be read — retry, never treat it as "no reviews").
One review round only.

### Phase 4 — Complete

Signal phase: `orc progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=<agent_id>`
1. Do NOT edit any task spec's `status:` field. Task status is runtime-owned:
   the coordinator records `done` after merge. Commit only the changes the task
   asks for, never orchestration state.
2. Rebase onto main (direct mode only): `git rebase main`
   In PR mode, skip the rebase — the PR reviewer handles rebasing.
   If conflicts arise: resolve each conflicted file, then `git add <file> && git rebase --continue`.
   Only call `orc run-fail` if a conflict is genuinely unresolvable.
3. Verify `npm test` passes, then signal the coordinator:
   `orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>`

**Gate:** `run-work-complete` MUST exit 0.
Do NOT call `orc task-mark-done` from the worker session; the coordinator marks shared runtime state done after merge.

There is no task spec file in the repository: the spec is a project task
revision. Legacy `.orc-state` installations (attached or sibling) no longer
run; `orc project migrate` moves one into a registered project.

### Phase 5 — Finalize

Signal phase: `orc progress --event=phase_started --phase=finalize --run-id=<run_id> --agent-id=<agent_id>`

**Direct mode:** Wait for coordinator follow-up. If coordinator requests a finalize rebase:
1. Emit `orc progress --event=finalize_rebase_started --run-id=<run_id> --agent-id=<agent_id>`
2. Perform the rebase.
3. Emit `orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>` again.

**PR mode:** After `run-work-complete`, remain in your session and wait for a `PR_REVIEW` message
from the coordinator. When it arrives, extract `pr_ref`, `run_id`, `review_level`, `acceptance_criteria`,
`assigned_worktree`, and `orc_bin` from the block, then:
1. Rebase onto origin/main: `git fetch origin main && git rebase origin/main` (resolve conflicts iteratively).
2. Review-fix loop (max 3 iterations): generate diff, spawn sub-agents per `review_level`, collect findings
   via `orc review-read --run-id=<run_id>`, fix findings in a commit, repeat. If >3 iterations: `orc run-fail --policy=requeue`.
3. Pre-push rebase: `git fetch origin main && git rebase origin/main`, then `npm test`.
4. CI loop (max 3 iterations): `git push --force-with-lease`, then `orc pr-status <pr_ref> --wait`.
   If CI fails: diagnose, fix, commit, rebase, push again. If >3 CI failures: `orc run-fail --policy=requeue`.
5. Signal ready: `orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>`.
   The coordinator merges the PR. When it sends a finalize-success signal: `orc run-finish`.

When coordinator confirms success, signal finish:
```bash
orc run-finish --run-id=<run_id> --agent-id=<agent_id>
```

If no coordinator follow-up arrives, only emit `orc run-finish` after the
`run-work-complete` handoff has already been recorded.

**Gate:** `orc run-finish` — terminal success signal. Do NOT merge to main yourself.
Do NOT clean up the worktree or branch yourself.

---

## Commands

## Blessed Paths

Use these as the default workflow. Treat everything else as recovery/debug unless the task explicitly requires it.

1. Session startup: `orc start-session`
2. Task authoring: `orc project task create|edit|import` (or the MCP `create_task`/`update_task` tools) — no file in the repository.
3. Task registration: a project's tasks live in its SQLite store (`runtime.db`); status is never read from or written to a spec.
4. Worker dispatch: automatic — on each tick the coordinator spawns a task-scoped worker when capacity is available. Workers are assigned a random orc-themed two-word name (e.g., `broken-nose`, `slithering-arrow`), unique among currently-active workers. The provider is resolved from the task's `required_provider` field or the configured default.
5. Task completion: the coordinator marks the task done itself after merge; task status is runtime-owned and no spec is edited (`orc task-mark-done` is the operator's recovery command)
6. Worker lifecycle: `run-start` -> `run-work-complete` -> `run-finish`
7. Normal inspection: `orc status`, `orc doctor`
8. Memory (worker): `orc memory-wake-up` (session start), `orc memory-record --content="..."` (store a memory)

Outside the blessed workflow, commands are for observability, setup, or recovery only — not the default path.

### Orchestrator

```bash
# Any command: --project=<id> selects a registered project (highest precedence)

# Blessed status / health
orc status                                        # print agent/task/claim table
orc doctor                                        # validate state files, check provider keys/binaries
orc preflight                                     # lightweight environment health check

# Supported inspection
orc watch                                         # live-refresh status
orc events-tail                                   # tail the event stream
orc runs-active                                   # list in-progress/claimed runs
orc sessions [--all] [--json]                     # list supervised sessions (running/recoverable/unknown) with reason
orc memory-status                                 # memory store stats
orc memory-search <query> [--wing=X] [--room=Y]  # search memories (FTS5)

# Session management
orc start-session                                 # start coordinator + master session (requires TTY)
orc kill-all                                      # ⚠️ stop coordinator + clear ALL agents; use only to fully reset

# Task management
orc task-mark-done <task-ref>                     # operator recovery: mark runtime state done (the coordinator does this itself after merge)
orc task-reset <task-ref>                         # reset a task to todo, cancelling any active claims
orc task-unblock <task-ref>                       # transition a blocked task back to todo
orc task-cancel <task-ref>                        # cancel a task that is not yet terminal (operator; the master uses cancel_task)
orc delegate                                      # assign/dispatch a task to an agent

# Worker management — recovery/debug only
orc attach <id>                                   # print tail of worker PTY output log (read-only)
orc control-worker <id>                           # inspect a running worker session
orc worker-remove <id>                            # stop a worker's session and remove it (refused while it holds a claim)
orc worker-gc                                     # remove offline, dead and unreachable workers that hold no claim
```

### Run Lifecycle (Worker Commands — blessed path)

Workers emit these from inside their PTY session via Bash tool:

```bash
orc run-start --run-id=<id> --agent-id=<id>                        # required first — acknowledge task start
orc run-work-complete --run-id=<id> --agent-id=<id>                # signal implementation and review done; wait for coordinator
orc run-finish --run-id=<id> --agent-id=<id>                       # terminal success (after work-complete)
orc run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] \
  [--policy=requeue|block]                                          # terminal failure; default policy=requeue

# Generic lifecycle event (phase tracking, optional / secondary path)
orc progress --event=<type> --run-id=<id> --agent-id=<id> \
  [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]    # emit phase_started, phase_finished, etc.

# Input request (worker → master)
orc run-input-request --run-id=<id> --agent-id=<id> \
  --question=<text> [--timeout-ms=<ms>]                            # worker asks master a question; blocks until answered

# Input response (master → worker — master use only)
orc run-input-respond --run-id=<id> --agent-id=<id> \
  --response=<text> [--actor-id=<id>]                              # master answers a worker's input request

# Memory (worker)
orc memory-wake-up [--wing=X] [--budget=N]                        # recall essential memories at session start
orc memory-record --content="..." [--wing=X] [--hall=Y] \
  [--room=Z] [--importance=N]                                      # store a memory
```

---

## Orchestrator Conventions

### State files (never write directly)
State lives outside the repository, in the project state directory
`<data-home>/projects/<project_id>/` (see `docs/configuration.md`).

| File | Contents |
|------|----------|
| `runtime.db` | SQLite task store: task revisions, status, transitions, runs, plans |
| `backlog.json` | Read-only projection of the project's tasks |
| `agents.json` | Registered agents |
| `claims.json` | Active and recent claims |
| `events.db` | SQLite event store |
| `memory.db` | SQLite memory store (drawers, FTS5 index) |

### Write rules
**For agents:** use `orc` CLI commands or MCP tools for all state changes. Never call `withLock`, `atomicWriteJson`, or other internal library functions directly — those are for code authors implementing new handlers, not for agents operating the system.

Normal task-authoring path:
- `orc project task create|edit|import` or the MCP `create_task`/`update_task` tools; no `backlog/` file is written anywhere.
- Task status is runtime-owned: change it only through lifecycle commands, never through a spec's `status:`.

### Tasks and plans

A project keeps its tasks and plans in its SQLite store; Markdown is imported
or exported explicitly with `orc project task|plan import|export`. The plan
Markdown format (required frontmatter, sections, the `Depends on: N[, N...]`
cue) is documented in `docs/cli.md` → **Plans**; the parser lives in
`lib/planDocs.ts`.

### Execution Modes

Each agent role (master, worker) can run in one of two execution mode presets:

| Preset | Behaviour |
|--------|-----------|
| `full-access` | No sandbox — agent has full filesystem and network access. Default. |
| `sandbox` | Agent is confined to the workspace; unsandboxed shell commands are disallowed. |

Configure via `default_execution_mode`, `master.execution_mode`, or `worker_pool.execution_mode` in the project settings (`orc project config set`), or override at runtime with `ORC_MASTER_EXECUTION_MODE` / `ORC_WORKER_EXECUTION_MODE` env vars. Scouts are launched with `read_only: true`, which tightens permissions in `sandbox` mode; in `full-access` mode they receive the same flags as regular workers. Sandboxed Codex workers and Claude workers on Linux reach the coordinator only with the opt-in `worker_pool.sandbox_network: open` (`ORC_WORKER_SANDBOX_NETWORK`), which widens their network access; Claude scouts on Linux follow the same setting, which lets them reach every Unix socket.

See `docs/configuration.md` → **Execution Modes** for full details including per-provider CLI flags and Linux prerequisites.

### Task lifecycle
```
todo → claimed → in_progress → done → released
                     ↓
                  blocked
(todo/claimed/in_progress/blocked → cancelled)
```
A task is eligible to claim when `status == "todo"` and all `depends_on` refs are `done`/`released`.

| Transition | Who sets it |
|------------|-------------|
| `todo → claimed` | Coordinator (on delegate) |
| `claimed → in_progress` | Worker (`orc run-start`) |
| `in_progress → done` | Coordinator, after merge (`orc task-mark-done <ref>` is the operator's recovery command) |
| `done → released` | Coordinator (after merge) |
| `claimed/in_progress → blocked` | Worker (`orc run-fail --policy=block`) |
| `todo/claimed/in_progress/blocked → cancelled` | Master (`cancel_task`) or operator (`orc task-cancel <ref>`) |
| `blocked → todo` | Operator (`orc task-unblock <ref>`) or master (`unblock_task`) |
| any non-`todo` status `→ todo` | Operator (`orc task-reset <ref>`), including a completed or cancelled task |

### Worker liveness

Liveness is determined by the coordinator probing the worker's session: for
`tmux:` sessions it asks the private tmux server for the pane process; for
`pty:` sessions it checks the PTY PID (with its recorded start time, so a
reused PID is not mistaken for the worker). If the process is dead, the
coordinator clears the agent session, expires the claim, and requeues the task.
Lease renewal is automatic — the coordinator extends the lease whenever phase
events are processed. A coordinator restart does not kill workers: tmux
sessions are adopted, and sessions it cannot write to are marked
`recoverable` (see `orc sessions` and `docs/recovery.md`). Structured-runtime
(`app:`) sessions are the exception: their stdio belongs to the coordinator
that launched them, so they end with it and the run is requeued (see
`docs/configuration.md` → **Worker Runtimes**).

---

## Scout Role

Scouts are **read-only investigation agents** launched on demand by the master via the `request_scout` MCP tool. They do not participate in the task backlog lifecycle.

### When to use a scout

Use `request_scout` when:
- A worker is stalled and the cause is unclear before you intervene
- The user asks for investigation or digging into code/logs/history
- You need reconnaissance before deciding what task to create or which worker to unblock

Do NOT use a scout for work you can answer inline in one or two tool calls.

### What scouts do

- Inspect code, logs, git history, runtime state, and optionally the web
- Return a structured `SCOUT_REPORT` block with findings, likely cause, and recommended next action
- The master reads the report with the `get_scout_report` MCP tool

### What scouts must NOT do

- Edit files or write state
- Run git commands that mutate history or working tree
- Call state-mutating `orc` commands or claim tasks

### Scout lifecycle (master perspective)

Scout IDs are assigned sequentially (`scout-1`, `scout-2`, …). The assigned ID is returned in the `request_scout` response — capture it.

```
result = request_scout(objective, ...)   ← capture result.agent_id
                               → scout-N spawned and briefed
                               → scout investigates (read-only session)
                               → scout outputs SCOUT_REPORT block

# poll get_scout_report about every 10 s, for up to ~5 minutes:
report = get_scout_report(result.agent_id)
  status "reported" → report.report holds the SCOUT_REPORT block
  status "truncated" → the report was too long to read back; ask a narrower question
  status "ended"    → the session ended without a report
  status "running"  → keep polling; after ~5 minutes treat the scout as failed

cleanup: remove_scout(result.agent_id)   ← always, once done or timed out
```

To check how long a scout has been running: `get_scout_report` returns its `launched_at` (registration) timestamp.

Scouts do not heartbeat and are not coordinated by the run lifecycle. They are ephemeral — clean up with `remove_scout(<scout-id>)` once the report is read.

### Scout lifecycle (scout perspective)

You are launched with a `SCOUT_BOOTSTRAP` block followed by a `SCOUT_BRIEF` block. The brief contains your objective, `working_directory`, and optional `scope_paths`. Start from `working_directory`. Investigate `scope_paths` first; expand beyond them only if exhausted. Output a `SCOUT_REPORT` block when done (format defined in the bootstrap and repeated in the brief). Do not wait for further instructions after outputting the report.

---

## Task Execution Workflow

Follow the **Phased Workflow** above. The five phases are:
1. **Explore** — read spec, identify files (gate: `orc run-start`)
2. **Implement** — code + tests (gate: `npm test`)
3. **Review** — commit, sub-agent review, fix findings (gate: reviewers accept)
4. **Complete** — rebase (direct mode) or skip rebase (PR mode), `orc run-work-complete` (gate: run-work-complete exits 0); never edit a spec's `status:`
5. **Finalize** — direct mode: coordinator follow-up + `orc run-finish`; PR mode: remain in session, handle PR_REVIEW, then run-work-complete + run-finish (gate: terminal success)

The body of a project task follows the sections in `docs/task-template.md`.

### Task Creation Completion
The turn is complete when `orc project task create` or `create_task` returns; no file is written.

---

## Commit Discipline

- One commit per task unit. Commit before starting the next task.
- If a task has subtasks, commit all subtasks together at the task boundary.
- Message format: `feat(<scope>): <outcome>` / `fix(<scope>): <outcome>` / `chore(<scope>): <outcome>`
- Never use `--no-verify` or skip pre-commit hooks.

---

## Verification Checklist

Before reporting any task complete:

- [ ] `npm test` — all tests pass
- [ ] New pure logic has tests
- [ ] `orc doctor` exits 0 after schema or state file changes
- [ ] No files modified outside the stated task scope
- [ ] Review every inline script and multi-step command chain you executed.
      Could any have been a single orc command? If yes, create a backlog task.
- [ ] Did AGENTS.md lack information that would have prevented a wrong assumption,
      an unnecessary question to the user, or repeated file reads to discover
      something? If yes, update AGENTS.md directly (small clarification) or
      create a backlog task (larger change).

---

## Interactive Prompt Rule

`orc run-input-request` is for genuine blockers only. Do NOT call it for:
- Tool permission prompts — local CLI/tool permission handling should resolve these automatically.
- Routine confirmation dialogs you can answer yourself.

Call `orc run-input-request` ONLY when blocked on:
- Ambiguous or missing spec requirements that block implementation.
- Merge conflicts that are genuinely unresolvable without human input.
- External dependencies that are unavailable (service down, credential missing).

```bash
orc run-input-request --run-id=<run_id> --agent-id=<agent_id> \
  --question="Blocked on <specific situation>. <What you need from master>."
```

That command waits for a matching `input_response` while keeping the run alive.
Only call `orc run-fail` if the blocker is truly unrecoverable even after master input.

---

## What to Avoid

- Adding npm dependencies without asking first.
- Calling internal library functions (`withLock`, `atomicWriteJson`, `appendSequencedEvent`) directly — use CLI commands or MCP tools instead.
- Writing inline Node.js scripts to manipulate state files — use `orc` CLI or MCP tools.
- Refactoring, renaming, or "improving" code beyond what the task requires.
- Adding features, abstractions, or error handling for hypothetical future cases.
- Leaving tests broken.
