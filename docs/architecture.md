# Architecture

State, lifecycle and invariants: [contracts.md](./contracts.md). Settings: [configuration.md](./configuration.md).

---

## Overview

orc-state dispatches coding tasks to headless AI agent workers. Tasks live in the project's SQLite store (`runtime.db`; Markdown only through explicit import/export). `orc start-session` starts the coordinator and the master; the coordinator runs each task in its own git worktree, and the worker implements, tests, self-reviews and rebases it. The coordinator then merges it, or requests a finalize rebase first.

```
orc start-session
    |
    +---> Coordinator (background)        Master (tmux, attached)
              | tick (30 s)                   | user, task authoring, monitoring
              v
         pick eligible task
              v
         spawn worker in <state>/worktrees/<run_id>
              v
         worker: explore → implement → review → complete → finalize
              v
         coordinator merges (or PR), removes worktree
```

---

## Components

| Role | Process | Owns |
|------|---------|------|
| Coordinator | background Node process (`orc start-session`) | dispatch, session liveness probes (tmux pane), lease expiry and requeue, phase inference, merge, the control API |
| Master | provider session in orc's tmux server; `orc start-session` attaches to it | task authoring (`create_task`), monitoring (`orc status`, `orc watch`), answering input requests, scouts; never implements |
| Worker | headless session, one per run, random orc-themed name | its worktree; reports through `orc run-*` / `orc progress`; never merges or removes its worktree |
| Scout | ephemeral read-only session launched by the master | a `SCOUT_REPORT`; no state or file writes |

The worker's provider comes from the task's `required_provider` or the configured default. Workers are registered at dispatch and removed after the run.

## Data flow

1. Task authored (`create_task`, `orc project task create|import`) → immutable revision in `runtime.db`, projected to `backlog.json`.
2. Eligibility is derived each tick: `todo`, dependencies `done`/`released`, plus the rules in [contracts.md → Task Lifecycle](./contracts.md#task-lifecycle).
3. Capacity = `max_workers` − agents with an active claim. When > 0 the coordinator registers a worker, creates a run in `events.db` `runs` pinned to the latest revision, creates the worktree and launches the session.
4. The worker runs the phased workflow; lifecycle events go to the coordinator over the control API and land in `events.db`.
5. `run-work-complete` → the coordinator merges (direct) or drives the PR flow, records `done`, then `released`, and removes the worktree.

## Two roots

- **Orchestration root**: the project state directory `<data-home>/projects/<project_id>/`; holds state, worktrees, logs.
- **Target repo root**: the registered Git repository; all product-code git operations target it. Run worktrees live under the state directory but are worktrees of the target repo, which receives only product commits.

---

## Glossary

| Term | Meaning |
|------|---------|
| Coordinator | Background process that dispatches, supervises and merges |
| Master | Agent the user talks to, in orc's tmux server (`orc start-session` attaches); authors tasks, answers workers |
| Worker | Task-scoped headless agent session for one run |
| Scout | Read-only investigation agent launched with `request_scout` |
| Task | Unit of work: ref `<feature>/<slug>`, revisions, runtime-owned status |
| Feature | Grouping of tasks; the first segment of a task ref |
| Spec revision | Immutable task body + metadata; a run pins one |
| Plan | Saved design artifact in SQLite, imported/exported as Markdown ([plan-template.md](./plan-template.md)) |
| Run | One attempt of a task (`run-<timestamp>-<hex>`); a task may have several |
| Claim | Run ↔ task ↔ worker binding with a lease |
| Lease | Claim expiry time, renewed by run activity |
| Phase | Worker workflow step: explore, implement, review, complete, finalize |
| Finalization | Post-work-complete merge/rebase/PR state of a run |
| Worktree | `<state>/worktrees/<run_id>`, a git worktree of the target repo per run |
| Provider | AI backend: `claude`, `codex`, `gemini` |
| Adapter | Provider/transport layer behind one interface ([adapters.md](./adapters.md)) |
| Session handle | `<transport>:<agent_id>` (`tmux`, `app`) |
| Session secret | Per-session credential in the session's environment |
| Project | Registered target repo with a stable `project_id` and state directory |
