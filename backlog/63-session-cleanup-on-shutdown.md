---
ref: runtime-robustness/63-session-cleanup-on-shutdown
title: "Stop all managed PTY sessions during coordinator shutdown"
status: done
feature: runtime-robustness
task_type: implementation
priority: normal
depends_on:
  - runtime-robustness/58-db-connection-cleanup
---

# Task 63 — Stop All Managed PTY Sessions During Coordinator Shutdown

Depends on Task 58 (DB cleanup is also in doShutdown — sequence matters).

## Scope

**In scope:**
- In `doShutdown()`, iterate all registered agents and stop their PTY sessions.
- Use `adapterOwnsSession()` to only stop sessions owned by this coordinator process.
- Best-effort — individual stop failures must not block shutdown.

**Out of scope:**
- Changes to adapter `stop()` implementation.
- Adding force-kill escalation (SIGKILL after timeout).
- Cleaning up worktrees during shutdown.

---

## Context

### Current state

`doShutdown()` in `coordinator.ts` stops the tick timer, waits for the current tick, emits `coordinator_stopped`, and exits. It does NOT stop worker PTY sessions. Orphaned processes continue consuming resources until OS reaps them or the next coordinator startup detects stale PIDs.

### Desired state

During shutdown, all managed PTY sessions owned by this coordinator are explicitly stopped before exit. This releases PTY file descriptors, terminates worker processes, and prevents orphaned sessions from consuming resources between coordinator restarts.

### Start here

- `coordinator.ts` — `doShutdown()` function
- `adapters/pty.ts` — `stop()` method, `adapterOwnsSession()` function

**Affected files:**
- `coordinator.ts` — add session cleanup loop in `doShutdown()`

---

## Goals

1. Must iterate all registered agents with active `session_handle`.
2. Must only stop sessions owned by this coordinator process (via `adapterOwnsSession()`).
3. Must be best-effort — one failed stop must not prevent stopping other sessions.
4. Must log warnings for stop failures.
5. Must run before `coordinator_stopped` event emission but after tick completion.
6. Must not increase shutdown time by more than 5 seconds total.

---

## Implementation

### Step 1 — Add session cleanup to doShutdown()

**File:** `coordinator.ts`

After the tick-completion wait and before the `coordinator_stopped` event emission, add:

```typescript
// Stop all managed worker PTY sessions
try {
  const agents = listCoordinatorAgents(STATE_DIR);
  for (const agent of agents) {
    if (!agent.session_handle) continue;
    try {
      const adapter = getAdapter(agent.provider);
      if (adapterOwnsSession(adapter, agent.session_handle)) {
        await adapter.stop(agent.session_handle);
        log(`stopped session for ${agent.agent_id}`);
      }
    } catch (err) {
      log(`warning: failed to stop session for ${agent.agent_id}: ${(err as Error).message}`);
    }
  }
} catch (err) {
  log(`warning: session cleanup failed: ${(err as Error).message}`);
}
```

Invariant: `adapterOwnsSession` and `getAdapter` are already available in coordinator scope.

---

## Acceptance criteria

- [ ] All managed PTY sessions are stopped during coordinator shutdown.
- [ ] Sessions not owned by this process are skipped.
- [ ] One failed stop does not prevent stopping other sessions.
- [ ] Warning logged for each stop failure.
- [ ] Coordinator still exits cleanly after session cleanup.
- [ ] `npm test` passes.
- [ ] No changes outside `coordinator.ts`.

---

## Tests

Add to coordinator e2e or unit tests:

```typescript
it('doShutdown stops all managed sessions before exit', () => { ... });
it('doShutdown continues if one session stop fails', () => { ... });
```

---

## Verification

```bash
npm test
```
