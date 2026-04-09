# Concepts & Terminology

Key terms used throughout the orc-state documentation.

For system invariants and state machine rules, see [Contracts & invariants](./contracts.md).

---

### Coordinator

The background Node.js process that manages the task lifecycle. It ticks periodically,
dispatches eligible tasks to workers, monitors worker health, and merges completed work
back to the main branch.

_You'll encounter this when running `orc start-session` — it starts the coordinator
automatically._

---

### Master

The foreground agent session — the primary conversation you have with the AI in your
terminal or IDE. The master interprets your requests, authors task specs, delegates work
to workers, and monitors progress.

_You'll encounter this as the interactive session that responds when you type commands
or questions._

---

### Worker

A headless agent session spawned by the coordinator to execute one task. Each worker
runs in an isolated git worktree, writes code, runs tests, coordinates a self-review,
and signals completion back to the coordinator.

_You'll encounter this in `orc status` output — workers appear as agents with an
assigned task and run ID._

---

### Scout

An ephemeral, read-only investigation agent. The master can launch a scout to inspect
code, logs, or runtime state and return a structured report — without modifying anything.
Scouts are discarded once their report is read.

_You'll encounter this when the master needs to investigate a stalled worker or gather
reconnaissance before deciding what task to create._

---

### Task

The unit of work. Each task is defined by a markdown spec in `backlog/` and tracked in
runtime state with a lifecycle (`todo → claimed → in_progress → done → released`).
A task may be attempted multiple times across different runs.

_You'll encounter this when reading `orc status` or browsing the `backlog/` directory._

---

### Run

One execution attempt of a task. A task can have multiple runs (for example, after a
failure and requeue). A run binds a specific worker agent to a specific task at a point
in time, and tracks that attempt through to success or failure.

_You'll encounter this in run IDs like `run-20260101120000-abcd` in logs and `orc status`._

---

### Claim

The binding record that links a run, a task, and a worker. When the coordinator
dispatches a task, it creates a claim; the claim expires if the worker goes silent
or fails. For the full claim schema and lifecycle rules, see
[Contracts & invariants](./contracts.md).

_You'll encounter this when troubleshooting a stuck task or reading `orc status` output._

---

### Feature

A named grouping of related tasks in the backlog. Features organize work thematically
(for example, `auth`, `cli`, `docs`). A task's `feature` field determines which feature
it belongs to, and task refs use the format `<feature>/<task-number>-<slug>`.

_You'll encounter this in task refs, `orc status` output, and backlog file paths._

---

### Worktree

An isolated git checkout created for each worker in a dedicated directory. Each worker
makes all its file changes inside its own worktree, so parallel workers never step on
each other's changes. The coordinator merges the branch and deletes the worktree after
the run completes.

_You'll encounter this in `.worktrees/` directory listings and in error messages about
git state._

---

### Provider

The AI backend that powers an agent session — for example, Claude, Codex, or Gemini.
The orchestrator is provider-agnostic: the same coordination logic works with any
supported provider, selected via configuration.

_You'll encounter this in `orchestrator.config.json` when choosing which AI model
runs your workers._

---

### Adapter

The software layer that connects the orchestrator to a specific provider's CLI. An
adapter implements a standard interface so the coordinator never needs to know
provider-specific details. For how to write a custom adapter, see
[Writing custom provider adapters](./adapters.md).

_You'll encounter this when integrating a new AI provider or a non-standard transport
like an HTTP API or remote SSH session._

---

## See also

- [Getting started](./getting-started.md)
- [Architecture overview](./architecture.md)
- [Contracts & invariants](./contracts.md)
