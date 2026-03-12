# Task 60 — Master Foreground Session in `orc-start-session`

Depends on Task 59 (binaryCheck utility). Independent of Tasks 61–63.

---

## Scope

**In scope:**
- `cli/start-session.mjs` — spawn the master's CLI binary as a foreground interactive session after the coordinator is started
- `cli/start-session.test.mjs` — update and add tests

**Out of scope:**
- `adapters/pty.mjs` — master does NOT use node-pty. The foreground session is a plain `spawn` with `stdio: 'inherit'`; the user's terminal becomes the CLI session directly.
- Coordinator logic — coordinator already filters out master from dispatch by role
- Bootstrap delivery — the master session starts the CLI normally with no injected system prompt (the user is the master operator and is informed by next-step hints printed before the CLI starts)

---

## Context

### Architecture

With the pty migration, workers run as PTY child processes owned by the coordinator. The master is different: the master IS the human operator running the orchestrator. `orc-start-session` should:

1. Register the master agent in `agents.json`
2. Perform a binary check for the chosen provider (Task 59)
3. Start the coordinator in the background (existing)
4. Print next-step hints
5. Spawn the provider's CLI binary as a **foreground process with `stdio: 'inherit'`**
   — the user's current terminal becomes the Claude / Codex / Gemini session
6. When the CLI exits (user ends the session), mark master as `offline`

The key difference from workers:
- **Workers**: `node-pty` spawned by the coordinator; output logged to file
- **Master**: `spawn(binary, [], { stdio: 'inherit' })` called by `orc-start-session`; user types directly in the CLI

### Why `stdio: 'inherit'` and not `node-pty`

`node-pty` creates a synthetic PTY. For the master, we want the user's actual terminal to be the CLI session — `stdio: 'inherit'` passes stdin/stdout/stderr directly to the child process. This is simpler and gives full interactive fidelity (arrow keys, colours, tab completion) without any proxying.

### Session handle for master

Set `session_handle: null` — master is the foreground operator. The coordinator filters master out of dispatch by `role === 'master'`, not by `session_handle`. Setting a handle would imply the coordinator manages it, which it does not.

### Runtime status while running

Call `updateAgentRuntime` twice:
1. Before spawning: `status: 'running'`
2. After CLI exits: `status: 'offline'`, `session_handle: null`, `last_status_change_at: now`

### Conflict gate interaction

The conflict gate (Task 49) already handles the case where a master is already registered. No changes needed there.

**Affected files:**
- `cli/start-session.mjs`
- `cli/start-session.test.mjs`

---

## Goals

1. After the coordinator starts, `orc-start-session` performs a binary check via `checkAndInstallBinary(master.provider)`. If the binary is unavailable and the user declines installation, exit 1.
2. The master's CLI binary is spawned with `stdio: 'inherit'` — the terminal becomes the CLI session.
3. `agents.json` shows master `status: 'running'` while the session is active and `status: 'offline'` after it exits.
4. If the master already has `status: 'running'` (conflict gate chose `reuse`): skip spawning, just print a message. (The `reuse` path already exits — this is a safeguard.)
5. The binary check message clearly tells the user the install will use npm so they can cancel for Homebrew.
6. `npm run test:orc:unit` passes.

---

## Implementation

### Step 1 — Update imports in `cli/start-session.mjs`

Add `updateAgentRuntime` back to the agentRegistry import (removed in Task 53):

```js
import { listAgents, registerAgent, getAgent, removeAgent, updateAgentRuntime } from '../lib/agentRegistry.mjs';
```

Add the binaryCheck import:

```js
import { checkAndInstallBinary, PROVIDER_BINARIES } from '../lib/binaryCheck.mjs';
```

### Step 2 — Replace the current coordinator + hints block

Find the current block (after the registration block):

```js
// ── Coordinator ──────────────────────────────────────────────────────
// Master has session_handle: null — your terminal IS the master session.
// The coordinator manages all worker PTY sessions.

const { running, pid: existingPid } = coordinatorStatus();
if (running) {
  console.log(`✓ Coordinator already running  (PID ${existingPid})`);
} else {
  console.log('Starting coordinator...');
  const newPid = await spawnCoordinator();
  console.log(newPid
    ? `✓ Coordinator running  (PID ${newPid})`
    : '  Coordinator spawned (PID confirmation pending)');
}

console.log('\n✓ Your terminal is the master. The coordinator will start worker PTY sessions.');
console.log('\nNext steps:');
console.log('  Register workers:   orc-worker-register <id> --provider=<claude|codex|gemini>');
console.log('  Start workers:      orc-worker-start-session <id>');
console.log('  Create tasks:       orc-task-create --epic=project --ref=<ref> --title="..."');
console.log('  Monitor:            orc-watch');
```

Replace with:

```js
// ── Binary check ──────────────────────────────────────────────────────────

const binaryOk = await checkAndInstallBinary(master.provider);
if (!binaryOk) {
  console.error(`Cannot start master session: '${PROVIDER_BINARIES[master.provider]}' binary not available.`);
  process.exit(1);
}

// ── Coordinator ───────────────────────────────────────────────────────────

const { running, pid: existingPid } = coordinatorStatus();
if (running) {
  console.log(`✓ Coordinator already running  (PID ${existingPid})`);
} else {
  console.log('Starting coordinator...');
  const newPid = await spawnCoordinator();
  console.log(newPid
    ? `✓ Coordinator running  (PID ${newPid})`
    : '  Coordinator spawned (PID confirmation pending)');
}

// ── Master foreground session ─────────────────────────────────────────────

const binary = PROVIDER_BINARIES[master.provider];

console.log(`\n✓ Starting ${master.provider} CLI as master session...`);
console.log('  (Workers are managed in the background by the coordinator.)');
console.log('  Register workers: orc-worker-register <id> --provider=<provider>');
console.log('  Create tasks:     orc-task-create --epic=project --ref=<ref> --title="..."\n');

const now = new Date().toISOString();
updateAgentRuntime(STATE_DIR, master.agent_id, {
  status:               'running',
  last_heartbeat_at:    now,
  last_status_change_at: now,
});

// Spawn the CLI with full terminal access — the user types directly in this session.
const { spawn: spawnFg } = await import('node:child_process');
const cli = spawnFg(binary, [], { stdio: 'inherit' });
await new Promise((resolve) => cli.on('close', resolve));

// Session ended — mark offline.
updateAgentRuntime(STATE_DIR, master.agent_id, {
  status:               'offline',
  last_status_change_at: new Date().toISOString(),
});
console.log('\nMaster session ended. Coordinator continues running in the background.');
console.log('  orc-status    — view system state');
console.log('  orc-watch     — monitor workers');
```

**Note:** `spawn` is already imported at the top of the file (`import { spawn } from 'node:child_process'`). Use the existing import rather than a dynamic `import()`. Rename the existing `spawn` call for coordinator to distinguish:

```js
// At the top import:
import { spawn } from 'node:child_process';

// In spawnCoordinator() (unchanged — already uses `spawn`)

// In the master session block:
const cli = spawn(binary, [], { stdio: 'inherit' });
await new Promise((resolve) => cli.on('close', resolve));
```

---

## Acceptance criteria

- [ ] `orc-start-session --provider=claude` starts the claude CLI interactively in the user's terminal after the coordinator is spawned.
- [ ] `agents.json` shows master `status: 'running'` while the CLI is active and `status: 'offline'` after exit.
- [ ] If the binary is missing and user declines install, exits 1 before spawning coordinator.
- [ ] Coordinator is NOT stopped when master CLI exits.
- [ ] `npm run test:orc:unit` passes.

---

## Tests

Update `cli/start-session.test.mjs`:

```js
describe('master foreground session', () => {
  it('spawns the provider binary with stdio:inherit', async () => { ... });
  it('marks master running before spawn and offline after close', async () => { ... });
  it('exits 1 if binary check fails', async () => { ... });
  it('does not stop coordinator after CLI exits', async () => { ... });
});
```

Mock `checkAndInstallBinary` via `vi.doMock('../lib/binaryCheck.mjs', ...)` and `spawn` via `vi.doMock('node:child_process', ...)`. The spawn mock should return `{ on: (event, cb) => { if (event === 'close') cb(0); } }` to simulate immediate exit.

---

## Verification

```bash
nvm use 24

# With binary present (claude is installed)
ORCH_STATE_DIR=/tmp/orc-smoke node cli/start-session.mjs --provider=claude --agent-id=master
# Expected: coordinator starts in background, claude CLI opens in terminal
# When claude exits: "Master session ended..." printed

# Check status while running (in another terminal):
ORCH_STATE_DIR=/tmp/orc-smoke node cli/status.mjs
# Expected: master status: running

# After exit:
# Expected: master status: offline, coordinator still in coordinator.pid
```
