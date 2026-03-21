---
ref: general/30-master-health-check-notification
feature: general
priority: normal
status: todo
---

# Task 30 — Queue Master-Offline Notification When Master Session Ends

Independent.

## Scope

**In scope:**
- `coordinator.ts` — add a `checkMasterHealth()` function called once per coordinator tick; if the master agent is `offline` or `dead`, queue a `MASTER_OFFLINE` notification and log prominently to stderr

**Out of scope:**
- Auto-restarting the master session (operator must run `orc start-session` manually)
- Changing how `cli/start-session.ts` marks the master offline (already correct)
- Modifying `orc master-check` CLI output format
- Sending OS-level notifications or alerts

---

## Context

When the master CLI session exits (crash, API error, timeout), `markMasterOffline()` in `cli/start-session.ts` transitions the master agent to `status: 'offline'`. The coordinator process continues running indefinitely — it still processes heartbeats, expires leases, and dispatches tasks — but no new tasks can be created or delegated because the master is gone. In a long autonomous run, this is invisible unless the operator manually checks `orc status`.

The `appendNotification` queue is already used for escalations (INPUT_REQUEST, task failure). A `MASTER_OFFLINE` entry in the same queue makes the problem discoverable without polling.

The `dedupe_key` mechanism in `masterNotifyQueue.ts` ensures only one unconsumed `MASTER_OFFLINE` entry exists at a time: once the operator runs `orc master-check` (which marks entries consumed), a fresh notification can be queued if the master goes offline again later.

### Current state

Master going offline produces:
- `markMasterOffline()` sets `status: 'offline'` in `agents.json`
- Coordinator logs nothing about the missing master
- No notification is queued; `orc master-check` shows nothing
- The coordinator continues ticking silently; the operator has no signal

### Desired state

On each coordinator tick, if the master agent's status is `offline` or `dead`:
- `appendNotification` is called with `type: 'MASTER_OFFLINE'` and `dedupe_key: 'master_offline'`
- A prominent `console.warn` is emitted to the coordinator's stderr
- `orc master-check` displays the `MASTER_OFFLINE` entry until consumed

### Start here

- `coordinator.ts` — find the main tick function and locate where per-tick health checks run (search for `processManagedSessionStartRetries` — the health check should run near the top of the tick, before dispatch)
- `coordinator.ts:36` — confirm `appendNotification` is already imported
- `lib/masterNotifyQueue.ts` — `appendNotification` and `dedupe_key` behaviour

**Affected files:**
- `coordinator.ts` — new `checkMasterHealth()` function + one call site in the tick

---

## Goals

1. Must: a new `checkMasterHealth(agents)` function is added to `coordinator.ts` that accepts the current agents array.
2. Must: the function finds the agent with `role === 'master'` and, if its status is `'offline'` or `'dead'`, calls `appendNotification` with `type: 'MASTER_OFFLINE'`.
3. Must: the notification payload includes `agent_id`, `status`, `offline_since` (ISO timestamp from `last_status_change_at` or `new Date().toISOString()` as fallback), and `dedupe_key: 'master_offline'`.
4. Must: `checkMasterHealth()` is called once per tick, before the dispatch phase.
5. Must: if no master agent is registered, the function is a no-op (does not throw).
6. Must: `console.warn` is emitted on every tick in which master is `offline` or `dead` — do NOT gate it on `appendNotification`'s return value. (`appendNotification` always returns `true` even when dedup suppresses the write, so its return value cannot distinguish "newly queued" from "already queued". Repeated per-tick warnings are the correct operator signal.)
7. Must: `npm test` passes.

---

## Implementation

### Step 1 — Add checkMasterHealth function

**File:** `coordinator.ts`

Add after the `markFinalizeBlocked` function block (or near other per-tick health helpers):

```typescript
function checkMasterHealth(agents: Agent[]): void {
  const master = agents.find((a) => a.role === 'master');
  if (!master) return;
  if (master.status !== 'offline' && master.status !== 'dead') return;

  appendNotification(STATE_DIR, {
    type: 'MASTER_OFFLINE',
    agent_id: master.agent_id,
    status: master.status,
    offline_since: master.last_status_change_at ?? new Date().toISOString(),
    dedupe_key: 'master_offline',
  });
  // Warn on every tick while master is offline — appendNotification's return value
  // cannot distinguish "newly written" from "dedup suppressed", so always warn.
  console.warn(`[coordinator] MASTER OFFLINE: agent '${master.agent_id}' is ${master.status}. Run 'orc start-session' to restore the master session.`);
}
```

### Step 2 — Call checkMasterHealth in the coordinator tick

**File:** `coordinator.ts`

In the main tick function, call `checkMasterHealth(agents)` after agents are loaded and before the dispatch phase. Locate the call to `processManagedSessionStartRetries` and insert before it (or immediately after the agents array is available):

```typescript
// Near top of tick, after agents are loaded:
checkMasterHealth(agents);
```

**Invariant:** the call must use the same `agents` array already loaded for that tick — do not issue a fresh `readAgents()` call just for this check.

---

## Acceptance criteria

- [ ] `checkMasterHealth()` function exists in `coordinator.ts` with the signature `function checkMasterHealth(agents: Agent[]): void`.
- [ ] When master status is `'offline'`, `appendNotification` is called with `type: 'MASTER_OFFLINE'` and `dedupe_key: 'master_offline'`.
- [ ] When master status is `'dead'`, same notification is queued.
- [ ] When master status is `'idle'` or `'running'`, no notification is queued.
- [ ] When no agent has `role === 'master'`, function returns without throwing.
- [ ] `console.warn` fires on every tick while master is `offline` or `dead` (not gated on `appendNotification`'s return value).
- [ ] `checkMasterHealth(agents)` is called once per tick in the main tick body.
- [ ] `npm test` passes with no regressions.
- [ ] No changes to files outside the stated scope.

---

## Tests

Add to a coordinator test file (or `lib/masterNotifyQueue.test.ts` with a mock agents array):

```typescript
it('queues MASTER_OFFLINE notification when master is offline', () => {
  const agents = [
    { agent_id: 'master', role: 'master', status: 'offline', last_status_change_at: '2026-01-01T00:00:00Z' },
  ];
  // call checkMasterHealth(agents) — if exported, or via integration
  const pending = readPendingNotifications(stateDir);
  expect(pending.some(e => e.type === 'MASTER_OFFLINE')).toBe(true);
});

it('queues only one MASTER_OFFLINE notification even when called repeatedly (dedup)', () => {
  // call checkMasterHealth twice with same offline master
  // appendNotification dedup prevents duplicate queue entries, but console.warn fires both times
  const pending = readPendingNotifications(stateDir);
  expect(pending.filter(e => e.type === 'MASTER_OFFLINE')).toHaveLength(1);
});
```

If `checkMasterHealth` is not exported (it is a module-internal function), test via integration or export it with `export` keyword for testability.

---

## Verification

```bash
grep -n 'checkMasterHealth\|MASTER_OFFLINE' coordinator.ts
# Expected: function definition + call site in tick
```

```bash
nvm use 24 && npm test
```
