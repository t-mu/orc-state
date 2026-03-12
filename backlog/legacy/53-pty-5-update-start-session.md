# Task 53 — Update `cli/start-session.mjs` (Remove Session Creation)

Depends on Tasks 49 (conflict gate) and 52 (pty adapter active). Blocks Task 58.

---

## Scope

**In scope:**
- `cli/start-session.mjs` — remove the master session creation block and unused imports

**Out of scope:**
- `lib/prompts.mjs` — modified in Task 49; do not touch again
- `lib/agentRegistry.mjs` — do not modify
- `adapters/` — do not touch
- Coordinator logic — do not touch

---

## Context

### Why master has no PTY session

The coordinator never dispatches tasks *to* master. `selectDispatchableAgents()` filters out `role === 'master'` agents, so `ensureSessionReady()` is never called for master and no PTY is ever created for it by the coordinator. The master agent's `session_handle` stays `null`.

The user's own terminal IS the master. The user is already running a CLI session (e.g. Claude Code) and interacting with the orchestration system through it. There is no separate PTY process to create.

### What changes

Currently `start-session.mjs` does:
1. Find existing master (conflict gate — Task 49)
2. Register master if absent
3. **Create master session via `adapter.start()`** ← REMOVE THIS
4. Start coordinator
5. Print hints

After this task, step 3 is removed entirely. The coordinator starts workers automatically; master is just a registry entry. The user's terminal is the interactive master session.

### Imports that become unused after removing step 3

- `createAdapter` from `../adapters/index.mjs`
- `buildSessionBootstrap` from `../lib/sessionBootstrap.mjs`
- `updateAgentRuntime` from `../lib/agentRegistry.mjs`

These must be removed to avoid lint errors (`no-unused-vars`).

**Affected files:**
- `cli/start-session.mjs`

---

## Goals

1. Must remove the entire "Start master session" block (the `const adapter = createAdapter(...)` line, the `if (master.session_handle)` heartbeat check, and the `if (!master.session_handle)` session creation block).
2. Must remove the three imports that are no longer used: `createAdapter`, `buildSessionBootstrap`, `updateAgentRuntime`.
3. Must update the success message so it tells the user their terminal is the master and that the coordinator will start worker sessions.
4. Must preserve: the conflict gate (Task 49), the registration block, the coordinator start, and the next-step hints.
5. Must not change `coordinator.mjs` or any adapter file.

---

## Implementation

### Step 1 — Remove unused imports

Find and remove these import lines:

```js
// REMOVE:
import { createAdapter }         from '../adapters/index.mjs';
import { buildSessionBootstrap } from '../lib/sessionBootstrap.mjs';
```

And remove `updateAgentRuntime` from the agentRegistry import (keep the others: `listAgents`, `registerAgent`, `getAgent`, `removeAgent`):

```js
// before
import { listAgents, registerAgent, getAgent, updateAgentRuntime, removeAgent } from '../lib/agentRegistry.mjs';

// after
import { listAgents, registerAgent, getAgent, removeAgent } from '../lib/agentRegistry.mjs';
```

### Step 2 — Remove the session creation block

Find and delete all of the following (it follows immediately after the `if (!master)` registration block):

```js
// ── Step 5: Start master session ───────────────────────────────────────────

const adapter = createAdapter(master.provider);

if (master.session_handle) {
  const alive = await adapter.heartbeatProbe(master.session_handle);
  if (alive) {
    console.log(`✓ Master session already live  (${master.session_handle})`);
  } else {
    updateAgentRuntime(STATE_DIR, master.agent_id, {
      status:                  'offline',
      session_handle:          null,
      provider_ref:            null,
      last_status_change_at:   new Date().toISOString(),
    });
    master.session_handle = null;
  }
}

if (!master.session_handle) {
  console.log('Starting master session...');
  const { session_handle, provider_ref } = await adapter.start(master.agent_id, {
    system_prompt: buildSessionBootstrap(master.agent_id, master.provider, master.role),
  });
  const now = new Date().toISOString();
  updateAgentRuntime(STATE_DIR, master.agent_id, {
    status:                  'running',
    session_handle,
    provider_ref,
    last_heartbeat_at:       now,
    last_status_change_at:   now,
  });
  master.session_handle = session_handle;
  console.log(`✓ Master session ready  (${session_handle})`);
}
```

Replace with a single informational line:

```js
console.log(`✓ Master agent '${master.agent_id}' (${master.provider}) registered. Your terminal is the master.`);
```

### Step 3 — Update the next-step hints block

Find the final hints block at the bottom of the file and update it:

```js
// before
console.log('\nNext steps:');
console.log('  Register workers:   orc-worker-register');
console.log('  Create tasks:       orc-task-create --epic=project --ref=<ref> --title="..."');
console.log('  Monitor:            orc-watch');

// after
console.log('\nNext steps:');
console.log('  Register workers:   orc-worker-register <id> --provider=<claude|codex|gemini>');
console.log('  Start workers:      orc-worker-start-session <id>');
console.log('  Create tasks:       orc-task-create --epic=project --ref=<ref> --title="..."');
console.log('  Monitor:            orc-watch');
```

---

## Acceptance criteria

- [ ] Running `orc-start-session` does not call `adapter.start()` or `adapter.heartbeatProbe()` for the master.
- [ ] `agents.json` after the command contains a master entry with `session_handle: null`.
- [ ] The coordinator still starts (step 6 is preserved).
- [ ] `createAdapter`, `buildSessionBootstrap`, and `updateAgentRuntime` are not imported in the file.
- [ ] No lint errors (`npm run lint` passes).
- [ ] No other files are modified.

---

## Tests

Add to `cli/start-session.test.mjs`:

```js
it('registers master with session_handle null — no adapter.start() called', async () => {
  // seed agents.json with no master
  // run start-session
  // verify: agents.json has master with session_handle: null
  // verify: mock adapter's start() was never called
});
```

---

## Verification

```bash
nvm use 24 && npm run lint
npm run test:orc:unit

# Smoke check
ORCH_STATE_DIR=/tmp/orc-smoke node cli/start-session.mjs --provider=claude --agent-id=master
cat /tmp/orc-smoke/agents.json | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  console.log(d.agents.find(a=>a.role==='master').session_handle);
"
# Expected: null
```
