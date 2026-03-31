---
name: worker-inspect
description: >
  Inspect a worker or run's state, progress, output, or stuck status using
  MCP orchestrator tools. Use when asked about a specific worker's health,
  what it is doing, or why it is stuck.
argument-hint: "<agent-id>"
---

# Worker Inspect

**TRIGGER when:** "what is X doing?", "what's X up to?", "is X stuck?", "check on X",
"how is X going?", "is X making progress?", "what's X working on?", "is X running?",
"show X's logs", "what does X's output say?", "check on run Y", "what's run Y doing?"

**DO NOT TRIGGER for:** broad system status with no specific worker or run — use
`get_status()` inline instead. Do not trigger on "are workers stuck?" without a
specific agent or run reference.

---

## Lookup Table — match intent to MCP tool

Call **one** tool. Do not chain multiple tools unless the first result is insufficient.

| User intent | Tool to call |
|---|---|
| What is worker X doing? / What's X working on? / Is X making progress? | `get_agent_workview(agent_id: X)` |
| Is X stuck? / Why is X not responding? | `get_agent_workview(agent_id: X)` — check `input_state` field in the result |
| Is anyone waiting for input? / Are any workers blocked on a question? | `list_waiting_input()` |
| Details on a specific run? / What's run Y doing? | `get_run(run_id: Y)` |
| Show X's raw PTY log output | `orc attach <agent_id>` *(bash — no MCP equivalent)* |
| What happened recently with X? | `get_recent_events(agent_id: X)` |

**Always prefer MCP tools over bash `orc` commands** — they return structured JSON
with no parsing needed. Fall back to `orc attach <agent_id>` only when raw PTY
output is explicitly needed.

---

## Diagnostic hints

After calling the matched tool, check for these patterns in the output:

- **`input_state: awaiting_input`** — worker is blocked on a question; surface this to
  the user and ask whether to respond. Do not call `respond_input()` autonomously.
- **High idle time + `phase: implement`** — likely running a long test suite or genuinely stuck
- **`finalization_state: blocked_finalize`** — coordinator failed to merge; check `finalization_blocked_reason`
- **`status: offline`** with claim still active — session crashed; claim expires on lease timeout
- **PTY shows "Press up to edit queued mess"** — worker lost context; reset with `orc task-reset <task-ref>`
- **Lease expiring soon + `status: running`** — heartbeat loop may have died
