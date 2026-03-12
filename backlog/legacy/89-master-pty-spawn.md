# Task 89 — Spawn Master Claude Session via node-pty

Independent. Blocks Tasks 90 and 91.

## Scope

**In scope:**
- `cli/start-session.mjs` — replace `child_process.spawn` master launch with `node-pty`; bridge stdin/stdout; write/remove `pty-pids/master.pid`

**Out of scope:**
- Coordinator, worker dispatch, or any agent registry logic
- Codex/Gemini provider branches — only the Claude master spawn path
- Worker PTY adapter (`adapters/pty.mjs`) — read for reference only

---

## Context

The master Claude session is currently started with `spawn(binary, spawnArgs, { stdio: 'inherit' })`.
Once the child owns the terminal, there is no way for the coordinator to inject text into it.
The combined notification architecture (Tasks 90–93) requires a `masterPty` reference so the
in-process forwarder can call `masterPty.write(text)` to deliver `TASK_COMPLETE` blocks.

`node-pty` is already a project dependency (used by `adapters/pty.mjs`).

**Affected files:**
- `cli/start-session.mjs` — lines 317–395, master spawn block

---

## Goals

1. Must launch the Claude CLI as a node-pty child; user experience must be identical to before.
2. Must bridge `process.stdin` (raw mode) → PTY and PTY output → `process.stdout`.
3. Must forward terminal resize events to the PTY.
4. Must expose the `IPty` instance as a module-level variable accessible to code running in the same process.
5. Must write `orc-state/pty-pids/master.pid` on startup and remove it on exit.
6. Must restore `process.stdin` raw mode and update agent runtime to `status: 'offline'` on PTY exit.
7. Must pass existing `--mcp-config` and `--system-prompt` args to the Claude binary unchanged.

---

## Implementation

### Step 1 — Add node-pty import and module-level reference

**File:** `cli/start-session.mjs`

Add at the top with other imports:

```js
import pty from 'node-pty';

// Exposed so in-process modules (PTY forwarder) can inject text.
export let masterPty = null;
```

### Step 2 — Replace `spawn` block with node-pty spawn

**File:** `cli/start-session.mjs`

Replace the current block (beginning at `const cli = spawn(binary, spawnArgs, { stdio: 'inherit' })`):

```js
// Ensure pty-pids dir exists (shared with worker adapter convention)
mkdirSync(join(STATE_DIR, 'pty-pids'), { recursive: true });

const ptyProcess = pty.spawn(binary, spawnArgs, {
  name: 'xterm-256color',
  cols: process.stdout.columns ?? 220,
  rows: process.stdout.rows   ?? 50,
  cwd:  process.cwd(),
  env:  process.env,
});
masterPty = ptyProcess;

// PTY output → terminal
ptyProcess.onData((data) => process.stdout.write(data));

// Terminal keystrokes → PTY
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => ptyProcess.write(d));

// Resize forwarding
process.stdout.on('resize', () =>
  ptyProcess.resize(process.stdout.columns, process.stdout.rows));

// PID file (cross-process heartbeat convention)
writeFileSync(join(STATE_DIR, 'pty-pids', 'master.pid'), String(ptyProcess.pid));

// Wait for exit
const exitResult = await new Promise((resolve) =>
  ptyProcess.onExit(({ exitCode, signal }) => resolve({ exitCode, signal })));

// Cleanup
try { process.stdin.setRawMode(false); } catch { /* non-TTY */ }
try { unlinkSync(join(STATE_DIR, 'pty-pids', 'master.pid')); } catch { /* already gone */ }
masterPty = null;
```

Replace the three `cliResult` if/else branches with a single cleanup call:

```js
updateAgentRuntime(STATE_DIR, master.agent_id, {
  status: 'offline',
  session_handle: null,
  provider_ref:   null,
  last_status_change_at: new Date().toISOString(),
});
if (exitResult.exitCode !== 0) {
  console.error(
    `Master provider CLI '${binary}' exited with code ${exitResult.exitCode ?? 'null'}` +
    (exitResult.signal ? ` (signal ${exitResult.signal})` : ''),
  );
} else {
  console.log('\nMaster session ended. Coordinator continues running in the background.');
}
```

### Step 3 — Add missing imports

**File:** `cli/start-session.mjs`

Ensure `mkdirSync`, `unlinkSync`, `writeFileSync` are in the `node:fs` import (they may already be present).

---

## Acceptance criteria

- [ ] Claude CLI launches as a node-pty child; user sees a fully interactive shell identical to before.
- [ ] All keystrokes flow through to the PTY (stdin raw mode enabled).
- [ ] Terminal resize events update PTY cols/rows.
- [ ] `orc-state/pty-pids/master.pid` is written on startup and removed on clean exit.
- [ ] `process.stdin` raw mode is restored on PTY exit.
- [ ] Agent runtime is set to `status: 'offline'` on PTY exit.
- [ ] `--mcp-config` and `--system-prompt` args reach the Claude binary unchanged.
- [ ] No changes to coordinator, worker adapter, or agent registry.
- [ ] `nvm use 24 && npm test` passes.

---

## Tests

No unit tests required — the spawn path is not unit-testable without a real TTY.
Covered by manual smoke test and the integration gate in Task 91.

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
# Smoke: start a master session and confirm interactive shell opens normally
orc-start-session --provider=claude
# Expected: Claude CLI launches; typing works; orc-state/pty-pids/master.pid exists while running
```

---

## Risk / Rollback

**Risk:** Raw-mode stdin can leave the terminal in a broken state if the process crashes before `setRawMode(false)`. Mitigated by the cleanup block running on every exit path.

**Rollback:** Revert `start-session.mjs` to `child_process.spawn`. The PTY forwarder (Task 91) will fail to find `masterPty` and log a warning — no other system is affected.
