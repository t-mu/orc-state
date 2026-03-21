---
ref: general/6-create-tmux-adapter
feature: general
priority: high
status: blocked
---

# Task 6 — Create tmux Adapter for Worker Sessions

Independent. Blocks Task 7.

## Scope

**In scope:**
- New file `adapters/tmux.ts` implementing the full adapter contract from `adapters/interface.ts`
- Handle format: `tmux:{agentId}`, session name: `orc-{agentId}`
- All seven adapter methods: `start`, `send`, `attach`, `heartbeatProbe`, `stop`, `ownsSession`, `detectInputBlock`
- Bootstrap delivery via chunked `send-keys -l` with mandatory ESC + 600ms delay + Enter + SIGWINCH dance
- All tmux calls via `execFileSync`/`spawnSync` from `node:child_process` — zero new npm dependencies
- Reuse `BLOCKING_PROMPT_PATTERNS` and `detectBlockingPromptFromText()` logic from existing `adapters/pty.ts`

**Out of scope:**
- Wiring the adapter into `adapters/index.ts` (Task 7)
- Deleting `adapters/pty.ts` or uninstalling `node-pty` (Task 13)
- CLI changes to `attach.ts` or `control-worker.ts` (Tasks 8–9)
- Test file `adapters/tmux.test.ts` (Task 11)
- Coordinator orphan cleanup (Task 10)

---

## Context

Worker sessions currently run as in-process PTY child processes owned by `node-pty`. Session lifetime is coupled to the coordinator process: a coordinator crash kills all workers, and `orc attach` can only tail a static log file. Replacing the PTY adapter with a tmux-backed adapter makes sessions externally managed, individually attachable, and crash-resilient, while preserving the existing spawn-on-demand / kill-after-finish lifecycle and the coordinator-owns-all-communication architecture.

Two invariants sourced from gastown research must be encoded as named constants with explanatory comments:
1. The 600ms ESC delay is non-negotiable — bash readline's `keyseq-timeout` is 500ms; a shorter delay causes ESC to be treated as a meta prefix for Enter.
2. The SIGWINCH resize dance is required — Claude Code's TUI event loop in a detached session will not process stdin until a terminal resize event fires.

### Current state

- Worker sessions are `node-pty` child processes; `adapters/pty.ts` is the sole adapter.
- Session handle format is `pty:{agentId}`; aliveness uses PID files and `process.kill(pid, 0)`.
- `orc attach` tails `pty-logs/{agentId}.log` — read-only, not interactive.
- `adapter.ownsSession()` checks an in-process `Map` — cross-process attach is impossible.

### Desired state

- A new `adapters/tmux.ts` fully implements the adapter contract using tmux shell commands.
- Handle format is `tmux:{agentId}`; session name is `orc-{agentId}`.
- Aliveness uses `tmux has-session` + `#{pane_dead}` — no PID files, no in-process state.
- `adapter.attach()` drops the caller into a live, interactive tmux session.
- No in-process session Map; any process can address any session by name.

### Start here

- `adapters/pty.ts` — existing adapter to replace; copy `BLOCKING_PROMPT_PATTERNS` and `detectBlockingPromptFromText()`
- `adapters/interface.ts` — contract all methods must satisfy; read `assertAdapterContract`
- `lib/binaryCheck.ts` — see `PROVIDER_BINARIES` for the provider→binary mapping to replicate

**Affected files:**
- `adapters/tmux.ts` — new file (created by this task)

---

## Goals

1. Must export `createTmuxAdapter({ provider })` with the same signature as `createPtyAdapter`.
2. Must pass `assertAdapterContract(createTmuxAdapter({ provider: 'claude' }))` without throwing.
3. Must deliver bootstrap text to a tmux session via chunked `send-keys -l` with ESC + 600ms delay + Enter + SIGWINCH resize.
4. Must `heartbeatProbe` return `true` only when `tmux has-session` succeeds AND `#{pane_dead}` is not `'1'`.
5. Must `stop` kill the tmux session and be a no-op (not throw) when session is absent.
6. Must `attach` exec into the session with `stdio: 'inherit'`; print a descriptive error when stdout is not a TTY.
7. Must pass codex bootstrap as a CLI argument to `new-session` rather than via `send-keys`, matching `pty.ts` behaviour.

---

## Implementation

### Step 1 — Define constants and helpers

**File:** `adapters/tmux.ts`

```ts
// bash readline keyseq-timeout is 500ms; ESC_DELAY_MS must exceed it or
// the ESC keystroke is interpreted as a meta prefix for the following Enter.
const ESC_DELAY_MS = 600;

// Claude Code's TUI event loop in a detached session won't process stdin until
// a terminal resize event (SIGWINCH) fires. Trigger it with a ±1 column dance.
const COLS = 220;
const ROWS = 50;

const CHUNK_SIZE     = 512;  // bytes per send-keys -l call
const CHUNK_DELAY_MS = 10;   // ms between chunks (prevents TTY buffer overflow)
const STARTUP_DELAY_MS = 1500; // time for provider CLI to initialise

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
function sessionName(agentId: string) { return `orc-${agentId}`; }
function parseHandle(h: unknown): string {
  const s = String(h);
  if (!s.startsWith('tmux:') || s.length <= 5) throw new Error(`Invalid tmux session handle: ${s}`);
  return s.slice(5);
}
function tmuxExec(...args: string[]): string {
  return execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
```

Copy `BLOCKING_PROMPT_PATTERNS` and `detectBlockingPromptFromText()` from `adapters/pty.ts` verbatim.

### Step 2 — Implement `sendChunked` (core input delivery)

**File:** `adapters/tmux.ts`

```ts
async function sendChunked(agentId: string, text: string): Promise<void> {
  const name = sessionName(agentId);
  // Deliver in 512-byte chunks to avoid TTY buffer overflow
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    tmuxExec('send-keys', '-t', name, '-l', text.slice(i, i + CHUNK_SIZE));
    if (i + CHUNK_SIZE < text.length) await sleep(CHUNK_DELAY_MS);
  }
  // ESC exits any vim INSERT mode harmlessly; delay must exceed keyseq-timeout
  tmuxExec('send-keys', '-t', name, 'Escape');
  await sleep(ESC_DELAY_MS);
  tmuxExec('send-keys', '-t', name, 'Enter');
  // SIGWINCH dance: wake Claude Code's detached TUI event loop
  tmuxExec('resize-window', '-t', name, '-x', String(COLS + 1), '-y', String(ROWS));
  tmuxExec('resize-window', '-t', name, '-x', String(COLS),     '-y', String(ROWS));
}
```

### Step 3 — Implement `start`

**File:** `adapters/tmux.ts`

```ts
async start(agentId: string, config: Record<string, unknown> = {}) {
  const name = sessionName(agentId);
  // Kill any pre-existing session (ignore if absent)
  try { tmuxExec('kill-session', '-t', name); } catch { /* no-op */ }

  // Build -e KEY=VAL env args; strip CLAUDECODE to allow nested sessions
  const { CLAUDECODE: _cc, ...safeEnv } = process.env;
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries({ ...safeEnv, ...(config.env ?? {}) })) {
    if (v !== undefined) envArgs.push('-e', `${k}=${v}`);
  }

  const binary = PROVIDER_BINARIES[provider] ?? provider;
  const spawnArgs = buildStartArgs(provider, config); // codex flags + optional bootstrap arg

  tmuxExec('new-session', '-d', '-s', name, ...envArgs,
    '-c', String(config.working_directory ?? process.cwd()),
    '-x', String(COLS), '-y', String(ROWS),
    binary, ...spawnArgs);
  tmuxExec('set-option', '-t', name, 'remain-on-exit', 'on');

  await sleep(STARTUP_DELAY_MS);

  if (provider !== 'codex' && typeof config.system_prompt === 'string' && config.system_prompt) {
    await sendChunked(agentId, config.system_prompt);
  }

  return {
    session_handle: `tmux:${agentId}`,
    provider_ref: { session_name: name, provider, binary },
  };
}
```

`buildStartArgs` replicates the codex-args logic from `pty.ts`: for codex, appends `--no-alt-screen --sandbox workspace-write --ask-for-approval never` and the bootstrap as the final positional arg; for others, returns `[]`.

### Step 4 — Implement `send`, `heartbeatProbe`, `ownsSession`

**File:** `adapters/tmux.ts`

```ts
async send(sessionHandle: string, text: string) {
  await sendChunked(parseHandle(sessionHandle), text);
  return '';
},

async heartbeatProbe(sessionHandle: string): Promise<boolean> {
  try {
    const agentId = parseHandle(sessionHandle);
    const name = sessionName(agentId);
    tmuxExec('has-session', '-t', name);
    const dead = tmuxExec('display-message', '-p', '-t', name, '#{pane_dead}');
    return dead !== '1';
  } catch { return false; }
},

ownsSession(sessionHandle: string) {
  // Any process can address a tmux session by name; ownership = liveness
  try {
    const agentId = parseHandle(sessionHandle);
    tmuxExec('has-session', '-t', sessionName(agentId));
    return true;
  } catch { return false; }
},
```

### Step 5 — Implement `detectInputBlock`, `attach`, `stop`

**File:** `adapters/tmux.ts`

```ts
detectInputBlock(sessionHandle: string) {
  try {
    const name = sessionName(parseHandle(sessionHandle));
    const text = tmuxExec('capture-pane', '-p', '-t', name, '-S', '-50');
    return detectBlockingPromptFromText(text);
  } catch { return null; }
},

attach(sessionHandle: string) {
  if (!process.stdout.isTTY) {
    console.error('orc attach requires an interactive terminal (stdout is not a TTY).');
    return;
  }
  try {
    const name = sessionName(parseHandle(sessionHandle));
    spawnSync('tmux', ['attach-session', '-t', name], { stdio: 'inherit' });
  } catch (e) {
    console.error(`Could not attach to tmux session: ${(e as Error).message}`);
  }
},

stop(sessionHandle: string): Promise<void> {
  try {
    tmuxExec('kill-session', '-t', sessionName(parseHandle(sessionHandle)));
  } catch { /* session absent — no-op */ }
  return Promise.resolve();
},
```

---

## Acceptance criteria

- [ ] `createTmuxAdapter({ provider: 'claude' })` returns an object that passes `assertAdapterContract`.
- [ ] `start('bob', { system_prompt: 'X' })` returns `{ session_handle: 'tmux:bob', provider_ref: { session_name: 'orc-bob', ... } }`.
- [ ] `start` for codex passes bootstrap as a positional CLI arg; does NOT call `send-keys` for the bootstrap.
- [ ] `start` for claude/gemini delivers bootstrap via `send-keys` after `STARTUP_DELAY_MS`.
- [ ] `sendChunked` sends text in ≤512-byte chunks, then `Escape`, then waits ≥600ms, then `Enter`, then resize.
- [ ] `heartbeatProbe` returns `false` when `tmux has-session` throws (session missing).
- [ ] `heartbeatProbe` returns `false` when `#{pane_dead}` is `'1'`.
- [ ] `heartbeatProbe` never throws — returns `false` on any error including malformed handle.
- [ ] `stop` calls `tmux kill-session`; is a no-op (does not throw) when session is absent.
- [ ] `stop` is safe to call twice.
- [ ] `attach` calls `spawnSync('tmux', ['attach-session', ...], { stdio: 'inherit' })` when stdout is a TTY.
- [ ] `attach` prints an error message (does not throw) when stdout is not a TTY.
- [ ] `detectInputBlock` calls `tmux capture-pane -p -t orc-{id} -S -50` and returns a match or null.
- [ ] No changes to files outside the stated scope.

---

## Tests

Covered by Task 11 (`adapters/tmux.test.ts`). This task produces only the implementation; tests are a separate step to keep PRs atomic and reviewable.

---

## Verification

```bash
# Type-check the new file in isolation
npx tsc --experimental-strip-types adapters/tmux.ts --noEmit 2>/dev/null || \
  node --experimental-strip-types -e "import('./adapters/tmux.ts').then(m => console.log('import ok', Object.keys(m)))"

# Contract smoke test (requires tmux installed)
node --experimental-strip-types -e "
import { createTmuxAdapter } from './adapters/tmux.ts';
import { assertAdapterContract } from './adapters/interface.ts';
assertAdapterContract(createTmuxAdapter({ provider: 'claude' }));
console.log('contract ok');
"
```

```bash
# Full suite (existing tests must not regress — pty adapter still wired until Task 7)
nvm use 24 && npm test
```
