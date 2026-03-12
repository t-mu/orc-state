# Task 64 — Add Deterministic Fixture Provider CLI for PTY Tests

No dependencies. Blocks Tasks 65–68.

---

## Scope

**In scope:**
- Create a deterministic fixture CLI process used by orchestration integration/e2e tests
- Create executable provider wrapper binaries (`claude`, `codex`, `gemini`) for PATH-based lookup
- Document fixture protocol and environment switches

**Out of scope:**
- Any orchestrator runtime logic (`adapters/`, `cli/`, `coordinator.mjs`, `lib/`)
- Existing test logic outside fixture tests
- Any production install flow

---

## Context

Current node-pty coverage relies heavily on mocks. To validate real PTY behavior deterministically, we need local provider fixture binaries that behave like minimal interactive CLIs.

The fixture protocol must be stable and explicit so later tests can assert exact output markers with no provider/network dependency.

**Affected files:**
- `orchestrator/test-fixtures/fake-provider-cli.mjs`
- `orchestrator/test-fixtures/bin/claude`
- `orchestrator/test-fixtures/bin/codex`
- `orchestrator/test-fixtures/bin/gemini`
- `orchestrator/test-fixtures/README.md`
- `orchestrator/test-fixtures/fake-provider-cli.integration.test.mjs`

---

## Goals

1. Must provide a fixture CLI that runs in foreground and reads line-delimited stdin.
2. Must emit deterministic output markers for startup, command handling, and exit.
3. Must support these commands exactly: `PING`, `EXIT`, fallback echo.
4. Must support env switches: crash-on-start and periodic heartbeat emission.
5. Wrapper binaries must be executable and resolve through PATH like real provider binaries.
6. Fixture test file must verify protocol markers and wrapper wiring.

---

## Implementation

### Step 1 — Create fixture CLI protocol

**File:** `orchestrator/test-fixtures/fake-provider-cli.mjs`

Implement exact output markers:
- startup: `FIXTURE_READY provider=<provider>`
- `PING`: `FIXTURE_PONG`
- unknown input `X`: `FIXTURE_ECHO <X>`
- `EXIT`: `FIXTURE_BYE` then process exit 0

Implement exact env switches:
- `FAKE_PROVIDER_CRASH_ON_START=1` -> print `FIXTURE_CRASH_ON_START` to stderr and exit `42`
- `FAKE_PROVIDER_HEARTBEAT_MS=<n>` -> print `FIXTURE_HEARTBEAT` every `<n>` ms

Invariant:
- Do not import orchestrator runtime modules.

### Step 2 — Create provider wrapper binaries

**Files:**
- `orchestrator/test-fixtures/bin/claude`
- `orchestrator/test-fixtures/bin/codex`
- `orchestrator/test-fixtures/bin/gemini`

Each wrapper must:
- be POSIX shell script with shebang `#!/usr/bin/env bash`
- exec `node` on `../fake-provider-cli.mjs` with provider arg matching filename
- forward all arguments (`"$@"`)

Invariant:
- Wrappers must have executable bit set.

### Step 3 — Add fixture protocol documentation

**File:** `orchestrator/test-fixtures/README.md`

Document:
- command protocol (exact markers)
- env switches and expected behavior
- PATH usage in tests

### Step 4 — Add fixture integration tests

**File:** `orchestrator/test-fixtures/fake-provider-cli.integration.test.mjs`

Use real subprocesses (`spawn`) and assert exact markers.

---

## Acceptance criteria

- [ ] `fake-provider-cli.mjs` emits exact startup marker `FIXTURE_READY provider=<provider>`.
- [ ] Sending `PING` yields `FIXTURE_PONG`.
- [ ] Sending `EXIT` yields `FIXTURE_BYE` and exits code `0`.
- [ ] Crash switch exits with code `42` and prints `FIXTURE_CRASH_ON_START`.
- [ ] Wrapper binaries are executable and callable from PATH.
- [ ] No files outside the stated scope are modified.

---

## Tests

Add to `orchestrator/test-fixtures/fake-provider-cli.integration.test.mjs`:

```js
it('handles PING then EXIT with exact markers', async () => { ... });
it('exits 42 when FAKE_PROVIDER_CRASH_ON_START=1', async () => { ... });
it('claude/codex/gemini wrappers all invoke shared fixture', async () => { ... });
```

---

## Verification

```bash
nvm use 24
node orchestrator/test-fixtures/fake-provider-cli.mjs claude
# type: PING, EXIT

PATH="$(pwd)/orchestrator/test-fixtures/bin:$PATH" claude
npm run test:orc:unit
```

---

## Risk / Rollback

**Risk:** marker-string drift causes cascading integration test failures.

**Rollback:** preserve marker compatibility; if changing markers, update all dependent tests in one commit.
