# Task 51 — Create `adapters/pty.mjs`

Depends on Task 50 (node-pty installed). Blocks Tasks 52, 57.

---

## Scope

**In scope:**
- Create `adapters/pty.mjs` implementing all 5 adapter interface methods
- The adapter spawns real CLI sessions (claude, codex, gemini) as PTY child processes
- Output is streamed to per-agent log files for cross-process inspection
- PID files are written for cross-process heartbeat checks

**Out of scope:**
- `adapters/index.mjs` — wired up in Task 52
- `adapters/tmux.mjs` — deleted in Task 58
- Tests — written in Task 57
- No changes to coordinator, CLI scripts, or templates in this task

---

## Context

### Why PTY instead of tmux

tmux is an external process broker. Any process can send to any named window with `tmux send-keys`. node-pty creates PTY file descriptors owned by the spawning Node.js process — only that process can write to the PTY. This means:

- **The coordinator is the sole owner of all agent PTY sessions.** CLI tools stop creating sessions; they register agents and the coordinator creates the PTYs on its first tick.
- **No tmux prerequisite.** Users no longer need to create a tmux session before running `orc-start-session`.
- **No `ORCH_TMUX_SESSION` env var.** The coordinator process IS the session manager.

### Process lifecycle

- `start()` is called only by the coordinator's `ensureSessionReady()` function (and by test doubles in unit tests).
- On coordinator restart: the in-memory `sessions` Map is empty → `heartbeatProbe()` returns false for all agents → coordinator recreates sessions via `ensureSessionReady()`. This is correct self-healing behaviour.
- CLI tools calling `heartbeatProbe()` (e.g. `orc-attach`, `orc-worker-start-session`) use the PID file fallback path — they don't need the in-memory Map.

### Session handle format

`pty:{agentId}` — e.g. `pty:worker-01`

Simpler than the old tmux handle (`tmux:session:agentId`) because there is no tmux session name segment — the coordinator process IS the session manager.

### State written to disk

Two directories are created under `STATE_DIR` on first use:

| Path | Contents |
|---|---|
| `STATE_DIR/pty-pids/{agentId}.pid` | PID of the running CLI process — used by `heartbeatProbe()` from CLI tools |
| `STATE_DIR/pty-logs/{agentId}.log` | PTY output — used by `attach()` — truncated on each `start()` call |

### Provider → CLI binary mapping

| Provider | Binary |
|---|---|
| `claude` | `claude` |
| `codex`  | `codex`  |
| `gemini` | `gemini` |

### Interface contract (from `adapters/interface.mjs`)

All 5 methods must be present and satisfy:

1. `start(agentId, config)` → `Promise<{ session_handle, provider_ref }>`
2. `send(sessionHandle, text)` → `Promise<string>` — returns `''` (fire-and-forget)
3. `attach(sessionHandle)` → `void` — prints to stdout; never throws
4. `heartbeatProbe(sessionHandle)` → `Promise<boolean>` — never throws; returns false on any error
5. `stop(sessionHandle)` → `Promise<void>` — no-op if session not found

**Affected files:**
- `adapters/pty.mjs` — created by this task

---

## Goals

1. Must implement all 5 methods satisfying the interface contract above.
2. `start()` must spawn the CLI binary as a PTY process, stream output to the log file, write the PID file, and deliver the bootstrap prompt via `ptyProcess.write()`.
3. `send()` must write `text + '\n'` to the PTY via `ptyProcess.write()` and return `''`. Must throw if the agent is not in the in-process sessions Map (indicates a bug — coordinator must own the session).
4. `heartbeatProbe()` must check the in-process Map first; fall back to PID file when the agent is not in the Map (cross-process CLI call); return `false` on any error, never throw.
5. `attach()` must read the last 8 KB of the output log file and print it to stdout; must not throw if the file does not exist.
6. `stop()` must kill the PTY process, close the output stream, delete the PID file, and remove the agent from both Maps. Must be a no-op if the agent is not found.
7. Output log must be opened with `flags: 'w'` (truncate on each `start()` call — each new session gets a fresh log).

---

## Implementation

### Step 1 — Create `adapters/pty.mjs`

```js
/**
 * adapters/pty.mjs
 *
 * Adapter that drives real CLI agent sessions as PTY child processes.
 * No API key required. No tmux required.
 *
 * Session handle format: pty:{agentId}
 *
 * Process ownership: the coordinator is the sole owner of PTY sessions.
 * CLI tools use the PID file fallback for heartbeat checks.
 *
 * State written to STATE_DIR:
 *   pty-pids/{agentId}.pid  — PID for cross-process heartbeat
 *   pty-logs/{agentId}.log  — PTY output (truncated on each start())
 *
 * Provider → CLI binary:
 *   claude → claude
 *   codex  → codex
 *   gemini → gemini
 */
import pty from 'node-pty';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../lib/paths.mjs';

const PROVIDER_BINARIES = {
  claude: 'claude',
  codex:  'codex',
  gemini: 'gemini',
};

const OUTPUT_TAIL_BYTES = 8 * 1024; // 8 KB
const STARTUP_DELAY_MS  = 500;      // wait for CLI to initialise before sending bootstrap

function pidPath(agentId)    { return join(STATE_DIR, 'pty-pids', `${agentId}.pid`); }
function logPath(agentId)    { return join(STATE_DIR, 'pty-logs', `${agentId}.log`); }

function ensureDirs() {
  mkdirSync(join(STATE_DIR, 'pty-pids'), { recursive: true });
  mkdirSync(join(STATE_DIR, 'pty-logs'), { recursive: true });
}

/** Parse "pty:{agentId}" → agentId. Throws on malformed handle. */
function parseHandle(sessionHandle) {
  const s = String(sessionHandle);
  if (!s.startsWith('pty:') || s.length <= 4) {
    throw new Error(`Invalid pty session handle: ${sessionHandle}`);
  }
  return s.slice(4); // agentId
}

/**
 * Create a pty adapter for the given provider.
 *
 * @param {object} [options]
 * @param {'claude'|'codex'|'gemini'} [options.provider='claude']
 */
export function createPtyAdapter({ provider = 'claude' } = {}) {
  const binary = PROVIDER_BINARIES[provider] ?? provider;

  // In-process state. Only valid in the coordinator process that called start().
  const sessions       = new Map(); // agentId → IPty
  const outputStreams  = new Map(); // agentId → WriteStream

  return {
    /**
     * Spawn the CLI binary as a PTY child process.
     * Streams output to the log file. Writes PID file.
     * Delivers bootstrap via ptyProcess.write().
     */
    async start(agentId, config = {}) {
      // Teardown any pre-existing session for this agentId.
      if (sessions.has(agentId)) {
        try { sessions.get(agentId).kill(); } catch { /* already dead */ }
        try { outputStreams.get(agentId).end(); } catch { /* ignore */ }
        sessions.delete(agentId);
        outputStreams.delete(agentId);
      }

      ensureDirs();

      // Open output log — 'w' truncates so each session starts with a clean log.
      const stream = createWriteStream(logPath(agentId), { flags: 'w' });

      const ptyProcess = pty.spawn(binary, [], {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd:  process.cwd(),
        env:  process.env,
      });

      ptyProcess.onData((data) => stream.write(data));

      // Write PID file for cross-process heartbeat.
      writeFileSync(pidPath(agentId), String(ptyProcess.pid));

      sessions.set(agentId, ptyProcess);
      outputStreams.set(agentId, stream);

      // Wait for the CLI to initialise before sending the bootstrap.
      await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS));

      if (config.system_prompt) {
        ptyProcess.write(String(config.system_prompt) + '\n');
      }

      return {
        session_handle: `pty:${agentId}`,
        provider_ref: { pid: ptyProcess.pid, provider, binary },
      };
    },

    /**
     * Write text to the agent's PTY (fire-and-forget).
     * Returns '' — the coordinator does not parse the return value.
     * Throws if the agent is not in the in-process sessions Map.
     */
    async send(sessionHandle, text) {
      const agentId    = parseHandle(sessionHandle);
      const ptyProcess = sessions.get(agentId);
      if (!ptyProcess) {
        throw new Error(
          `No active pty session for agent '${agentId}'. ` +
          `The coordinator must own the session — was start() called in this process?`,
        );
      }
      ptyProcess.write(String(text) + '\n');
      return '';
    },

    /**
     * Print the tail of the agent's output log to stdout.
     * Never throws.
     */
    attach(sessionHandle) {
      try {
        const agentId = parseHandle(sessionHandle);
        const path    = logPath(agentId);
        if (!existsSync(path)) {
          console.log('(no output log — agent session not yet started)');
          return;
        }
        const buf  = readFileSync(path);
        const tail = buf.slice(-OUTPUT_TAIL_BYTES).toString('utf8');
        console.log(tail);
      } catch {
        console.log('(could not read pty output log)');
      }
    },

    /**
     * Return true if the agent session is alive.
     *
     * Primary path: check in-process sessions Map (coordinator only).
     * Fallback path: read PID file and probe with process.kill(pid, 0)
     *                (works from any process — e.g. orc-attach CLI).
     *
     * Never throws — any error returns false.
     */
    async heartbeatProbe(sessionHandle) {
      try {
        const agentId    = parseHandle(sessionHandle);
        const ptyProcess = sessions.get(agentId);

        if (ptyProcess) {
          try {
            process.kill(ptyProcess.pid, 0);
            return true;
          } catch {
            sessions.delete(agentId);
            return false;
          }
        }

        // Fallback: cross-process check via PID file.
        const pidFile = pidPath(agentId);
        if (!existsSync(pidFile)) return false;
        const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
        if (!Number.isFinite(pid)) return false;
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Kill the PTY process and clean up all state.
     * No-op if the session is not found.
     */
    async stop(sessionHandle) {
      try {
        const agentId = parseHandle(sessionHandle);

        const ptyProcess = sessions.get(agentId);
        if (ptyProcess) {
          try { ptyProcess.kill(); }    catch { /* already dead */ }
          try { outputStreams.get(agentId).end(); } catch { /* ignore */ }
          sessions.delete(agentId);
          outputStreams.delete(agentId);
        }

        try { unlinkSync(pidPath(agentId)); } catch { /* already gone */ }
      } catch {
        // No-op — malformed handle or session already cleaned up.
      }
    },
  };
}
```

**Note**: `writeFileSync` is used inside `start()` for the PID file — add it to the imports at the top of the file. The import block already lists `readFileSync` and `unlinkSync`; add `writeFileSync` alongside them.

---

## Acceptance criteria

- [ ] `adapters/pty.mjs` exists and exports `createPtyAdapter`.
- [ ] `createPtyAdapter()` returns an object with all 5 methods: `start`, `send`, `attach`, `heartbeatProbe`, `stop`.
- [ ] Session handle format is `pty:{agentId}`.
- [ ] `start()` writes `STATE_DIR/pty-pids/{agentId}.pid` containing the process PID.
- [ ] `start()` creates/truncates `STATE_DIR/pty-logs/{agentId}.log` and streams PTY output into it.
- [ ] `send()` returns `''`.
- [ ] `send()` throws when the agent is not in the sessions Map.
- [ ] `heartbeatProbe()` returns `false` (never throws) when the process is dead or PID file absent.
- [ ] `heartbeatProbe()` uses the PID file fallback when the agent is not in the Map.
- [ ] `attach()` reads from the log file; prints a fallback message (no throw) when file absent.
- [ ] `stop()` is a no-op for an unknown agentId — does not throw.
- [ ] `assertAdapterContract(createPtyAdapter())` passes (tested in Task 57).

---

## Tests

Written in Task 57 (`adapters/pty.test.mjs`).

---

## Verification

```bash
# Syntax / import check (does not require coordinator or tmux)
nvm use 24
node --input-type=module <<'EOF'
import { createPtyAdapter } from './adapters/pty.mjs';
const a = createPtyAdapter({ provider: 'claude' });
console.log(typeof a.start, typeof a.send, typeof a.heartbeatProbe, typeof a.attach, typeof a.stop);
// Expected: function function function function function
EOF
```
