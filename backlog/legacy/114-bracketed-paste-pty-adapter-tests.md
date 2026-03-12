---
ref: orch/task-114-bracketed-paste-pty-adapter-tests
epic: orch
status: done
---

# Task 114 — Add Bracketed Paste and PTY Adapter Unit Tests

Independent. Blocks none.

## Scope

**In scope:**
- `lib/masterPtyForwarder.test.mjs` — add tests for bracketed-paste wrapping (enabled/disabled paths) and the `bracketedPasteEnabled` state transitions
- `adapters/pty.test.mjs` — verify existing test coverage; add any missing unit tests for the PTY adapter's `onData`, `send`, and `heartbeatProbe` methods

**Out of scope:**
- Changes to `masterPtyForwarder.mjs` source (tested as-is)
- Changes to `pty.mjs` source
- Integration tests that require a live PTY process

## Context

The bracketed paste path in `masterPtyForwarder.mjs` has no dedicated unit tests. The current test suite only exercises the prompt-gate (idle detection and stdin-activity suppression). Two important code branches are untested:

1. **Bracketed paste enabled path**: when `\x1b[?2004h` is seen in PTY output, `bracketedPasteEnabled = true`; subsequent injection wraps the payload with `\x1b[200~...\x1b[201~`.
2. **Bracketed paste disabled path**: when `\x1b[?2004l` is seen (or never enabled), payload is written raw.
3. **State transition**: toggling between enabled and disabled across multiple data chunks.

`pty.test.mjs` tests the adapter but may be missing coverage of edge cases (null session handle, heartbeat returning false, send with empty string).

**Affected files:**
- `lib/masterPtyForwarder.test.mjs` — new test cases
- `adapters/pty.test.mjs` — review + new test cases

## Goals

1. Must add a test that confirms payload is wrapped with `\x1b[200~`/`\x1b[201~` when `\x1b[?2004h` has been observed in PTY output.
2. Must add a test that confirms payload is written raw when `\x1b[?2004l` has been observed (bracketed paste disabled).
3. Must add a test that confirms bracketed paste state toggles correctly across `\x1b[?2004h` → `\x1b[?2004l` → `\x1b[?2004h` transitions.
4. Must add PTY adapter tests for: `heartbeatProbe` returning false for a dead session, `send` with an empty message, null/undefined session handle.

## Implementation

### Step 1 — Bracketed paste tests in masterPtyForwarder.test.mjs

**File:** `lib/masterPtyForwarder.test.mjs`

Use the existing `makePtyEmitter()` helper to simulate PTY data. Set up a pending notification in the queue, emit `\x1b[?2004h` through the data emitter, advance the fake timer, and assert the written payload includes `\x1b[200~`.

```js
it('wraps payload with bracketed paste sequences when 2004h is seen', async () => {
  // emit '\x1b[?2004h' via ptyDataEmitter.emit()
  // append a notification to the queue
  // emit a prompt-like chunk (e.g. '> ')
  // advance timer by POLL_INTERVAL_MS
  // assert pty.write.calls[0][0] starts with '\x1b[200~'
  // assert pty.write.calls[0][0] ends with '\x1b[201~'
});

it('writes payload raw when bracketed paste is disabled (2004l)', async () => {
  // emit '\x1b[?2004h' then '\x1b[?2004l'
  // append notification, emit prompt, advance timer
  // assert pty.write.calls[0][0] does NOT contain '\x1b[200~'
});

it('toggles bracketed paste state correctly across multiple transitions', async () => {
  // emit 2004h → check enabled; emit 2004l → check disabled; emit 2004h → check enabled
});
```

### Step 2 — PTY adapter edge-case tests

**File:** `adapters/pty.test.mjs`

```js
it('heartbeatProbe returns false for a session with a dead PTY process');
it('send with empty string does not throw');
it('heartbeatProbe returns false for null session handle');
```

## Acceptance criteria

- [ ] Three new bracketed paste tests are added to `masterPtyForwarder.test.mjs` and pass.
- [ ] The enabled path test asserts the `\x1b[200~` prefix and `\x1b[201~` suffix.
- [ ] The disabled path test asserts absence of bracketed paste wrappers.
- [ ] The toggle test exercises at least two state transitions.
- [ ] At least two new PTY adapter edge-case tests are added to `pty.test.mjs` and pass.
- [ ] `nvm use 24 && npm test` passes with all new tests included.
- [ ] No changes to source files outside the stated scope.

## Tests

This task *is* tests. See Implementation above for `it(...)` shapes.

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
# Confirm new test count is higher than before this task
```
