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

Worktree lifecycle commands are pre-authorized operational steps for agents in
this repository. Do not stop to ask the user for permission before running the
standard non-destructive worktree management commands needed by this workflow:
`git worktree add`, `git worktree remove`, and `git branch -d`.
The standard workflow integration steps `git commit`, `git rebase main`, and
the final `git -C ../.. merge ... --no-ff` are also pre-authorized here when
the task workflow calls for them.

### Setup — coordinator-assigned worktree
The coordinator starts every worker session from the repo root, regardless of provider.
Your assigned worktree path is in the TASK_START payload (`assigned_worktree`).
After calling `orc run-start`, `cd` into that path before doing any work.
Do not create a second worktree unless the task payload explicitly tells you to recover a missing one.

### All work happens inside the assigned worktree
Run builds, tests, and edits from inside the assigned `.worktrees/<run_id>`.
The main checkout stays clean.

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
#    b. Spawn two independent sub-agents. Give each the acceptance criteria and
#       the output of `git diff main` as context. Ask each to review the changes
#       and return findings (or "approved").
#    c. Wait for a final response from both sub-agents. Do not merge after only
#       one response. If a reviewer fails explicitly, cannot complete, or remains
#       non-responsive after a reasonable bounded wait, record that outcome and
#       proceed with the completed review(s).
#    d. Consolidate findings from all completed review responses.
#    e. Address all findings, then amend or add a fixup commit.
#    This review round happens once.

# 3. Rebase onto latest main — resolve any conflicts before proceeding
git rebase main
# If conflicts arise:
#   - inspect: git diff, git status
#   - resolve each conflicted file manually
#   - stage resolved files: git add <file>
#   - continue: git rebase --continue
#   - repeat until rebase completes cleanly
# Only call orc run-fail if a conflict is genuinely unresolvable.

# 4. Report implementation complete before any terminal success signal
orc run-work-complete --run-id=<run_id> --agent-id=<agent_id>

# 5. Remain alive in the same worktree for coordinator follow-up when it exists
#    - If coordinator requests a finalize rebase, do it here, then emit
#      `orc progress --event=finalize_rebase_started ...`, complete the rebase,
#      then emit `orc run-work-complete` again.
#    - If coordinator confirms finalization success, emit orc run-finish.
#    - If no follow-up arrives, only emit orc run-finish after the
#      run-work-complete handoff has already been recorded.
#    - Do not merge to main or clean up the worktree/branch yourself.
```

### On unresolvable failure
```bash
orc run-fail --run-id=<run_id> --agent-id=<agent_id> --reason="<explanation>"
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

Outside the blessed workflow:
- supported inspection commands are for observability only
- advanced/specialized commands are for setup or niche cases
- recovery/debug commands are second-class and should not be chosen when the blessed path applies

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
orc run-heartbeat --run-id=<id> --agent-id=<id>                    # extend idle timeout (emit every ~5 min)
orc run-work-complete --run-id=<id> --agent-id=<id>                # signal impl+review+rebase done; wait for coordinator
orc run-finish --run-id=<id> --agent-id=<id>                       # terminal success (after work-complete)
orc run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] \
  [--policy=requeue|block]                                          # terminal failure; default policy=requeue

# Generic lifecycle event (phase tracking, optional / secondary path)
orc progress --event=<type> --run-id=<id> --agent-id=<id> \
  [--phase=<name>] [--reason=<text>] [--policy=<requeue|block>]    # emit phase_started, phase_finished, etc.

# Input request/response (worker ↔ master)
orc run-input-request --run-id=<id> --agent-id=<id> \
  --question=<text> [--timeout-ms=<ms>]                            # worker asks master a question; blocks until answered
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

**For code authors** (implementing new CLI commands or MCP handlers):
- All state writes: `withLock` + `atomicWriteJson`. Never `writeFileSync` directly.
- All event appends: `appendSequencedEvent`. Never append to `events.jsonl` directly.
- Validate all inputs **before** any `atomicWriteJson` call — no partial writes on failure.
- Schemas use AJV draft-07 with `additionalProperties: false` on all object definitions.
- Run `orc doctor` after any schema or state file change.

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

### Worker event contract (workers must follow this)
```
claim_created    (coordinator)
run_started      (worker — emit immediately on TASK_START)
phase_started    (worker — optional, per work phase)
phase_finished   (worker — optional, per work phase)
run_finished     (worker — on success)
run_failed       (worker — on failure, include reason)
```

Emit progress via:
```bash
orc progress --event=run_started --run-id=<id> --agent-id=<id>
```

Non-terminal handoff signal:
```bash
orc run-work-complete --run-id=<id> --agent-id=<id>
```

Use `orc run-work-complete` after commit/review/verification and `git rebase main`
are complete, then remain alive for coordinator-owned finalization follow-up when present.

Heartbeat requirement: emit `heartbeat` (or any non-terminal event) at least every 60 s while a claim is active, or the coordinator will eventually expire and requeue the task.

### Provider configuration

`required_provider` on a task routes that task exclusively to agents whose `provider` field matches.
The worker pool provider itself is resolved via the following fallback chain:

```
task.required_provider          — route this task to a specific provider
  worker pool (all workers):
    ORC_WORKER_PROVIDER env
    → worker_pool.provider in orchestrator.config.json
    → default_provider in orchestrator.config.json
    → hardcoded default ('codex')
```

Set `default_provider` at the top level of `orchestrator.config.json` to configure the default
provider for all workers without setting `worker_pool.provider`:

```json
{
  "default_provider": "claude"
}
```

### Agent roles
| Role | Can claim tasks | Excluded from auto-dispatch |
|------|----------------|----------------------------|
| `worker` | Yes | No |
| `reviewer` | Yes | No |
| `master` | No | Yes |

The master agent creates and delegates tasks; it does not execute them directly.

### Session startup flow
1. `orc start-session` checks coordinator state (reuse/restart/start).
2. `orc start-session` checks the `MASTER` registration (reuse/replace/create).
3. `orc start-session` opens the selected master provider CLI in the foreground.

The master and workers are separate setup paths:
- `MASTER`: one foreground planner/delegator session in the operator terminal
- `WORKERS`: one or more headless PTY task executors managed by coordinator ticks

Worker sessions are headless PTY processes managed by coordinator ticks.
Default worker IDs are auto-assigned as `orc-<N>` (for example `orc-1`, `orc-2`).
Use `--worker-id=<id>` to override auto naming when needed.

---

## Task Execution Workflow

1. Read the task spec in `backlog/<N>-<slug>.md` (or the path given in the task envelope) fully before starting.
2. Plan (identify files to change, check existing patterns).
3. Implement (small, atomic edits per step).
4. Self-review against acceptance criteria.
5. Run verification commands from the task spec.
6. Emit `orc run-work-complete` when implementation work is done, then use it as the required handoff before any terminal success signal.

Recovery/debug commands remain available, but they are not part of the normal agent path and should only be used when the session is explicitly in recovery mode.

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

---

## Interactive Prompt Rule

If you encounter an interactive confirmation prompt you cannot bypass (e.g. a
tool asking "Would you like to apply these changes? [y/n]"), do NOT sit and wait.
Call `orc run-input-request` first so the question is bubbled to the master:

```bash
orc run-input-request --run-id=<run_id> --agent-id=<agent_id> \
  --question="Blocked on interactive prompt while <action>. Prompt asked: <prompt text>. What should I answer?"
```

That command waits for a matching `input_response` while keeping the run alive.
Only call `orc run-fail` if the prompt remains unrecoverable even after master input.

---

## What to Avoid

- Adding npm dependencies without asking first.
- Calling internal library functions (`withLock`, `atomicWriteJson`, `appendSequencedEvent`) directly — use CLI commands or MCP tools instead.
- Writing inline Node.js scripts to manipulate state files — use `orc` CLI or MCP tools.
- Refactoring, renaming, or "improving" code beyond what the task requires.
- Adding features, abstractions, or error handling for hypothetical future cases.
- Leaving tests broken.
