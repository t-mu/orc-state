---
name: worker-inspect
description: >
  Inspect a worker agent's full state: status, run, PTY output, worktree,
  hook events, and finalization state. Use when you need to check on a
  specific worker, diagnose why it's stuck, or review its recent output.
argument-hint: "<agent-id>"
---

# Worker Inspection

Produce a structured diagnostic report for the specified worker agent.
If no agent-id is given, ask the user which worker to inspect.

**Important:** All commands must be run from the repo root so that
`.orc-state/` resolves correctly.

## Steps

1. **Resolve agent identity**
   Run: `orc status`
   Find the worker row matching the requested agent-id. Extract: status, run_id, task_ref, phase, idle time, lease expiry, finalization_state.

2. **Read claim details**
   Read the claims file directly and find the claim for this agent:
   ```bash
   cat .orc-state/claims.json
   ```
   In the `claims` array, find the entry where `agent_id` matches. Note any: `input_state`, `finalization_state`, `finalization_blocked_reason`, `failure_reason`, `session_start_last_error`.

3. **Read PTY output (filtered)**
   Run: `orc attach <agent-id>`
   If the output is mostly blank/TUI artifacts, filter meaningful lines:
   ```bash
   grep -v '^\s*$' .orc-state/pty-logs/<agent-id>.log | grep -v '^[─│┌┐└┘├┤┬┴┼]' | tail -40
   ```
   Look for: error messages, test results, phase markers, `orc` CLI output, git output.

4. **Check worktree state** (if a run is active)
   The worktree path is shown in `orc status` output (e.g. `.worktrees/run-xxx`).
   ```bash
   git -C <worktree-path> status --short
   git -C <worktree-path> log --oneline -5
   ```

5. **Check hook events** (permission prompts)
   ```bash
   cat .orc-state/pty-hook-events/<agent-id>.ndjson 2>/dev/null || echo "(none)"
   ```

6. **Check recent events for this agent**
   ```bash
   orc events-tail --n=30 --json 2>/dev/null | grep '"<agent-id>"' | tail -10
   ```

## Output Format

Present findings as a structured report:

```
Worker: <agent-id> (<provider>, <model>)
Status: <status> / <run-state>
Run:    <run-id>
Task:   <task-ref>
Phase:  <phase>
Age:    <age>, idle <idle-time>
Lease:  expires in <time>

Worktree: <path>
Branch:   <branch>
Git:      <clean/dirty>, <N> commits ahead of main

Finalization: <state or n/a>
Input state:  <awaiting_input or none>
Hook events:  <count or none>

Last meaningful output:
  <filtered PTY lines>

Issues detected:
  - <any problems found: stuck at prompt, permission dialog, test failure, rebase conflict, etc.>
  - (none) if healthy
```

## Diagnostic Hints

- **idle > 5min + phase=implement**: likely running long test suite or stuck
- **lease expires in < 5min + status=running**: background heartbeat loop may have died; worker is at risk of lease expiry and task requeue
- **finalize_rebase_requested + high retry count**: rebase is failing, check worktree for conflicts
- **PTY shows "Press up to edit queued mess"**: worker lost context, needs reset via `orc task-reset <task-ref>`
- **Hook events file exists**: permission prompt detected, check if coordinator recorded input_requested
- **input_state=awaiting_input**: worker asked a question, check events for the question text
- **status=offline but claim=in_progress**: session crashed, claim will expire on lease timeout
- **finalization_blocked_reason set**: coordinator failed to merge, read the reason for the specific git error
