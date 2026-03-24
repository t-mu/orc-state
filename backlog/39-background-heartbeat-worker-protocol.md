---
ref: general/39-background-heartbeat-worker-protocol
feature: general
priority: high
status: done
depends_on:
  - general/38-auto-ack-run-start-and-extend-timeout
---

# Task 39 — Background Heartbeat Loop in Worker Protocol

Depends on Task 38. Blocks nothing.

## Scope

**In scope:**
- Add a required background heartbeat loop to the worker protocol in `AGENTS.md`
- Add the background heartbeat pattern to the worker session bootstrap template so every new worker session starts it automatically
- Document how to kill the background process before `orc run-finish` / `orc run-fail`

**Out of scope:**
- Changes to coordinator heartbeat enforcement logic or lease duration
- Changes to `orc run-heartbeat` CLI behaviour
- Any coordinator-side changes (covered by task 38)

---

## Context

Workers are required to call `orc run-heartbeat` every 5 minutes throughout all work phases. The claim lease is 30 minutes; missing heartbeats causes the coordinator to expire and requeue the task.

In practice, a worker cannot call heartbeat while it is blocked inside a long-running Bash tool call (e.g. `npm test`, `git rebase`, a compilation step). The tool call occupies the agent's attention — there is no way to interleave a heartbeat call until the tool returns.

The solution: start a background shell process immediately after `orc run-start` that fires `orc run-heartbeat` on a timer. Because the Bash tool's shell state (including background processes) persists across tool calls within the same PTY session, the background process keeps firing even while Claude is blocked in a long tool call. This guarantees the lease is renewed regardless of what the worker is doing.

Task 38 eliminates the `ERR_RUN_START_TIMEOUT` kill cycle; this task eliminates the analogous risk during the `in_progress` phase (lease expiry from missed heartbeats during long work).

### Current state

- `AGENTS.md` requires manual heartbeat calls at specific call sites (before sub-agents, before rebase, before `run-work-complete`, every 5 min while waiting)
- No background process pattern exists in the protocol or bootstrap template
- Workers doing long tool calls can silently miss the 5-minute window

### Desired state

- Immediately after `orc run-start`, the worker starts a background heartbeat loop
- The loop fires every 270 seconds (4.5 min), well within the 5-minute requirement and the 30-minute lease
- The worker kills the background process before emitting `orc run-finish` or `orc run-fail`
- `AGENTS.md` documents this as a required step
- The bootstrap template injects the pattern into every new session's TASK_START payload so workers see it as part of the mandatory startup sequence

### Start here

- `AGENTS.md` — "Worker lifecycle" and "Heartbeat requirement" sections
- `lib/sessionBootstrap.ts` (or equivalent) — the file that generates the TASK_START payload injected into PTY sessions; this is where the heartbeat loop snippet should be embedded

**Affected files:**
- `AGENTS.md` — heartbeat requirement section updated with background loop pattern
- `lib/sessionBootstrap.ts` (or equivalent template file) — TASK_START payload updated to include the background heartbeat snippet

---

## Goals

1. Must: `AGENTS.md` documents the background heartbeat loop as a required step immediately after `orc run-start`.
2. Must: `AGENTS.md` documents killing the background process (`kill $HEARTBEAT_PID`) before `orc run-finish` and `orc run-fail`.
3. Must: The worker bootstrap TASK_START template includes the heartbeat loop snippet in the mandatory startup sequence shown to the worker.
4. Must: The heartbeat interval in the snippet is 270 seconds (4.5 min) — safely under the 5-minute requirement.
5. Must: The snippet captures the PID (`HEARTBEAT_PID=$!`) for clean termination.
6. Must: `npm test` passes (template/doc change only — no logic changes expected to break tests).

---

## Implementation

### Step 1 — Update `AGENTS.md` heartbeat section

Replace the current "Heartbeat requirement" section's manual call-site list with the background loop pattern as the **primary** mechanism, keeping the manual call sites as fallback guidance for cases where the background process unexpectedly dies.

Add immediately after the `orc run-start` step:

```bash
# Start background heartbeat — keeps lease alive during long tool calls
while true; do sleep 270; orc run-heartbeat --run-id=<run_id> --agent-id=<agent_id>; done &
HEARTBEAT_PID=$!
```

Add before `orc run-finish` / `orc run-fail`:

```bash
# Stop background heartbeat
kill $HEARTBEAT_PID 2>/dev/null || true
```

### Step 2 — Embed the snippet in the TASK_START bootstrap template

Find where the TASK_START payload is constructed for injection into new worker sessions (likely `lib/sessionBootstrap.ts` or a template string). Add the background heartbeat loop to the mandatory startup sequence shown to the worker, replacing the placeholder variable names with the actual `run_id` and `agent_id` values from the claim.

The snippet in the template should use the real values:

```
# After orc run-start, immediately start background heartbeat:
while true; do sleep 270; orc run-heartbeat --run-id=<ACTUAL_RUN_ID> --agent-id=<ACTUAL_AGENT_ID>; done &
HEARTBEAT_PID=$!
# Store HEARTBEAT_PID — kill it before orc run-finish or orc run-fail
```

---

## Acceptance criteria

- [ ] `AGENTS.md` "Heartbeat requirement" section includes the background loop pattern with correct interval (270s) and PID capture.
- [ ] `AGENTS.md` includes `kill $HEARTBEAT_PID` in the finish/fail section.
- [ ] The TASK_START template injected into new sessions includes the background heartbeat snippet with the actual `run_id` and `agent_id` substituted.
- [ ] `npm test` passes.
- [ ] `orc backlog-sync-check` passes.

---

## Tests

No new test files required — this is a documentation and template change. Verify manually by inspecting the TASK_START payload generated for a test dispatch and confirming the snippet appears with correct values substituted.

---

## Verification

```bash
nvm use 24 && npm test
orc backlog-sync-check
```
