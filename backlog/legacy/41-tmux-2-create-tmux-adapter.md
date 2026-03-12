# Task 41 — Create tmux Adapter (`adapters/tmux.mjs`)

Depends on Task 40 (SDK files deleted). Blocks Task 42. Core of the refactoring.

---

## Scope

**In scope:**
- Create `adapters/tmux.mjs` implementing all 5 adapter interface methods
- The adapter drives real CLI sessions (claude, codex, gemini) in tmux panes via shell commands

**Out of scope:**
- `adapters/index.mjs` — wired up in Task 42
- Tests — written in Task 48
- No changes to coordinator, CLI scripts, or templates in this task

---

## Context

### Architecture

The tmux adapter replaces all three SDK adapters with one implementation. Instead of calling
an HTTP API, it shells out to `tmux` to manage pane lifecycle:

- `start()` → opens a new tmux window, launches the CLI binary (`claude` / `codex`), sends bootstrap text
- `send()` → `tmux send-keys` (fire-and-forget; returns `''`, the coordinator ignores the return value after Task 45)
- `heartbeatProbe()` → `tmux list-panes` to check if the pane is alive
- `attach()` → `tmux capture-pane -p` to print recent terminal output
- `stop()` → `tmux kill-window`

### Session handle format

`tmux:{session}:{agentId}` — e.g. `tmux:orc:bob`

Where `session` is the tmux session name, read from env `ORCH_TMUX_SESSION` (default: `orc`).

### Provider → CLI binary mapping

| Provider | CLI binary launched |
|---|---|
| `claude` | `claude` |
| `codex` | `codex` |
| `gemini` | `gemini` |

### Interface contract (from `adapters/interface.mjs`)

All 5 methods must be present:
1. `start(agentId, config)` → `Promise<{ session_handle, provider_ref }>`
2. `send(sessionHandle, text)` → `Promise<string>` (returns `''`)
3. `attach(sessionHandle)` → `void` (prints to stdout)
4. `heartbeatProbe(sessionHandle)` → `Promise<boolean>` — never throws, returns false on error
5. `stop(sessionHandle)` → `Promise<void>` — no-op if window not found

### tmux shell commands reference

```bash
# Create a new window named {agentId} in session {session}
tmux new-window -t {session} -n {agentId}

# Send text + Enter to a pane
tmux send-keys -t {session}:{agentId} "text here" Enter

# Check if pane/window exists (exit 0 = alive, non-zero = dead)
tmux list-panes -t {session}:{agentId}

# Capture recent terminal output (stdout)
tmux capture-pane -p -t {session}:{agentId}

# Kill a window
tmux kill-window -t {session}:{agentId}
```

### Bootstrap delivery

`start()` receives `config.system_prompt` — the rendered bootstrap text from
`lib/sessionBootstrap.mjs`. This text must be typed into the tmux pane after the CLI starts.
It can be long (35–70 lines). Send it as a single `send-keys` call; the CLI will receive it
as user input and process it.

After sending the bootstrap, wait ~500 ms before returning to give the CLI time to start
receiving input.

### Error handling rules

- All `execFileSync` calls must be wrapped in try/catch
- `heartbeatProbe` must return `false` (never throw) when tmux command fails
- `stop` must be a no-op when window not found
- `start` and `send` may throw on failure (caller handles it)

**Affected files:**
- `adapters/tmux.mjs` — created by this task

---

## Goals

1. Must implement all 5 methods of the adapter interface contract
2. `start()` must open a new tmux window and send bootstrap text into it
3. `send()` must inject text into the target pane and return `''`
4. `heartbeatProbe()` must return `false` (not throw) when the pane is dead or tmux is unavailable
5. `stop()` must kill the tmux window; must be a no-op if window not found
6. `attach()` must capture and print recent pane output to stdout
7. Session handle must follow format `tmux:{session}:{agentId}`

---

## Implementation

### Step 1 — Create `adapters/tmux.mjs`

```js
#!/usr/bin/env node
/**
 * adapters/tmux.mjs
 *
 * Adapter that drives real CLI agent sessions running in tmux panes.
 * No API key required. All communication is via tmux send-keys / capture-pane.
 *
 * Session handle format: tmux:{session}:{agentId}
 * Config: ORCH_TMUX_SESSION env var (default: 'orc')
 *
 * Provider → CLI binary:
 *   claude  → claude
 *   codex   → codex
 *   gemini  → gemini
 */
import { execFileSync } from 'node:child_process';

const PROVIDER_BINARIES = {
  claude: 'claude',
  codex:  'codex',
  gemini: 'gemini',
};

function tmuxSession() {
  return process.env.ORCH_TMUX_SESSION ?? 'orc';
}

/** Parse "tmux:{session}:{agentId}" → { session, agentId, target } */
function parseHandle(sessionHandle) {
  const parts = sessionHandle.split(':');
  if (parts.length < 3 || parts[0] !== 'tmux') {
    throw new Error(`Invalid tmux session handle: ${sessionHandle}`);
  }
  const session = parts[1];
  const agentId = parts.slice(2).join(':');
  return { session, agentId, target: `${session}:${agentId}` };
}

function tmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

/**
 * Create a tmux adapter.
 *
 * @param {object} [options]
 * @param {string} [options.tmuxSession]   Override ORCH_TMUX_SESSION env var.
 * @param {string} [options.provider]      Provider id: 'claude' | 'codex' | 'gemini'.
 */
export function createTmuxAdapter({ tmuxSession: sessionOverride, provider = 'claude' } = {}) {
  const session = sessionOverride ?? tmuxSession();
  const binary  = PROVIDER_BINARIES[provider] ?? provider;

  return {
    /**
     * Open a new tmux window, start the CLI, send the bootstrap prompt.
     * Returns { session_handle, provider_ref }.
     */
    async start(agentId, config = {}) {
      const target = `${session}:${agentId}`;

      // Create a new window in the tmux session.
      tmux(['new-window', '-t', session, '-n', agentId]);

      // Launch the CLI binary in the new window.
      tmux(['send-keys', '-t', target, binary, 'Enter']);

      // Give the CLI a moment to start before sending the bootstrap.
      await new Promise((r) => setTimeout(r, 500));

      // Send the bootstrap system prompt as the first user message.
      if (config.system_prompt) {
        tmux(['send-keys', '-t', target, config.system_prompt, 'Enter']);
      }

      return {
        session_handle: `tmux:${session}:${agentId}`,
        provider_ref: { tmux_session: session, window_name: agentId, provider, binary },
      };
    },

    /**
     * Inject text into the agent's tmux pane (fire-and-forget).
     * Returns '' — the coordinator does not parse this return value.
     */
    async send(sessionHandle, text) {
      const { target } = parseHandle(sessionHandle);
      tmux(['send-keys', '-t', target, String(text), 'Enter']);
      return '';
    },

    /**
     * Print the last captured terminal output of the pane to stdout.
     */
    attach(sessionHandle) {
      try {
        const { target } = parseHandle(sessionHandle);
        const output = tmux(['capture-pane', '-p', '-t', target]);
        console.log(output);
      } catch {
        console.log('(could not capture pane output)');
      }
    },

    /**
     * Returns true if the tmux pane is alive, false otherwise. Never throws.
     */
    async heartbeatProbe(sessionHandle) {
      try {
        const { target } = parseHandle(sessionHandle);
        tmux(['list-panes', '-t', target]);
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Kill the tmux window. No-op if the window does not exist.
     */
    async stop(sessionHandle) {
      try {
        const { target } = parseHandle(sessionHandle);
        tmux(['kill-window', '-t', target]);
      } catch {
        // Window already gone — no-op.
      }
    },
  };
}
```

---

## Acceptance criteria

- [ ] `adapters/tmux.mjs` exists and exports `createTmuxAdapter`
- [ ] `createTmuxAdapter()` returns an object with all 5 methods: `start`, `send`, `attach`, `heartbeatProbe`, `stop`
- [ ] Session handle format is `tmux:{session}:{agentId}`
- [ ] `heartbeatProbe` returns `false` (does not throw) when `tmux list-panes` fails
- [ ] `stop` does not throw when the window does not exist
- [ ] `send` returns `''`
- [ ] `ORCH_TMUX_SESSION` env var controls the session name; defaults to `'orc'`
- [ ] `assertAdapterContract(createTmuxAdapter())` passes (tested in Task 48)

---

## Tests

Written in Task 48 (`adapters/tmux.test.mjs`).

---

## Verification

```bash
# Syntax check (no test runner needed for this step)
node --input-type=module <<'EOF'
import { createTmuxAdapter } from './adapters/tmux.mjs';
const a = createTmuxAdapter({ provider: 'claude' });
console.log(typeof a.start, typeof a.send, typeof a.heartbeatProbe, typeof a.attach, typeof a.stop);
// Expected: function function function function function
EOF
```
