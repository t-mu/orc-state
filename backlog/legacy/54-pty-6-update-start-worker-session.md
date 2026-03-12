# Task 54 — Update `cli/start-worker-session.mjs`

Depends on Task 52 (pty adapter active). Blocks Task 58.

---

## Scope

**In scope:**
- `cli/start-worker-session.mjs` — remove tmux prerequisite guard and the `adapter.start()` session creation block; update output messages

**Out of scope:**
- `lib/agentRegistry.mjs` — do not modify
- `adapters/` — do not modify
- Coordinator logic — do not modify
- `cli/start-session.mjs` — modified in Tasks 49 and 53

---

## Context

### Current behaviour

`orc-worker-start-session bob` currently:
1. Registers bob if not found
2. Calls `assertTmuxSessionExists()` — verifies `tmux has-session -t orc` (requires tmux)
3. Calls `adapter.start('bob', { system_prompt })` — creates a tmux window and sends bootstrap

### Why this changes

With the pty adapter, all PTY sessions are owned by the coordinator. If the CLI creates a PTY, the PTY master fd belongs to the CLI process. When the CLI exits, the PTY slave receives SIGHUP (the CLI binary dies). The coordinator then starts and finds the session dead → recreates it anyway.

The correct flow is: CLI registers the agent, coordinator creates the PTY on its first tick via `ensureSessionReady()`.

### What changes

- Remove `assertTmuxSessionExists()` (requires `tmux has-session`, which is no longer needed)
- Remove `execFileSync` import (only used by the now-deleted tmux guard)
- Remove the `if (!worker.session_handle)` session creation block
- Keep the existing-session liveness check (`heartbeatProbe`) — the pty adapter's PID file fallback makes this cross-process-safe (CLI can check if coordinator's PTY process is alive)
- Update output messages

### Existing-session liveness check (keep this logic)

The script checks if the worker already has a `session_handle`. If so:
- `heartbeatProbe()` → alive + `--force-rebind` → `adapter.stop()` + clear handle
- `heartbeatProbe()` → dead → clear handle
- `heartbeatProbe()` → alive + no rebind → update heartbeat, log "session already live"

With the pty adapter, `heartbeatProbe()` falls back to the PID file when the coordinator's sessions Map is not available (cross-process CLI call). This is correct — the CLI can still check if the agent's PTY process is alive.

**Affected files:**
- `cli/start-worker-session.mjs`

---

## Goals

1. Must remove `assertTmuxSessionExists()` and its `execFileSync('tmux', ...)` call.
2. Must remove the `import { execFileSync }` import line.
3. Must remove the `if (!worker.session_handle)` session creation block (the `assertTmuxSessionExists()` call + `adapter.start()` call + the `updateAgentRuntime` call inside it).
4. Must print a clear message telling the user the coordinator will create the session on its next tick.
5. Must preserve the existing-session liveness check (the `heartbeatProbe` logic).
6. Must preserve the `--force-rebind` path (`adapter.stop()` + clear handle).
7. Output messages referencing tmux (e.g. "Attach: tmux attach-session ...") must be removed or replaced.

---

## Implementation

### Step 1 — Remove `execFileSync` import

```js
// REMOVE this entire line:
import { execFileSync } from 'node:child_process';
```

### Step 2 — Remove `assertTmuxSessionExists` function

Delete the entire function:

```js
// REMOVE:
function assertTmuxSessionExists() {
  const sessionName = process.env.ORCH_TMUX_SESSION ?? 'orc';
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
  } catch {
    console.error(`Error: tmux session '${sessionName}' not found.`);
    console.error(`Create it first:\n\n  tmux new-session -s ${sessionName} -d\n`);
    console.error('Then re-run this command.');
    console.error('Set ORCH_TMUX_SESSION=<name> to use a different session name.');
    process.exit(1);
  }
}
```

### Step 3 — Remove session creation block and update output

Find the block at the bottom of the script:

```js
if (!worker.session_handle) {
  assertTmuxSessionExists();
  console.log('Starting session...');
  const { session_handle, provider_ref } = await adapter.start(worker.agent_id, {
    system_prompt: buildSessionBootstrap(worker.agent_id, worker.provider, worker.role),
  });
  const sessionName = process.env.ORCH_TMUX_SESSION ?? 'orc';
  console.log(`Worker session started: ${session_handle}`);
  console.log(`Attach: tmux attach-session -t ${sessionName} (select window '${worker.agent_id}')`);
  const now = new Date().toISOString();
  updateAgentRuntime(STATE_DIR, worker.agent_id, {
    status: 'running',
    session_handle,
    provider_ref,
    last_heartbeat_at: now,
    last_status_change_at: now,
  });
  worker.session_handle = session_handle;
}
```

Replace with:

```js
if (!worker.session_handle) {
  console.log(`Agent '${worker.agent_id}' registered (${worker.provider}). Coordinator will start session on next tick.`);
  console.log(`Use: orc-watch     — monitor until session appears`);
  console.log(`Use: orc-attach ${worker.agent_id}  — view agent output once running`);
}
```

### Step 4 — Remove tmux attach hint from alive-session path

Find the line inside the `else` branch (session alive, no rebind):

```js
// REMOVE if present:
console.log(`Attach: tmux attach-session -t ${sessionName} (select window '${worker.agent_id}')`);
```

Replace the final status lines with:

```js
console.log(`Session ready: ${worker.session_handle}`);
console.log(`Use: orc-attach ${worker.agent_id}  — view agent output`);
```

### Step 5 — Check for now-unused imports

After the above changes, check whether `buildSessionBootstrap` is still imported. If it was only used in the removed `adapter.start()` call, remove its import:

```js
// REMOVE if unused:
import { buildSessionBootstrap } from '../lib/sessionBootstrap.mjs';
```

---

## Acceptance criteria

- [ ] `orc-worker-start-session bob --provider=claude` no longer requires tmux to be installed.
- [ ] Running the command registers the agent in `agents.json` with `session_handle: null`.
- [ ] `adapter.start()` is never called by the script.
- [ ] `assertTmuxSessionExists` and `execFileSync` are gone from the file.
- [ ] The `--force-rebind` path still calls `adapter.stop()` correctly.
- [ ] `npm run lint` passes (no unused imports).
- [ ] No other files are modified.

---

## Tests

Add to `cli/start-worker-session.test.mjs` (if it exists; otherwise follow pattern of `register-worker.test.mjs`):

```js
it('registers worker with session_handle null — no adapter.start() called', async () => { ... });
it('--force-rebind calls adapter.stop() and clears handle', async () => { ... });
it('does not fail when tmux is not installed', async () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm run lint
npm run test:orc:unit

# Smoke — no tmux required
ORCH_STATE_DIR=/tmp/orc-smoke \
  node cli/start-worker-session.mjs bob --provider=claude
# Expected: registers bob, prints coordinator-will-start message, exits 0

cat /tmp/orc-smoke/agents.json | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.agents.find(a=>a.agent_id==='bob').session_handle);
"
# Expected: null
```
