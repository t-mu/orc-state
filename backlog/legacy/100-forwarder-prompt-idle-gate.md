# Task 100 — Replace masterPtyForwarder Quiet-Stdin Gate with PTY-Stdout Idle-Prompt Detection

Independent.

## Scope

**In scope:**
- `lib/masterPtyForwarder.mjs` — replace the stdin-idle timer gate with a PTY stdout
  monitor that detects the Claude Code idle-prompt pattern before injecting
- `lib/masterPtyForwarder.test.mjs` — update/extend tests to cover the new gate logic;
  remove or adapt tests that relied on fake timer + 15 s threshold
- `startMasterPtyForwarder` call-site in `cli/start-session.mjs` — pass the `masterPty`
  data stream so the forwarder can subscribe to PTY stdout events

**Out of scope:**
- Changes to `masterNotifyQueue.mjs`, coordinator, or MCP server
- Altering the injected notification format or the `markConsumed` path
- Modifying `POLL_INTERVAL_MS` beyond what is needed for the new gate

## Context

`startMasterPtyForwarder` currently guards injection with a fixed stdin-idle threshold
(`QUIET_THRESHOLD_MS = 15_000`). This fires whenever the user pauses typing for >15 s — including
mid-sentence pauses, reading Claude's response, or brief breaks — because `process.stdin` data
events only signal keypresses, not whether Claude Code's input buffer is empty.

The correct signal is the **Claude Code idle-prompt pattern** visible in PTY stdout: after every
completed response, Claude Code emits its prompt line (e.g. a line ending with `> ` or a known ANSI
sequence). Once that pattern appears and no `process.stdin` data event has followed, Claude Code is
genuinely waiting at an empty input field. Only then is it safe to inject a notification.

Current broken flow:
```
user types "hello…" → 16 s pause → poll fires → idleMs(16s) ≥ 15s → injects → corrupts input
```

Desired flow:
```
user types "hello…" → PTY stdout emits prompt → stdin still active → gate stays closed
claude response ends → PTY stdout emits prompt → stdin silent → gate opens → injects
```

**Affected files:**
- `lib/masterPtyForwarder.mjs` — gate logic
- `lib/masterPtyForwarder.test.mjs` — unit tests
- `cli/start-session.mjs` — call-site; must pass PTY data observable

## Goals

- Must detect the Claude Code idle-prompt signal from PTY stdout data and record `lastPromptAt`.
- Must treat any `process.stdin` data event after `lastPromptAt` as a disqualifier (input field no
  longer empty).
- Must only inject when `lastPromptAt > 0` AND `lastPromptAt > lastStdinActivity` AND the prompt
  was seen within the last `PROMPT_STALE_MS` (e.g. 60 s).
- Must remove the `QUIET_THRESHOLD_MS` stdin-idle approach entirely.
- Must keep the `POLL_INTERVAL_MS` timer as the injection trigger (no need for immediate injection
  on prompt detection to avoid races).
- Must not change the public signature of `startMasterPtyForwarder` beyond adding a `ptyDataEmitter`
  parameter (an object with an `onData(cb)` method matching the node-pty interface).
- Must pass `nvm use 24 && npm test` with no new failures.

## Implementation

### Step 1 — Update `startMasterPtyForwarder` signature and gate logic

**File:** `lib/masterPtyForwarder.mjs`

Replace the current constants and function body:

```js
const POLL_INTERVAL_MS = 5_000;
const PROMPT_STALE_MS = 60_000;

// Matches the Claude Code prompt line: ends with "> " optionally preceded by ANSI CSI sequences.
// Tune the pattern if Claude Code changes its prompt format.
const PROMPT_PATTERN = />\s*$/;

function isIdlePromptVisible(chunk) {
  // Strip common ANSI escape sequences before pattern matching.
  const plain = chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  return PROMPT_PATTERN.test(plain);
}

export function startMasterPtyForwarder(stateDir, masterPty, ptyDataEmitter) {
  let lastStdinActivity = Date.now();
  let lastPromptAt = 0;

  const stdinHandler = () => { lastStdinActivity = Date.now(); };
  process.stdin.on('data', stdinHandler);

  const dataDisposable = ptyDataEmitter?.onData((chunk) => {
    if (isIdlePromptVisible(chunk)) lastPromptAt = Date.now();
  });

  const timer = setInterval(() => {
    if (!masterPty) return;
    if (lastPromptAt === 0) return;                           // never seen a prompt yet
    if (lastPromptAt < lastStdinActivity) return;             // user typed after prompt — input not empty
    if (Date.now() - lastPromptAt > PROMPT_STALE_MS) return; // prompt is too old

    const pending = readPendingNotifications(stateDir);
    if (pending.length === 0) return;

    try {
      masterPty.write(`${formatNotifications(pending)}\n`);
      markConsumed(stateDir, pending.map((n) => n.seq));
      lastPromptAt = 0; // reset so we wait for the next prompt before injecting again
    } catch {
      // PTY may already be gone.
    }
  }, POLL_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    process.stdin.off('data', stdinHandler);
    dataDisposable?.dispose();
  };
}
```

### Step 2 — Update call-site in `start-session.mjs`

**File:** `cli/start-session.mjs`

Pass `masterPty` as the third argument so the forwarder can subscribe to PTY stdout:

```js
// Before:
stopForwarder = startMasterPtyForwarder(STATE_DIR, masterPty);

// After:
stopForwarder = startMasterPtyForwarder(STATE_DIR, masterPty, masterPty);
```

`masterPty` (node-pty `IPty`) already exposes `.onData(cb)` and the returned disposable has a
`.dispose()` method — no adapter needed.

### Step 3 — Update tests

**File:** `lib/masterPtyForwarder.test.mjs`

Replace fake-timer + stdin-idle tests with PTY-stdout signal tests. Keep the existing test
infrastructure (tmp dir, `appendNotification`). Example test shapes:

```js
it('does not inject before any idle prompt is observed', () => { … });

it('injects after PTY emits idle prompt and stdin is silent', () => {
  // emit prompt chunk → advance timer → expect write called
});

it('does not inject when stdin event occurs after prompt', () => {
  // emit prompt → emit stdin data → advance timer → expect no write
});

it('does not inject when prompt is older than PROMPT_STALE_MS', () => {
  // emit prompt → advance time past stale threshold → advance timer → no write
});

it('resets lastPromptAt after successful injection', () => {
  // inject → advance timer again without new prompt → no second write
});

it('swallows PTY write errors', () => { … }); // keep existing shape
it('stop disposes PTY data subscription and clears timer', () => { … });
```

The `ptyDataEmitter` in tests should be a plain object with an `onData(cb)` that stores `cb` and
returns `{ dispose() { … } }`.

## Acceptance criteria

- [ ] `startMasterPtyForwarder` accepts a third `ptyDataEmitter` parameter with `onData(cb)`.
- [ ] Injection only occurs when a prompt has been observed AND no stdin event followed AND prompt age ≤ `PROMPT_STALE_MS`.
- [ ] Injection does not occur when `lastStdinActivity > lastPromptAt` (user typed after prompt).
- [ ] Injection does not occur when `lastPromptAt === 0` (no prompt seen yet).
- [ ] Injection does not occur when prompt is older than `PROMPT_STALE_MS`.
- [ ] `lastPromptAt` is reset to `0` after a successful injection (prevents double-inject).
- [ ] The forwarder stop function calls `dataDisposable?.dispose()`.
- [ ] `QUIET_THRESHOLD_MS` constant is removed from `masterPtyForwarder.mjs`.
- [ ] `start-session.mjs` passes `masterPty` as `ptyDataEmitter` argument.
- [ ] All tests in `masterPtyForwarder.test.mjs` pass with the new gate logic.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `lib/masterPtyForwarder.test.mjs`

Use a minimal `ptyDataEmitter` stub:
```js
function makePtyEmitter() {
  let _cb = null;
  return {
    emit(chunk) { _cb?.(chunk); },
    onData(cb) { _cb = cb; return { dispose() { _cb = null; } }; },
  };
}
```

Cover all gate branches:
- `it('does not inject before any idle prompt is observed', ...)`
- `it('injects after PTY emits idle prompt and stdin is silent', ...)`
- `it('does not inject when stdin occurs after prompt', ...)`
- `it('does not inject when prompt is stale', ...)`
- `it('resets lastPromptAt to 0 after injection', ...)`
- `it('swallows PTY write errors during polling', ...)`
- `it('stop disposes ptyDataEmitter subscription', ...)`

The `isIdlePromptVisible` helper should be exported or tested indirectly via the above cases;
no need for a dedicated unit test of the regex unless the implementation exports it.

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

Confirm zero failures and that `masterPtyForwarder.test.mjs` exercises the prompt-gate branches.
Manual smoke test: start a session, type a partial message, observe no injection; let Claude finish
responding (prompt reappears), wait 5 s with no typing, observe injection arrives cleanly.
