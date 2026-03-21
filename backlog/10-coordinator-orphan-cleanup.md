---
ref: general/10-coordinator-orphan-cleanup
feature: general
priority: normal
status: blocked
---

# Task 10 — Add Coordinator Startup Orphan Session Cleanup

Depends on Task 7. Blocks Task 13.

## Scope

**In scope:**
- `coordinator.ts`: add orphan tmux session cleanup at startup initialization (before first tick)
- `coordinator.ts`: clear stale `pty:` prefixed `session_handle` values from `agents.json` at startup
- Both cleanup steps execute once during startup and are otherwise silent

**Out of scope:**
- Adding tmux to preflight/doctor checks (Task 12)
- Any changes to `adapters/tmux.ts`, `adapters/index.ts`, or CLI files
- Removing `pty-logs/` or `pty-pids/` directories (Task 13)

---

## Context

With node-pty, session lifetime was tied to the coordinator process — a coordinator restart always started fresh. With tmux, sessions are externally managed and survive coordinator crashes. Two cleanup problems arise on restart:

1. **Orphan tmux sessions**: `orc-*` tmux sessions left by a previous coordinator run that no longer correspond to active agents. These must be killed to avoid accumulation.
2. **Stale pty: handles**: `agents.json` entries from before the migration may have `session_handle: "pty:..."`. These are permanently dead; the agents must be reset to `idle` so they can receive new sessions.

### Current state

`coordinator.ts` has no orphan cleanup at startup. If a previous run left tmux sessions, they persist indefinitely. After migration, any `pty:`-prefixed handles in `agents.json` would cause `heartbeatProbe` to return false, triggering repeated failed relaunch attempts.

### Desired state

On coordinator startup:
1. All `orc-*` tmux sessions not corresponding to a `running` agent in `agents.json` are killed.
2. All agents with a `session_handle` starting with `pty:` are reset to `status: 'idle'`, `session_handle: null`.

### Start here

- `coordinator.ts` — find the startup initialization block (before first coordinator tick); read surrounding context to understand where to insert
- `lib/agentRegistry.ts` — `listAgents`, `updateAgentRuntime` for reading/resetting agent state
- `lib/workerRuntime.ts` — `clearWorkerSessionRuntime` for the idle reset pattern

**Affected files:**
- `coordinator.ts` — startup initialization block

---

## Goals

1. Must kill every tmux session named `orc-{agentId}` where no agent in `agents.json` has `status: 'running'` and `session_handle: 'tmux:{agentId}'`.
2. Must reset every agent whose `session_handle` starts with `pty:` to `status: 'idle'`, `session_handle: null` via `clearWorkerSessionRuntime`.
3. Must not kill sessions belonging to currently active agents.
4. Must be a no-op and not throw when `tmux` is not running or no `orc-*` sessions exist.
5. Must log killed sessions and reset agents at `info` level (or equivalent coordinator logging).

---

## Implementation

### Step 1 — Add `cleanupOrphanSessions` function

**File:** `coordinator.ts`

```ts
async function cleanupOrphanSessions(stateDir: string): Promise<void> {
  // 1. Clear stale pty: handles from before migration
  const agents = listAgents(stateDir);
  for (const agent of agents) {
    if (typeof agent.session_handle === 'string' && agent.session_handle.startsWith('pty:')) {
      clearWorkerSessionRuntime(stateDir, agent, { status: 'idle' });
      log(`startup: reset stale pty handle for ${agent.agent_id}`);
    }
  }

  // 2. Kill orphan tmux sessions
  let sessionLines: string;
  try {
    sessionLines = execFileSync('tmux', ['ls', '-F', '#{session_name}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return; // tmux not running or no sessions — nothing to do
  }

  const activeHandles = new Set(
    agents
      .filter(a => a.status === 'running' && typeof a.session_handle === 'string')
      .map(a => a.session_handle as string)
  );

  for (const line of sessionLines.split('\n').map(l => l.trim()).filter(Boolean)) {
    const match = line.match(/^orc-(.+)$/);
    if (!match) continue;
    const agentId = match[1];
    if (!activeHandles.has(`tmux:${agentId}`)) {
      try {
        execFileSync('tmux', ['kill-session', '-t', line],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        log(`startup: killed orphan tmux session ${line}`);
      } catch { /* already gone */ }
    }
  }
}
```

### Step 2 — Call at startup

**File:** `coordinator.ts`

In the startup initialization block, before the first coordinator tick fires:

```ts
await cleanupOrphanSessions(STATE_DIR);
```

Import `execFileSync` from `node:child_process` at the top of `coordinator.ts` if not already imported. Import `listAgents` from `./lib/agentRegistry.ts` and `clearWorkerSessionRuntime` from `./lib/workerRuntime.ts` if not already imported.

Invariant: the cleanup must run before any `ensureSessionReady` call that might try to reuse a stale handle.

---

## Acceptance criteria

- [ ] On startup, tmux sessions named `orc-{agentId}` for agents not in `running` state are killed.
- [ ] On startup, agents with `session_handle: 'pty:...'` are reset to `status: 'idle'`, `session_handle: null`.
- [ ] Active running agents' sessions are not killed.
- [ ] Startup completes without error when no `orc-*` sessions exist.
- [ ] Startup completes without error when tmux is not installed or has no server running.
- [ ] Killed sessions and reset agents are logged.
- [ ] `npm test` passes.
- [ ] No changes to files outside `coordinator.ts`.

## Risk / Rollback

**Risk:** A bug in the active-handle check could kill sessions belonging to genuinely active agents, causing running tasks to fail. Verify the `activeHandles` Set construction against the actual agents.json format before deploying.

**Rollback:** `git restore coordinator.ts && npm test`

---

## Tests

The cleanup function uses `execFileSync` which can be mocked in unit tests. Add to the coordinator test file (or create `coordinator.startup.test.ts`):

```ts
it('cleanupOrphanSessions kills orc-* sessions not in active agents', () => { ... });
it('cleanupOrphanSessions resets agents with pty: handles to idle', () => { ... });
it('cleanupOrphanSessions is a no-op when tmux ls throws', () => { ... });
it('cleanupOrphanSessions does not kill sessions for running agents', () => { ... });
```

---

## Verification

```bash
# Confirm cleanup logic present
grep -n "cleanupOrphan\|pty:" coordinator.ts | head -20

# Smoke: start coordinator, confirm no orc-* sessions from prior run survive
# (manual — requires a prior crashed run with orphan sessions)

nvm use 24 && npm test
```
