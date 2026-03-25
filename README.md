# orc-state

Multi-agent orchestration runtime. Provider-agnostic. File-backed. No build step.

One master. Many headless workers. Autonomous coding, coordinated.

---

## Requirements

- **Node 24** (`--experimental-strip-types`, zero build step)
- **node-pty** needs native build tools — Xcode CLT on macOS, `build-essential` + `python3` on Linux

---

## The 30-second mental model

State lives in `.orc-state/`: `backlog.json`, `agents.json`, `claims.json`, `events.db`.

A coordinator dispatches `todo` tasks to headless PTY workers. Workers run in their own git worktrees, heartbeat every 5 min, and signal done when finished. The foreground master orchestrates everything from your terminal.

---

## Quick Start

```bash
orc start-session --provider=claude
```

That's it. Coordinator starts, master launches in your terminal, workers spin up per task.

### Configure worker capacity

Via env or `ORCH_STATE_DIR/orchestrator.config.json`:

```bash
export ORC_MAX_WORKERS=2
export ORC_WORKER_PROVIDER=claude
export ORC_WORKER_MODEL=claude-sonnet-4-6
```

```json
{ "worker_pool": { "max_workers": 2, "provider": "claude", "model": "claude-sonnet-4-6" } }
```

---

## The Blessed Path

```
orc start-session
  → edit backlog/<N>-slug.md
  → orc task-create / orc backlog-sync-check
  → delegate task
  → worker: run-start → run-heartbeat → run-work-complete → run-finish
  → orc status
```

Worker lifecycle commands:

```bash
orc run-start      --run-id=<id> --agent-id=<id>
orc run-heartbeat  --run-id=<id> --agent-id=<id>   # every 4.5 min
orc run-work-complete --run-id=<id> --agent-id=<id>
orc run-finish     --run-id=<id> --agent-id=<id>
orc run-fail       --run-id=<id> --agent-id=<id> --reason="..." [--policy=requeue|block]
```

---

## Monitoring

```bash
orc status          # capacity, active runs, finalization, recent failures
orc watch           # live-refresh
orc runs-active     # what's running right now
orc events-tail     # stream the event log
orc doctor          # health check
```

---

## Backlog

`backlog/` is the source of truth. `.orc-state/backlog.json` is the dispatch mirror.

Always: write spec → register → `orc backlog-sync-check`.

---

## MCP Server

```bash
ORCH_STATE_DIR=/path/to/.orc-state node --experimental-strip-types mcp/server.ts
```

Tools: `list_tasks`, `get_task`, `create_task`, `update_task`, `delegate_task`, `cancel_task`, `reset_task`, `get_run`, `get_status`, `get_recent_events`, `query_events`, `get_agent_workview`, `list_agents`, `list_active_runs`, `list_stalled_runs`, `list_waiting_input`, `list_worktrees`, `respond_input`.

Resources: `orchestrator://state/backlog`, `orchestrator://state/agents`.

---

## Providers

| Provider | Auth |
|----------|------|
| `claude` | CLI auth, MCP config auto-written by `start-session` |
| `codex`  | CLI auth, bootstrap via `--instructions` |
| `gemini` | CLI auth, MCP config + `--system-instruction` |

---

## Recovery (not the normal path)

```bash
orc task-reset <ref>      # reset to todo
orc task-unblock <ref>    # unblock a blocked task
orc worker-gc             # reap stale workers
orc kill-all              # nuclear reset
```

Full recovery procedures: [docs/recovery.md](docs/recovery.md)

---

## Tests

```bash
npm test           # unit + integration
npm run test:e2e   # end-to-end
```

---

## Contracts

State invariants, adapter contracts, worker lifecycle details: [contracts.md](./contracts.md)
