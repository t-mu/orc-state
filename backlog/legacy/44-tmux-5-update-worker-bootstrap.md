# Task 44 — Update Worker Bootstrap Template

Depends on Task 43 (run-reporting commands exist). Independent of Tasks 41–42.

---

## Scope

**In scope:**
- Rewrite `templates/worker-bootstrap-v2.txt`
- Optionally update `templates/master-bootstrap-v1.txt` if it references [ORC_EVENT] lines

**Out of scope:**
- `lib/sessionBootstrap.mjs` — no changes needed (still reads the template file)
- `lib/templateRender.mjs` — no changes needed
- No code changes in this task, only template text

---

## Context

### Current bootstrap (what to replace)

The existing `worker-bootstrap-v2.txt` tells workers to embed `[ORC_EVENT]` JSON lines
in their response text, which the coordinator then parses. The last line even explicitly says:

```
Do NOT use orc-progress shell commands - you are operating via API, not a tmux shell
```

This is now the opposite of what we want. Workers run as real CLI sessions with Bash tool
access. They must call `orc` CLI commands directly — NOT print formatted JSON.

### New protocol

| Old (SDK, API response parsing) | New (tmux, CLI commands) |
|---|---|
| Print `[ORC_EVENT] {"event":"run_started",...}` | Run `orc-run-start --run-id=R --agent-id=A` |
| Print `[ORC_EVENT] {"event":"heartbeat",...}` | Run `orc-run-heartbeat --run-id=R --agent-id=A` |
| Print `[ORC_EVENT] {"event":"run_finished",...}` | Run `orc-run-finish --run-id=R --agent-id=A` |
| Print `[ORC_EVENT] {"event":"run_failed",...}` | Run `orc-run-fail --run-id=R --agent-id=A --reason="..."` |

### CHECK_WORK trigger

The coordinator sends "CHECK_WORK" (or a short command string) to the agent's tmux pane
as a nudge when a task is assigned. The bootstrap must instruct the agent what to do when
it receives this string.

### TASK_START block

When the coordinator dispatches a task, it sends the rendered `task-envelope-v2.txt` content
via `adapter.send()` → `tmux send-keys`. The agent receives this as user input. The template
variables in the envelope include `run_id` and `agent_id`, which the agent needs to use in
its CLI reporting commands.

**Affected files:**
- `templates/worker-bootstrap-v2.txt` — full rewrite
- `templates/master-bootstrap-v1.txt` — review and update if needed

---

## Goals

1. Must remove all `[ORC_EVENT]` JSON printing instructions
2. Must add clear instructions to call `orc-run-start`, `orc-run-heartbeat`, `orc-run-finish`, `orc-run-fail`
3. Must add a CHECK_WORK trigger section
4. Must instruct the agent to use its Bash tool to run the orc commands
5. Must be concise enough that the agent internalises the instructions without confusion
6. Must not reference the API adapter or suggest the agent is operating via API

---

## Implementation

### Step 1 — Rewrite `templates/worker-bootstrap-v2.txt`

Replace the entire file with:

```
WORKER_BOOTSTRAP v4
agent_id: {{agent_id}}
provider: {{provider}}

You are an autonomous orchestration worker. You run as a CLI session in a tmux pane.
The orchestrator coordinates your work via a shared file-state system.

━━━ CHECKING FOR WORK ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When you receive the message CHECK_WORK, immediately run:

  orc status --mine

If a task is assigned to you (shown with agent_id={{agent_id}}), pick it up.
If nothing is assigned, go idle and wait for the next CHECK_WORK.

━━━ TASK LIFECYCLE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

When a TASK_START block arrives, it contains a run_id. Use your Bash tool to
report progress via these CLI commands:

  # Required first — immediately when you begin the task:
  orc-run-start --run-id=<run_id> --agent-id={{agent_id}}

  # Optional — send periodically during long work (every ~5 minutes):
  orc-run-heartbeat --run-id=<run_id> --agent-id={{agent_id}}

  # Required last — when all acceptance criteria are met:
  orc-run-finish --run-id=<run_id> --agent-id={{agent_id}}

  # If you cannot complete the task:
  orc-run-fail --run-id=<run_id> --agent-id={{agent_id}} --reason="<explanation>"

These commands update the shared state files. The coordinator reads them on its
next tick. Do NOT print [ORC_EVENT] JSON lines — they are not read in this mode.

━━━ READING STATE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  orc status         # overall backlog and agent status
  orc status --mine  # tasks assigned to {{agent_id}} only
  orc runs-active    # currently running tasks

━━━ RULES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Always call orc-run-start before doing any work on a task.
- Call orc-run-finish only when all acceptance criteria in the TASK_START block are met.
- Call orc-run-fail if you hit an unrecoverable blocker.
- Never call orc-run-finish speculatively before the work is done.
- After completing a task, check for more work: orc status --mine

WORKER_BOOTSTRAP_END
```

### Step 2 — Review `templates/master-bootstrap-v1.txt`

Read the file. If it contains any `[ORC_EVENT]` JSON printing instructions in its OUTPUT
PROTOCOL section, update that section to reference the orc CLI commands instead.
The master agent primarily uses `orc-task-create` and `orc-delegate`; it may not need
the run lifecycle commands (those are for workers). Keep the master bootstrap focused on
task management, not run reporting.

---

## Acceptance criteria

- [ ] `worker-bootstrap-v2.txt` contains no `[ORC_EVENT]` references
- [ ] `worker-bootstrap-v2.txt` contains instructions for `orc-run-start`, `orc-run-heartbeat`, `orc-run-finish`, `orc-run-fail`
- [ ] `worker-bootstrap-v2.txt` contains a CHECK_WORK section explaining what to do when the nudge arrives
- [ ] Template variables `{{agent_id}}` and `{{provider}}` are still present
- [ ] `WORKER_BOOTSTRAP_END` sentinel is still present (used by parsers/tests)
- [ ] `lib/sessionBootstrap.mjs` and `lib/templateRender.mjs` are unchanged

---

## Tests

No code tests needed for a template change. Verified manually by running
`orc-worker-start-session` and observing the rendered bootstrap sent to the tmux pane.

---

## Verification

```bash
# Check that [ORC_EVENT] is gone
grep 'ORC_EVENT' templates/worker-bootstrap-v2.txt
# Expected: no output

# Check that orc-run-start is present
grep 'orc-run-start' templates/worker-bootstrap-v2.txt
# Expected: one or more matches

# Check that CHECK_WORK is present
grep 'CHECK_WORK' templates/worker-bootstrap-v2.txt
# Expected: one or more matches
```
