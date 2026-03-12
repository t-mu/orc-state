---
name: orc-commands
description: >
  Reference for all orc CLI subcommands, their usage, flags, and common operational
  patterns. Use when you need to run any orchestrator CLI command, reset task/agent
  state, inject input to a worker, or understand the run lifecycle.
argument-hint: "[command name or operation]"
---

# Orc Commands Reference

## Critical: State Directory

All orc commands resolve state from `process.cwd()/.orc-state` unless overridden.
**Always run from the repo root**, or prefix with the env var:

```bash
ORCH_STATE_DIR=<your-project>/.orc-state orc <cmd>
```

Commands that forget this will hit `ENOENT` errors or read wrong state. The `kill-all`
command is especially dangerous to run accidentally — it stops the coordinator and
clears all agents.

---

## All Subcommands

### Session / Coordinator Management

| Command | Usage | Notes |
|---------|-------|-------|
| `start-session` | `orc start-session [--provider=<claude\|codex\|gemini>]` | Starts coordinator + master session interactively. Requires TTY. |
| `watch` | `orc watch` | Live-refresh status display. |
| `status` | `orc status [--mine] [--agent-id=<id>]` | Print agent/task/claim table. |
| `doctor` | `orc doctor` | Validate state files, check provider keys/binaries, find orphaned claims. |
| `preflight` | `orc preflight` | Lightweight environment health check. |
| `init` | `orc init [--force]` | Initialise state directory. `--force` overwrites existing files. |
| `kill-all` | `orc kill-all` | ⚠️ Stops coordinator + clears ALL agents. Use only to fully reset. **Never run in a loop or batch script** — it has no `--help` guard and executes immediately. |
| `install-skills` | `orc install-skills [--global] [--provider=claude,codex] [--dry-run]` | Install skills/rules into `.claude/` or `.codex/` directories. |

### Worker Management

| Command | Usage | Notes |
|---------|-------|-------|
| `register-worker` | `orc register-worker <id> --provider=<claude\|codex\|gemini>` | Register a new worker agent. |
| `start-worker-session` | `orc start-worker-session <id> --provider=<claude\|codex\|gemini> [--role=<worker\|reviewer>] [--force-rebind]` | Launch a headless PTY session for a worker. |
| `attach` | `orc attach <id>` | Print tail of a worker's PTY output log. Read-only. |
| `control-worker` | `orc control-worker <id>` | Attach to a running worker session for inspection. |
| `deregister` | `orc deregister <id>` | Remove a specific agent registration. |
| `worker-remove` | `orc worker-remove <id>` | Remove a worker (stops session + deregisters). |
| `worker-gc` | `orc worker-gc` | Mark stale workers offline. |
| `worker-clearall` | `orc worker-clearall` | Remove all offline/stale workers. |

### Task Management

| Command | Usage | Notes |
|---------|-------|-------|
| `task-create` | `orc task-create --epic=<ref> --title=<text> [options]` | Add a task to backlog. Prefer MCP `create_task` from master. |
| `delegate` | `orc delegate --task-ref=<epic/task> [--target-agent-id=<id>] [--task-type=<implementation\|refactor>] [--note=<text>] [--actor-id=<id>]` | Assign a task to a worker. |
| `runs-active` | `orc runs-active` | List all in-progress/claimed runs. |
| `events-tail` | `orc events-tail` | Tail the events.jsonl event log. |

### Run Lifecycle (Worker Commands)

Workers emit these from inside their PTY session via Bash tool:

| Command | Usage | Notes |
|---------|-------|-------|
| `run-start` | `orc run-start --run-id=<id> --agent-id=<id>` | **Required first.** Acknowledge task start. |
| `run-heartbeat` | `orc run-heartbeat --run-id=<id> --agent-id=<id>` | Extend idle timeout. Emit every ~5 min during long work. |
| `run-work-complete` | `orc run-work-complete --run-id=<id> --agent-id=<id>` | Signal implementation+review+rebase done. Remain alive for coordinator finalization. |
| `run-finish` | `orc run-finish --run-id=<id> --agent-id=<id>` | Terminal success. Emit only after `run-work-complete` handoff. |
| `run-fail` | `orc run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--policy=requeue\|block]` | Terminal failure. Default policy is `requeue`. |
| `progress` | `orc progress --event=<type> --run-id=<id> --agent-id=<id> [--phase=<name>] [--reason=<text>] [--policy=<requeue\|block>]` | Emit a named lifecycle event (e.g. `phase_started`, `phase_finished`). |

### Input Request / Response

For workers that need master input (e.g. blocked on a decision):

| Command | Usage | Notes |
|---------|-------|-------|
| `run-input-request` | `orc run-input-request --run-id=<id> --agent-id=<id> --question=<text> [--timeout-ms=<ms>]` | Worker calls this to ask master a question. Blocks until response or timeout. |
| `run-input-respond` | `orc run-input-respond --run-id=<id> --agent-id=<id> --response=<text> [--actor-id=<id>]` | Master calls this to answer a worker's input request. |

---

## Common Operational Patterns

### Reset a blocked/failed task to todo

```bash
node --input-type=module <<'EOF'
import { withLock } from './lib/lock.mjs';
import { atomicWriteJson } from './lib/atomicWrite.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_DIR = process.env.ORCH_STATE_DIR ?? '.orc-state';
const BACKLOG   = join(STATE_DIR, 'backlog.json');
const TARGET    = 'orch/task-NNN-slug';

withLock(join(STATE_DIR, '.lock'), () => {
  const data = JSON.parse(readFileSync(BACKLOG, 'utf8'));
  for (const epic of data.epics) {
    const task = (epic.tasks ?? []).find(t => t.ref === TARGET);
    if (task) {
      task.status = 'todo';
      delete task.owner;
      delete task.blocked_reason;
      atomicWriteJson(BACKLOG, data);
      console.log('reset to todo');
      return;
    }
  }
});
EOF
```

Note: `task.owner` must be **deleted** (not set to `null`) — `null` fails schema validation.

### Restart coordinator cleanly

```bash
# 1. Kill existing
ps aux | grep "coordinator.mjs" | grep -v grep | awk '{print $2}' | xargs kill

# 2. Start with explicit state dir (avoids cwd ambiguity)
ORCH_STATE_DIR=/path/to/repo/.orc-state node /path/to/repo/coordinator.mjs \
  >> /path/to/repo/.orc-state/coordinator.out.log 2>&1 &
```

---

## Run Lifecycle State Machine

```
claim_created  →  run_started  →  [phase_started / phase_finished / heartbeat]
                                           ↓
                                   run_work_complete  (non-terminal; wait for coordinator)
                                           ↓
                              run_finished  |  run_failed
```

Coordinator also emits:
- `claim_expired` — when run hits idle timeout (30 min default); task requeued

---

## Backlog JSON Structure

Tasks are nested inside epics — **not** a flat top-level array:

```json
{
  "version": "1",
  "epics": [
    {
      "ref": "orch",
      "title": "Orchestrator",
      "tasks": [ { "ref": "orch/task-NNN-slug", "status": "todo" } ]
    }
  ],
  "next_task_seq": 161
}
```

All state writes must use `withLock` + `atomicWriteJson`. Never write directly.
