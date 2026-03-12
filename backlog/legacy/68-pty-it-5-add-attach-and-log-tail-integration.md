# Task 68 — Add Attach/Log-Tail Integration Tests for PTY Sessions

Depends on Task 67. Final task in this integration/e2e coverage series.

---

## Scope

**In scope:**
- Add integration tests for `orc-attach` against real PTY fixture sessions
- Validate live log-tail output and dead-session failure path

**Out of scope:**
- `attach.mjs` runtime behavior changes
- Coordinator logic changes
- Binary installation flow

---

## Context

`orc-attach` behavior is user-facing and now depends on PTY log tails (`pty-logs/<agent>.log`). We need real integration coverage to ensure output markers and exit codes are correct beyond mocked adapter tests.

**Affected files:**
- `cli/attach.integration.test.mjs`
- `orchestrator/vitest.integration.config.mjs` (if needed)

---

## Goals

1. Must verify `orc-attach` prints live PTY output markers from fixture process.
2. Must verify `orc-attach` prints `Log file: <path>`.
3. Must verify dead/unreachable session exits with code 1 and error message.
4. Must verify no tmux references appear in attach output.
5. Must run with real fixture PTY session (no adapter mock).

---

## Implementation

### Step 1 — Add attach integration harness

**File:** `cli/attach.integration.test.mjs`

Harness requirements:
- temp `ORCH_STATE_DIR`
- PATH includes fixture bins
- seed agent record in `agents.json`
- create real PTY session via adapter setup helper (or coordinator tick)

### Step 2 — Add live-session attach test

Sequence:
1. ensure fixture emits known marker (`FIXTURE_READY` / `FIXTURE_PONG`)
2. run `node cli/attach.mjs <agent>`
3. assert success exit code
4. assert marker and `Log file:` line in output

### Step 3 — Add dead-session attach test

Sequence:
1. terminate fixture process
2. run attach command again
3. assert exit code `1` and unreachable-session message

Invariant:
- Do not modify `cli/attach.mjs` in this task.

---

## Acceptance criteria

- [ ] Integration test validates successful live attach output from real PTY log.
- [ ] Integration test validates dead-session error path and exit code 1.
- [ ] Output includes `Log file:` and excludes tmux references.
- [ ] `npm run test:orc:integration` and `npm run test:orc:e2e` pass.

---

## Tests

Add to `cli/attach.integration.test.mjs`:

```js
it('prints live PTY log marker and log path', async () => { ... });
it('exits 1 when PTY session is dead/unreachable', async () => { ... });
```

---

## Verification

```bash
nvm use 24
npm run test:orc:integration
npm run test:orc:e2e
npm run test:orc:unit
```

---

## Risk / Rollback

**Risk:** attach tests may be flaky if log flush timing is asserted with static sleeps.

**Rollback:** use polling for marker detection and bounded timeouts with explicit failure diagnostics.
