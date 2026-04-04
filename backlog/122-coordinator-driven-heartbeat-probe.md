---
ref: publish/122-coordinator-driven-heartbeat-probe
feature: publish
priority: high
status: done
---

# Task 122 — Coordinator-Driven Heartbeat Probe

Independent.

## Scope

**In scope:**
- Replace worker-emitted background heartbeat loop with coordinator-driven PTY PID probing
- Update coordinator tick loop to probe session liveness via `heartbeatProbe()`
- Mark sessions dead and expire claims when PTY PID is gone
- Update worker bootstrap template to remove the background heartbeat loop
- Update AGENTS.md heartbeat documentation

**Out of scope:**
- Changing the heartbeat event schema or SQLite storage
- Changing the lease duration or expiry logic
- Changing how manual heartbeat calls work (workers can still call `orc run-heartbeat` at key points)
- Finalization flow changes (separate concern)

---

## Context

### Current state

Workers start a background shell loop immediately after `orc run-start`:

```bash
while true; do sleep 60; orc run-heartbeat --run-id=<id> --agent-id=<id>; done &
HEARTBEAT_PID=$!
```

This loop runs as a **separate process** from the PTY session. When the PTY dies
(crash, cleanup, environment issue), the background loop continues heartbeating.
The coordinator sees fresh heartbeats and believes the worker is alive, but cannot
communicate with it. This creates zombie workers that hold claims indefinitely
until the lease timeout.

The coordinator already has `heartbeatProbe()` in `adapters/pty.ts:405-430` which
checks if the PTY PID is alive via `process.kill(pid, 0)`. This is authoritative —
if the PID is dead, the session is dead. But this probe is not used as the primary
liveness mechanism.

### Desired state

The coordinator probes each active worker's PTY PID on every tick (or every N ticks).
If the PID is dead:
1. Mark the agent offline
2. Expire the claim and requeue the task
3. Clean up session state

The background heartbeat loop is removed from the worker bootstrap. Workers may still
emit manual heartbeats at key lifecycle points (before reviewers, before rebase) as
a protocol signal, but liveness is determined by the coordinator, not by the worker.

### Start here

- `adapters/pty.ts` lines 405-430 — existing `heartbeatProbe()` implementation
- `coordinator.ts` — tick loop, claim expiry logic
- `templates/worker-bootstrap-v2.txt` — background heartbeat loop definition

**Affected files:**
- `coordinator.ts` — add PID probe to tick loop, act on dead sessions
- `adapters/pty.ts` — `heartbeatProbe()` may need minor adjustments
- `templates/worker-bootstrap-v2.txt` — remove background heartbeat loop instructions
- `templates/master-bootstrap-v1.txt` — update heartbeat documentation if referenced
- `AGENTS.md` — update heartbeat requirement section

---

## Goals

1. Must probe each active worker's PTY PID on the coordinator tick loop
2. Must mark agent offline and expire claim when PTY PID is dead
3. Must remove the background heartbeat loop from worker bootstrap template
4. Must preserve manual heartbeat calls at key lifecycle points (protocol signal, not liveness)
5. Must update AGENTS.md heartbeat section to reflect coordinator-driven model
6. Must not change heartbeat event schema or lease duration

---

## Implementation

### Step 1 — Add PID probe to coordinator tick loop

**File:** `coordinator.ts`

In the main tick function, after processing claims, iterate active agents with
sessions and call `adapter.heartbeatProbe(agent.session_handle)`. If probe returns
false, call existing cleanup: mark agent offline, expire claim, requeue task.

### Step 2 — Remove background heartbeat loop from worker bootstrap

**File:** `templates/worker-bootstrap-v2.txt`

Remove the `while true; do sleep 60; orc run-heartbeat; done &` instructions and
the `kill $HEARTBEAT_PID` cleanup. Keep manual heartbeat calls at key points
(before reviewers, before rebase, before run-work-complete).

### Step 3 — Update AGENTS.md

**File:** `AGENTS.md`

Rewrite the "Heartbeat requirement" section. The coordinator now drives liveness
checks. Workers emit heartbeats as protocol signals at key lifecycle points but
are not responsible for keeping the lease alive.

---

## Acceptance criteria

- [ ] Coordinator probes PTY PID for each active worker on tick
- [ ] Dead PTY PID triggers agent offline + claim expiry + task requeue
- [ ] Background heartbeat loop removed from worker bootstrap
- [ ] Manual heartbeat calls preserved at key lifecycle points
- [ ] AGENTS.md heartbeat section updated
- [ ] `npm test` passes
- [ ] No zombie workers when PTY session dies

---

## Tests

Add to coordinator tests:

```typescript
it('expires claim when heartbeatProbe returns false for active worker', () => { ... });
it('does not expire claim when heartbeatProbe returns true', () => { ... });
```

---

## Verification

```bash
npx vitest run coordinator.test.ts
```

```bash
nvm use 24 && npm test
```
