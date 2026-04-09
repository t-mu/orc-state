# Architecture

A high-level overview of how orc-state works. For terminology definitions, see
[Concepts](./concepts.md). For system invariants and state machine rules, see
[Contracts & invariants](./contracts.md). For configuration options, see
[Configuration](./configuration.md).

---

## Overview

orc-state is a local orchestration runtime that dispatches coding tasks to autonomous
AI agents. You write task specs as markdown files, run `orc start-session`, and the
system assigns tasks to headless agent workers that implement, test, and self-review
the work — each in an isolated git worktree. Completed branches are rebased and merged
back to main automatically.

---

## Runtime diagram

```
orc start-session
    |
    +---> Coordinator (background)        Master (foreground)
              |                                |
              | ticks every ~30s              | user interaction
              |                               | task creation
              v                               | monitoring
         Pick eligible task
              |
              v
         Spawn worker in .worktrees/<run-id>/
              |
              v
         Worker: explore -> implement -> review -> complete
              |
              v
         Coordinator merges to main, cleans up worktree
```

---

## Components

### Coordinator

The coordinator is a background Node.js process started by `orc start-session`. On
each tick it reads the backlog, finds tasks whose dependencies are satisfied, and
dispatches them to available workers. It also monitors worker liveness (via PTY PID
probing), expires stalled claims, requeues failed tasks, and merges completed worktree
branches back to main.

The coordinator owns the dispatch decision and the merge. Workers do not merge
themselves.

### Master

The master is the foreground agent session — your interactive conversation. It creates
tasks, monitors progress via `orc status` and `orc watch`, responds to worker questions
(`orc run-input-respond`), and can request investigation scouts. The master does not
implement tasks directly.

### Worker

A worker is a headless agent session spawned by the coordinator for a single task run.
It operates entirely inside an isolated git worktree (`.worktrees/<run-id>/`), follows
a five-phase lifecycle (explore, implement, review, complete, finalize), and signals
progress through `orc` CLI commands. When work is done, it signals the coordinator and
waits for the merge.

### Scout

A scout is an ephemeral read-only agent launched by the master to investigate a
specific question — why a worker is stalled, what a piece of code does, or what git
history shows. Scouts do not write files, mutate state, or participate in the task
lifecycle. The master cleans them up after reading their report.

---

## Data flow

1. **Spec authored** — you write a markdown file in `backlog/` describing the task.
2. **Coordinator syncs** — on each tick, the coordinator reads all `backlog/*.md` files
   and reconciles them into `.orc-state/backlog.json`.
3. **Task becomes eligible** — once a task's `depends_on` refs are all `done` or
   `released`, the coordinator marks it eligible for dispatch.
4. **Claim created** — when a worker is available, the coordinator creates a claim in
   `.orc-state/claims.json` and spawns a worker PTY session.
5. **Worker runs** — the worker reads the spec, writes code, runs tests, and submits
   the work for self-review. Each lifecycle event is appended to `.orc-state/events.db`.
6. **Work complete** — the worker signals `run-work-complete`; the coordinator takes
   over to rebase the branch and merge it to main.
7. **Task released** — after merge, the task transitions to `released` and the worktree
   is removed.

---

## State directory

All runtime state lives under `.orc-state/` at the repo root. Agents never write these
files directly — all mutations go through `orc` CLI commands or MCP tool handlers.

| File | Contents |
|------|----------|
| `backlog.json` | Features and tasks (synced from `backlog/*.md`) |
| `agents.json` | Registered agents and their session metadata |
| `claims.json` | Active and historical run claims |
| `events.db` | Append-only SQLite event log |
| `memory.db` | SQLite memory store for agent notes (FTS5-indexed) |

For field-level schemas and concurrency guarantees, see [Contracts & invariants](./contracts.md).

---

## Worktree isolation

Each task run gets its own git worktree at `.worktrees/<run-id>/`. This means:

- **No shared working tree conflicts** — two workers implementing different tasks
  simultaneously never touch the same checkout.
- **Clean rebase surface** — when the worker finishes, the coordinator rebases the
  isolated branch onto the latest main before merging.
- **Safe failure** — if a run fails, the worktree is simply removed; no partial changes
  reach main.

The coordinator creates the worktree before dispatching the worker and removes it after
a successful merge. Workers must not remove their own worktree or merge to main.
