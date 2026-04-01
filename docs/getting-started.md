# Getting started

## Prerequisites

- **Node.js 24+** — required for native TypeScript type stripping (no build step)
- **Git** — worktree isolation requires git
- **At least one agent provider** — Claude Code, Codex CLI, or Gemini CLI installed and authenticated

## Install

```bash
npm install -g orc-state
```

Verify:

```bash
orc --help
```

## Start a session

```bash
orc start-session --provider=claude
```

This launches two things:

1. **Coordinator** — background process that dispatches tasks to workers, monitors heartbeats, and manages the run lifecycle
2. **Master agent** — foreground interactive session where you direct the work

The provider flag (`claude`, `codex`, `gemini`) controls which agent CLI spawns worker sessions. You can mix providers across workers in the same session.

## Create your first task

Tasks are markdown files in the `backlog/` directory. Each file is a self-contained spec that tells a worker exactly what to do.

Create `backlog/1-add-logging.md`:

```markdown
---
ref: general/1-add-logging
feature: general
priority: normal
status: todo
---

# Task 1 — Add request logging

Independent.

## Scope

**In scope:**
- Add structured logging to the HTTP handler

**Out of scope:**
- Changing existing test infrastructure

---

## Context

### Current state
No request logging exists.

### Desired state
Every incoming request logs method, path, and duration.

### Start here
- `src/handler.ts` — the HTTP handler

**Affected files:**
- `src/handler.ts` — add logging calls
- `src/handler.test.ts` — add test for log output

---

## Goals

1. Must log method, path, and response time for every request
2. Must not add external dependencies
3. Must include at least one test

---

## Acceptance criteria

- [ ] Every request produces a structured log line
- [ ] `npm test` passes
- [ ] No changes to files outside the stated scope
```

Register it with the orchestrator:

```bash
orc task-create
orc backlog-sync-check   # verify state matches markdown
```

## Dispatch work

Delegate the task to a worker:

```bash
orc delegate
```

The coordinator assigns the task to an available worker, creates an isolated git worktree, and starts a headless agent session. The worker follows a five-phase lifecycle automatically: explore, implement, review, complete, finalize.

## Monitor progress

Check current state:

```bash
orc status
```

Live dashboard with auto-refresh:

```bash
orc watch
```

Tail the event stream:

```bash
orc events-tail
```

View a specific worker's output:

```bash
orc attach <agent-id>
```

Check system health:

```bash
orc doctor
```

## What happens behind the scenes

1. **Coordinator claims the task** — status moves from `todo` to `claimed`
2. **Worker starts** — `run-start` transitions the task to `in_progress`; the worker reads the spec, writes code, and runs tests in an isolated worktree
3. **Self-review** — the worker spawns sub-agent reviewers that audit the diff against acceptance criteria
4. **Completion** — the worker marks the task done, rebases onto main, and signals `run-work-complete`
5. **Merge** — the coordinator merges the worktree branch and cleans up

Workers heartbeat every 4.5 minutes. If a worker goes silent, the coordinator expires the claim and requeues the task.

## Next steps

- [Configuration](./configuration.md) — provider settings, concurrency, timeouts
- [CLI reference](./cli.md) — full command documentation
- [Writing custom adapters](./adapters.md) — add support for new agent providers
- [Contracts & invariants](./contracts.md) — system guarantees and state machine rules
