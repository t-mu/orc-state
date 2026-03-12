# Task 86 — Fix Coordinator `status` on Session Loss

Independent. Can run in parallel with Tasks 85, 87, 88.

## Scope

**In scope:**
- `coordinator.mjs` — change `status: 'running'` to `status: 'idle'` when
  clearing a stale `session_handle` after heartbeat failure
- `orchestrator/coordinator.test.mjs` (create if absent) — add invariant test

**Out of scope:**
- Any logic change to when sessions are recreated (next-tick recreation is unchanged)
- `selectDispatchableAgents` and dispatch eligibility logic
- `adapter.start()` path and its `status: 'running'` assignment (that one is correct)

---

## Context

`ensureSessionReady()` in `coordinator.mjs` (lines 130–191) probes each agent's session
before dispatch. When `heartbeatProbe()` returns `false`, the session is dead and the handle
must be cleared so the next tick can recreate it.

**The bug (lines 136–141):** the status is set to `'running'` when the handle is cleared:

```js
// current — BUG
updateAgentRuntime(STATE_DIR, agent.agent_id, {
  status: 'running',       // ← wrong: no active session
  session_handle: null,
  provider_ref: null,
  last_status_change_at: new Date().toISOString(),
});
```

The schema defines three statuses:
- `'running'` — agent has an active session (`session_handle` is non-null)
- `'idle'`    — agent is registered but has no active session
- `'offline'` — agent is unreachable; may hold an active lease

Setting `status: 'running'` with `session_handle: null` violates the invariant that
`running` implies an active session. This causes:
- Operator tooling (`orc-status`, future diagnostics) to report incorrect state
- `orc-gc-workers` skips agents with `session_handle: null`, so the wrong status persists
- Any future code that uses `status === 'running'` as a guard for session-dependent
  operations will behave incorrectly

**Why dispatch still works despite the bug:** `selectDispatchableAgents` only filters out
`status === 'offline'`, so both `'running'` and `'idle'` agents reach `ensureSessionReady`
which then handles the `session_handle: null` path correctly. The dispatch path accidentally
works — but the invariant is broken at the state layer.

**Affected files:**
- `coordinator.mjs` — `ensureSessionReady()`, line 137

---

## Goals

1. Must set `status: 'idle'` (not `'running'`) when clearing a stale session handle.
2. Must not change the status assignment on successful session start (`status: 'running'`
   at line 162 is correct and must not change).
3. Must not change when or how sessions are recreated (next-tick recreation path unchanged).
4. Must not change `markAgentOffline()` or any other status update path.
5. A new test must assert the invariant: after heartbeat failure, persisted status is `'idle'`.

---

## Implementation

### Step 1 — Change status on stale session clear

**File:** `coordinator.mjs`

In `ensureSessionReady()`, line 137, change `'running'` to `'idle'`:

```js
// Before:
updateAgentRuntime(STATE_DIR, agent.agent_id, {
  status: 'running',
  session_handle: null,
  provider_ref: null,
  last_status_change_at: new Date().toISOString(),
});

// After:
updateAgentRuntime(STATE_DIR, agent.agent_id, {
  status: 'idle',      // session dead; coordinator will recreate on next tick
  session_handle: null,
  provider_ref: null,
  last_status_change_at: new Date().toISOString(),
});
```

No other changes in this file.

---

### Step 2 — Add invariant test

**File:** `orchestrator/coordinator.test.mjs` (create if absent)

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orc-coord-test-'));
  process.env.ORCH_STATE_DIR = dir;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
});

describe('ensureSessionReady: status invariant on session loss', () => {
  it('sets status=idle (not running) when heartbeatProbe returns false', async () => {
    // Seed an agent with an active session_handle
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{
        agent_id: 'worker-01',
        provider: 'claude',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:worker-01',
        provider_ref: null,
        registered_at: new Date().toISOString(),
      }],
    }));
    writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', epics: [] }));
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
    writeFileSync(join(dir, 'events.jsonl'), '');

    // Mock adapter: heartbeatProbe returns false (session dead)
    vi.mock('../adapters/index.mjs', () => ({
      createAdapter: () => ({
        heartbeatProbe: async () => false,
        start: async () => ({ session_handle: 'pty:worker-01', provider_ref: null }),
        send: async () => '',
        stop: async () => {},
      }),
    }));

    const { tick } = await import('../coordinator.mjs');
    await tick();

    const { readJson } = await import('../lib/stateReader.mjs');
    const agents = readJson(dir, 'agents.json');
    const agent = agents.agents.find((a) => a.agent_id === 'worker-01');
    expect(agent.status).toBe('idle');
    expect(agent.session_handle).toBeNull();
  });
});
```

**Note on test isolation:** `coordinator.mjs` imports module-level singletons. Use
`vi.resetModules()` + dynamic `import()` in `beforeEach` if tests interfere with each
other. If coordinator.mjs is difficult to unit-test directly, assert the invariant via
`updateAgentRuntime` directly with a mocked call — the key invariant to verify is that
the status written is `'idle'`, not `'running'`.

---

## Acceptance criteria

- [ ] After `heartbeatProbe()` returns `false`, the persisted `status` in `agents.json` is `'idle'`.
- [ ] After `heartbeatProbe()` returns `false`, `session_handle` in `agents.json` is `null`.
- [ ] Successful `adapter.start()` still sets `status: 'running'` (line 162 unchanged).
- [ ] `markAgentOffline()` still sets `status: 'offline'` (unchanged).
- [ ] All existing coordinator and agent-registry tests pass.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs orchestrator/coordinator.test.mjs
```

---

## Verification

```bash
cd orchestrator && npm test
```
