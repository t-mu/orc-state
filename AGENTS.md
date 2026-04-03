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

Your assigned worktree path is in the TASK_START payload (`assigned_worktree`). After calling `orc run-start`, `cd` into that path. Do not create a second worktree unless the task payload explicitly tells you to recover a missing one. Run all builds, tests, and edits from inside the assigned `.worktrees/<run_id>`.

### Worktree cleanup ordering

When merging and cleaning up a worktree, **always delete the branch before removing the worktree**. Removing the worktree destroys the shell's working directory, which makes all subsequent Bash commands fail. The correct order is:

```bash
# 1. Merge from the main checkout (not from inside the worktree)
git -C <main-repo> merge <branch> --no-ff -m "task(<ref>): merge worktree"
# 2. Delete the branch WHILE the worktree directory still exists
git branch -D <branch>
# 3. Remove the worktree LAST — this invalidates the cwd
git worktree remove <worktree-path>
```

## Phased Workflow

Every task MUST follow these five phases in order. Each phase has a gate —
a command that MUST exit 0 before you proceed to the next phase.
Do NOT skip phases. Do NOT reorder phases.

### Phase 1 — Explore

Signal phase: `orc progress --event=phase_started --phase=explore --run-id=<run_id> --agent-id=<agent_id>`
Read the full task spec in `backlog/<N>-<slug>.md`. Identify all affected files.
Check existing patterns in those files before writing any code.

**Gate:** Run `orc run-start --run-id=<run_id> --agent-id=<agent_id>`.
Start the background heartbeat immediately after:
```bash
while true; do sleep 60; orc run-heartbeat --run-id=<run_id> --agent-id=<agent_id>; done &
HEARTBEAT_PID=$!
```
Do NOT write code until run-start succeeds.

### Phase 2 — Implement

Signal phase: `orc progress --event=phase_started --phase=implement --run-id=<run_id> --agent-id=<agent_id>`
Write code changes. Write tests for all new logic. Run `npm test`.

**Gate:** `npm test` MUST exit 0. Do NOT proceed to Phase 3 with failing tests.

### Phase 3 — Review

Signal phase: `orc progress --event=phase_started --phase=review --run-id=<run_id> --agent-id=<agent_id>`
1. Commit your changes: `git commit -m "feat(<scope>): <outcome>"`
2. Emit a heartbeat before spawning sub-agents:
   `orc run-heartbeat --run-id=<run_id> --agent-id=<agent_id>`
3. Spawn two independent sub-agent reviewers. Give each:
   - the acceptance criteria from the task spec
   - the full diff: `git diff --stat --patch main...HEAD` (not just file names)
   - their run_id, agent_id, and reviewer number
   IMPORTANT: instruct each reviewer to call before returning:
   ```bash
   orc review-submit --run-id=<run_id> --agent-id=<their_agent_id> \
     --outcome=<approved|findings> --reason="<findings text>"
   ```
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
4. Retrieve findings: `orc review-read --run-id=<run_id>`
   If a reviewer failed or is non-responsive, proceed with the reviews
   that were submitted. `orc review-read` exits 0 regardless of count.
   When reading reviewer output from an output file, grep for
   `REVIEW_FINDINGS_END` — if absent, the reviewer did not finish and
   should be treated as non-responsive.
5. Retry for missing structured output (conversational reviewers only): for each
   reviewer that submitted via `review-submit` but whose text output lacks
   `REVIEW_FINDINGS_END`, and whose conversation context is still active, send one
   follow-up message: "Your review-submit was received but the structured
   REVIEW_FINDINGS block is missing from your output. Emit only the block now."
   PTY-based reviewers cannot receive follow-up messages — treat them as
   non-responsive immediately. If retry fails, treat as non-responsive.
6. Address ALL findings in a fixup commit.

**Gate:** Parse `orc review-read` output — all submitted reviewers report `approved`.
`orc review-read` always exits 0; you MUST inspect the output for outcomes.
One review round only.

### Phase 4 — Complete

Signal phase: `orc progress --event=phase_started --phase=complete --run-id=<run_id> --agent-id=<agent_id>`
1. Mark the task done (updates spec + state in one action):
   `orc task-mark-done <task-ref>`
2. Rebase onto main: `git rebase main`
   If conflicts arise: resolve each conflicted file, then `git add <file> && git rebase --continue`.
   Only call `orc run-fail` if a conflict is genuinely unresolvable.
3. Signal the coordinator:
   `orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>`

**Gate:** `run-work-complete` MUST exit 0. It rejects if task-mark-done was not called.
Do NOT call run-work-complete without calling task-mark-done first.

### Phase 5 — Finalize

Signal phase: `orc progress --event=phase_started --phase=finalize --run-id=<run_id> --agent-id=<agent_id>`
Wait for coordinator follow-up. If coordinator requests a finalize rebase:
1. Emit `orc progress --event=finalize_rebase_started --run-id=<run_id> --agent-id=<agent_id>`
2. Perform the rebase.
3. Emit `orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>` again.

When coordinator confirms success, stop heartbeat and signal finish:
```bash
kill $HEARTBEAT_PID 2>/dev/null || true
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
2. Task authoring: edit `backlog/<N>-<slug>.md`
3. Task registration/sync: create/update runtime state to match markdown, then run `orc backlog-sync-check`
4. Task completion: `orc task-mark-done <task-ref>` (updates spec + state in one action)
5. Worker lifecycle: `run-start` -> `run-heartbeat` -> `run-work-complete` -> `run-finish`
6. Normal inspection: `orc status`, `orc doctor`, `orc backlog-sync-check`

Outside the blessed workflow, commands are for observability, setup, or recovery only — not the default path.

### Orchestrator

```bash
# Blessed status / health
orc status                                        # print agent/task/claim table
orc doctor                                        # validate state files, check provider keys/binaries
orc preflight                                     # lightweight environment health check

# Supported inspection
orc watch                                         # live-refresh status
orc events-tail                                   # tail the event stream
orc runs-active                                   # list in-progress/claimed runs

# Session management
orc start-session                                 # start coordinator + master session (requires TTY)
orc kill-all                                      # ⚠️ stop coordinator + clear ALL agents; use only to fully reset

# Task management
orc task-create                                   # register a task that already has a matching markdown spec
orc task-mark-done <task-ref>                     # mark done: updates spec frontmatter + syncs state
orc task-reset <task-ref>                         # reset a task to todo, cancelling any active claims
orc task-unblock <task-ref>                       # transition a blocked task back to todo
orc delegate                                      # assign/dispatch a task to an agent

# Worker management — recovery/debug only
orc register-worker <id> --provider=claude        # register a new worker agent
orc start-worker-session <id> --provider=claude   # launch headless PTY session + bootstrap
orc attach <id>                                   # print tail of worker PTY output log (read-only)
orc control-worker <id>                           # inspect a running worker session
orc deregister <id>                               # remove a specific agent registration
orc worker-remove <id>                            # stop session + deregister a worker
orc worker-gc                                     # mark stale workers offline
orc worker-clearall                               # remove all offline/stale workers
```

### Run Lifecycle (Worker Commands — blessed path)

Workers emit these from inside their PTY session via Bash tool:

```bash
orc run-start --run-id=<id> --agent-id=<id>                        # required first — acknowledge task start
orc run-heartbeat --run-id=<id> --agent-id=<id>                    # REQUIRED — extend lease every 5 min across ALL phases
orc run-work-complete --run-id=<id> --agent-id=<id>                # signal impl+review+rebase done; wait for coordinator
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
```

---

## Orchestrator Conventions

### State files (never write directly)
| File | Contents |
|------|----------|
| `.orc-state/backlog.json` | Backlog features and tasks |
| `.orc-state/agents.json` | Registered agents |
| `.orc-state/claims.json` | Active and recent claims |
| `.orc-state/events.db` | SQLite event store |

### Write rules
**For agents:** use `orc` CLI commands or MCP tools for all state changes. Never call `withLock`, `atomicWriteJson`, or other internal library functions directly — those are for code authors implementing new handlers, not for agents operating the system.

Normal task-authoring path:
- edit the markdown spec first
- register or sync the runtime task record second
- run `orc backlog-sync-check`

Do not treat generic runtime mutation as a substitute for backlog markdown edits.

### Task lifecycle
```
todo → claimed → in_progress → done → released
                     ↓
                  blocked
```
A task is eligible to claim when `status == "todo"` and all `depends_on` refs are `done`/`released`.

| Transition | Who sets it |
|------------|-------------|
| `todo → claimed` | Coordinator (on delegate) |
| `claimed → in_progress` | Worker (`orc run-start`) |
| `in_progress → done` | Worker (`orc task-mark-done <ref>`) |
| `done → released` | Coordinator (after merge) |
| `any → blocked` | Worker (`orc run-fail --policy=block`) |
| `blocked/claimed/in_progress → todo` | Operator (`orc task-reset <ref>`) |

### Heartbeat requirement

The claim lease is 30 minutes; failure to heartbeat will cause the coordinator to expire
and requeue the task.

**Primary mechanism — background heartbeat loop:**

Immediately after `orc run-start`, start a background shell process that fires
`orc run-heartbeat` every 60 seconds (1 min). This keeps the lease alive even while
the worker is blocked inside a long-running Bash tool call (e.g. `npm test`, `git rebase`).

```bash
# Start background heartbeat — immediately after orc run-start
while true; do sleep 60; orc run-heartbeat --run-id=<run_id> --agent-id=<agent_id>; done &
HEARTBEAT_PID=$!
```

Before emitting `orc run-finish` or `orc run-fail`, kill the background process:

```bash
# Stop background heartbeat
kill $HEARTBEAT_PID 2>/dev/null || true
```

**Fallback — manual call sites** (if the background process unexpectedly dies):
- Before spawning sub-agent reviewers
- Immediately before `git rebase main`
- Immediately before `orc run-work-complete`
- Every 5 minutes while waiting for coordinator follow-up after `run-work-complete`

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
- The master reads output via `orc attach <scout-id>`

### What scouts must NOT do

- Edit files or write state
- Run git commands that mutate history or working tree
- Call state-mutating `orc` commands or claim tasks

### Scout lifecycle (master perspective)

Scout IDs are assigned sequentially (`scout-1`, `scout-2`, …). The assigned ID is returned in the `request_scout` response — capture it.

```
result = request_scout(objective, ...)   ← capture result.agent_id
                               → scout-N spawned and briefed
                               → scout investigates (read-only PTY session)
                               → scout outputs SCOUT_REPORT block

# poll loop — orc attach is one-shot (prints log tail, then exits):
for i in $(seq 1 30); do
  orc attach <result.agent_id> 2>/dev/null | grep -q "SCOUT_REPORT_END" && break
  [ "$i" -eq 30 ] && { orc worker-remove <result.agent_id>; break; }  # timed out
  sleep 10
done

read: extract SCOUT_REPORT…SCOUT_REPORT_END block from: orc attach <result.agent_id>
cleanup: orc worker-remove <result.agent_id>
```

To check how long a scout has been running: `get_agent_workview(<agent_id>)` returns a `launched_at` timestamp.

Scouts do not heartbeat and are not coordinated by the run lifecycle. They are ephemeral — clean up with `orc worker-remove <scout-id>` once the report is read.

### Scout lifecycle (scout perspective)

You are launched with a `SCOUT_BOOTSTRAP` block followed by a `SCOUT_BRIEF` block. The brief contains your objective, `working_directory`, and optional `scope_paths`. Start from `working_directory`. Investigate `scope_paths` first; expand beyond them only if exhausted. Output a `SCOUT_REPORT` block when done (format defined in the bootstrap and repeated in the brief). Do not wait for further instructions after outputting the report.

---

## Task Execution Workflow

Follow the **Phased Workflow** above. The five phases are:
1. **Explore** — read spec, identify files (gate: `orc run-start`)
2. **Implement** — code + tests (gate: `npm test`)
3. **Review** — commit, sub-agent review, fix findings (gate: reviewers accept)
4. **Complete** — `orc task-mark-done`, rebase, `orc run-work-complete` (gate: run-work-complete exits 0)
5. **Finalize** — coordinator follow-up, `orc run-finish` (gate: terminal success)

New task specs follow `backlog/TASK_TEMPLATE.md`.

### Task Creation Completion Gate
- When creating or updating backlog task specs, the work is not complete after writing the markdown spec.
- Completion requires both:
  - the markdown spec saved under the backlog directory
  - the matching task created or updated in orchestrator state
- After task creation or update work, run `orc backlog-sync-check`.
- Do not report success unless the sync check passes, or you explicitly report which refs failed to sync.

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
