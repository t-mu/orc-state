# Orchestrator — Agent Guide

Repo guide for every agent (workers, master, developers). Read before touching any file.

## Project

Provider-agnostic multi-agent orchestration runtime for coding agents (Claude, Codex, Gemini). A coordinator dispatches project tasks to task-scoped worker sessions (tmux, else PTY, or structured `app:`), drives their run lifecycle, and reports to a foreground master agent. State: SQLite stores plus JSON projections in the project state directory, outside the repository. Roles and glossary: `docs/architecture.md`.

## Stack

| Layer | Choice |
|---|---|
| Language | TypeScript (`.ts`), run by Node 24 type stripping |
| Build | `npm run build` → `dist/`; the installed `orc` runs `dist/cli/orc.js`, so rebuild to try changes through it |
| Tests | Vitest |
| Runtime | Node.js 24 (`.nvmrc`) |

## Environment

```bash
nvm use 24
npm install
npm test    # pretest runs typecheck + lint; inherited ORC_* is stripped, safe in a worker session
```

Pin exact versions in `package.json` (no `~`/`^`).

## Worktrees

- Workers: stay in `assigned_worktree` from TASK_START (`<state>/worktrees/<run_id>`, already your cwd). Never create another worktree, merge, or clean up the worktree or branch; the coordinator does.
- Master/devs merging by hand: run every command from the main checkout, worktree before branch. For a run, merge, then `orc run-close <run_id>` cleans up.
  1. `git -C <main-repo> merge <branch> --no-ff -m "task(<ref>): merge worktree"`
  2. `git -C <main-repo> worktree remove <worktree-path>`
  3. `git -C <main-repo> branch -d <branch>`

## Workers: follow WORKER_BOOTSTRAP

The full protocol (commands, review constraints, PR loop, input requests) is `templates/worker-bootstrap-v2.txt`, sent at session start. Phases and gates:

| Phase | Work | Gate |
|---|---|---|
| explore | `orc run-start` first, then read `task_spec_path` | `run-start` exits 0 |
| implement | code + tests | `npm test` exits 0 |
| review | commit; review by `review_level`: `none` self-review, `light` one `reviewer`, `full` (default) `critic` + `integrator`. Reviewers run `orc review-submit --agent-id=<worker's agent_id> --reviewer=<label>`; read with `orc review-read`; fix all findings; one round | all submitted reviews `approved` |
| complete | `git rebase main` (direct mode only), `npm test` | `orc run-work-complete` exits 0 |
| finalize | wait for coordinator (finalize rebase or PR_REVIEW) | `orc run-finish` |

## Blessed paths

- Session: `orc start-session`.
- Tasks: `orc project task create|edit|import` or MCP `create_task`/`update_task`; stored in the project's `runtime.db`, never in the repo. Format: `docs/task-template.md`; plans: `docs/plan-template.md`.
- Dispatch: automatic; the coordinator spawns a worker per task when capacity allows.
- Status is runtime-owned: the coordinator marks a task done after merge. Never edit a spec's `status:`; `orc task-mark-done` is operator recovery only.
- Inspection: `orc status`, `orc doctor`. Everything else is recovery/debug: `docs/cli.md`, `docs/recovery.md`.

Task lifecycle (transitions and owners: `docs/contracts.md`):

```
todo → claimed → in_progress → done → released
                     ↓
                  blocked          (todo/claimed/in_progress/blocked → cancelled)
```

A task is claimable when `status == todo` and every `depends_on` ref is `done`/`released`.

## Write rules

- Change state only through `orc` commands or MCP tools. Never call `withLock`, `atomicWriteJson`, `appendSequencedEvent` or other internals from an agent session, and never edit state files.
- State files, events, liveness and invariants: `docs/contracts.md`. Settings, env vars, execution modes, runtimes: `docs/configuration.md`.

## Commit discipline

- One commit per task unit; commit before starting the next.
- Format: `feat(<scope>): <outcome>`, `fix(<scope>): <outcome>`, `chore(<scope>): <outcome>`.
- Never `--no-verify` or skip hooks.

## Verification checklist

- [ ] `npm test` passes.
- [ ] New pure logic has tests.
- [ ] `orc doctor` exits 0 after schema or state changes.
- [ ] No files changed outside the task scope.
- [ ] A multi-step command chain you ran could have been one `orc` command → file a task.
- [ ] This file lacked a fact that cost you a wrong assumption or extra reads → fix it here (small) or file a task.

## What to avoid

- Adding npm dependencies without asking.
- Inline Node scripts that touch state files.
- Refactoring, renaming or "improving" beyond the task.
- Features, abstractions or error handling for hypothetical cases.
- Leaving tests broken.
