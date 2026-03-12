# Task 65 — Add Real PTY Adapter Integration Tests

Depends on Task 64. Blocks Tasks 66–68.

---

## Scope

**In scope:**
- Add integration tests for `adapters/pty.mjs` using real `node-pty`
- Validate runtime behavior against fixture provider binaries (not mocks)
- Add dedicated integration test command/config if needed

**Out of scope:**
- Changes to adapter runtime logic
- Replacement of current unit tests
- Coordinator/CLI e2e behavior (Tasks 66–68)

---

## Context

`pty.test.mjs` validates contract behavior with mocks. It does not prove real PTY stream behavior (log flushing, process liveness transitions, PID-file probe path).

This task adds a deterministic integration layer on top of Task 64 fixtures.

**Affected files:**
- `adapters/pty.integration.test.mjs`
- `orchestrator/vitest.integration.config.mjs` (if needed)
- `package.json` scripts (if needed)

---

## Goals

1. Must run against real `node-pty` (no mock of `node-pty` module).
2. Must validate `start()` creates `pty-pids/<agent>.pid` and `pty-logs/<agent>.log`.
3. Must validate `send()` delivers newline-delimited commands to fixture process.
4. Must validate `attach()` surfaces real log content including fixture markers.
5. Must validate `heartbeatProbe()` true while live, false after fixture exits.
6. Must validate `stop()` removes PID file and is safe post-exit.

---

## Implementation

### Step 1 — Create integration harness

**File:** `adapters/pty.integration.test.mjs`

Test harness requirements:
- temp `ORCH_STATE_DIR`
- PATH prepended with `orchestrator/test-fixtures/bin`
- provider `claude` via `createPtyAdapter({ provider: 'claude' })`

### Step 2 — Add strict lifecycle test

Add one canonical test with exact sequence:
1. `start('worker-01', { system_prompt: 'PING' })`
2. poll log until `FIXTURE_READY` + `FIXTURE_PONG`
3. `send('pty:worker-01', 'PING')`
4. poll log for second `FIXTURE_PONG`
5. assert `heartbeatProbe('pty:worker-01') === true`
6. `send('pty:worker-01', 'EXIT')`
7. poll until `heartbeatProbe(...) === false`
8. call `stop(...)` and assert idempotence

### Step 3 — Add focused edge tests

- malformed handle path for `heartbeatProbe` returns false
- `stop()` for unknown agent is no-op

Invariant:
- Do not modify `adapters/pty.mjs` in this task.

---

## Acceptance criteria

- [ ] Integration tests run without mocking `node-pty`.
- [ ] PID/log file assertions pass using real fixture binaries.
- [ ] Liveness transition assertions pass (`true` -> `false` after `EXIT`).
- [ ] `stop()` idempotence covered in integration tests.
- [ ] Existing unit/e2e commands remain green.

---

## Tests

Add to `adapters/pty.integration.test.mjs`:

```js
it('real PTY lifecycle: start -> send -> probe -> exit -> stop', async () => { ... });
it('heartbeatProbe returns false for malformed handle', async () => { ... });
it('stop is no-op for unknown handle', async () => { ... });
```

---

## Verification

```bash
nvm use 24
npm run test:orc:integration
npm run test:orc:unit
```

---

## Risk / Rollback

**Risk:** timing flakiness from fixed sleeps.

**Rollback:** replace sleeps with bounded polling helper and explicit timeout failure messages.
