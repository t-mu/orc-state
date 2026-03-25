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
| Language | TypeScript (`.ts`) — Node 24 `--experimental-strip-types`, no build step |
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

### Finish — after all acceptance criteria are met
```bash
# 0. Mark the task complete — two things required:
#    a. Edit the task spec file:
#       backlog/<N>-<slug>.md — change frontmatter: status: todo -> status: done
#    b. Update orchestrator state (backlog.json):
node --experimental-strip-types cli/task-mark-done.ts <task-ref>
#       do not use generic update_task() for status changes

# 1. Commit inside the worktree
git add -p
git commit -m "feat(<scope>): <outcome>"

# 2. Sub-agent review round
#    a. Emit a heartbeat before spawning sub-agents:
orc run-heartbeat --run-id=<run_id> --agent-id=<agent_id>
#    b. Spawn two independent sub-agents. Give each:
#       - the acceptance criteria
#       - the output of `git diff main`
#       - their run_id, agent_id, and reviewer number
#       IMPORTANT: instruct each reviewer to call before returning:
#         orc review-submit --run-id=<run_id> --agent-id=<their_agent_id> \
#           --outcome=<approved|findings> --reason="<findings text>"
#       Findings written this way survive context compaction.
#
#    c. After both sub-agents complete (or after a bounded wait), retrieve
#       findings from the event store — this works even after context compaction:
#         orc review-read --run-id=<run_id>
#       If a reviewer failed or is non-responsive, proceed with the reviews
#       that were submitted. orc review-read exits 0 regardless of count.
#
#    d. Consolidate findings from the review-read output.
#    e. Address all findings, then amend or add a fixup commit.
#    This review round happens once.

# 3. Rebase onto latest main — resolve any conflicts before proceeding
git rebase main
# If conflicts arise: resolve each conflicted file, then:
#   git add <resolved-file> && git rebase --continue
# Only call orc run-fail if a conflict is genuinely unresolvable.

# 4. Report implementation complete before any terminal success signal
orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>

# 5. Remain alive in the same worktree for coordinator follow-up when it exists
#    - If coordinator requests a finalize rebase, do it here, then emit
#      `orc progress --event=finalize_rebase_started ...`, complete the rebase,
#      then emit `orc run-work-complete` again.
#    - If coordinator confirms finalization success, stop the background heartbeat
#      and emit orc run-finish:
kill $HEARTBEAT_PID 2>/dev/null || true
orc run-finish --run-id=<run_id> --agent-id=<agent_id>
#    - If no follow-up arrives, only emit orc run-finish after the
#      run-work-complete handoff has already been recorded.
#    - Do not merge to main or clean up the worktree/branch yourself.
```

---

## Commands

## Blessed Paths

Use these as the default workflow. Treat everything else as recovery/debug unless the task explicitly requires it.

1. Session startup: `orc start-session`
2. Task authoring: edit `backlog/<N>-<slug>.md`
3. Task registration/sync: create/update runtime state to match markdown, then run `orc backlog-sync-check`
4. Task completion: `orc task-mark-done <task-ref>`
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
orc events-tail                                   # tail the events.jsonl log
orc runs-active                                   # list in-progress/claimed runs
orc master-check                                  # check pending master notifications

# Session management
orc start-session                                 # start coordinator + master session (requires TTY)
orc kill-all                                      # ⚠️ stop coordinator + clear ALL agents; use only to fully reset

# Task management
orc task-create                                   # register a task that already has a matching markdown spec
orc task-mark-done <task-ref>                     # mark a task done in orchestrator state
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
| `.orc-state/events.jsonl` | Append-only event log (NDJSON) |

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
`orc run-heartbeat` every 270 seconds (4.5 min). This keeps the lease alive even while
the worker is blocked inside a long-running Bash tool call (e.g. `npm test`, `git rebase`).

```bash
# Start background heartbeat — immediately after orc run-start
while true; do sleep 270; orc run-heartbeat --run-id=<run_id> --agent-id=<agent_id>; done &
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

## Task Execution Workflow

1. Read the task spec in `backlog/<N>-<slug>.md` (or the path given in the task envelope) fully before starting.
2. Plan (identify files to change, check existing patterns).
3. Implement (small, atomic edits per step).
4. Self-review against acceptance criteria.
5. Run verification commands from the task spec.
6. Emit `orc run-work-complete` when implementation work is done, then use it as the required handoff before any terminal success signal.

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
- Tool permission prompts — Claude Code's bypass permissions mode handles these automatically.
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
