# Task 73 — Isolate `PATH`/Env Mutations in Orchestrator Integration Tests

Depends on Tasks 65 and 68.

## Scope

**In scope:**
- `adapters/pty.integration.test.mjs`
- `cli/attach.integration.test.mjs`
- Any helper these tests use for env mutation

**Out of scope:**
- Production runtime code
- Non-integration test suites

---

## Context

Current PTY integration harness mutates `process.env.PATH` globally and does not consistently restore original values across tests. This can create order-dependent failures when additional integration suites are added.

**Affected files:**
- `adapters/pty.integration.test.mjs`
- `cli/attach.integration.test.mjs`

---

## Goals

1. Must restore original `PATH`/env values after each test.
2. Must avoid global env leakage between integration suites.
3. Must keep fixture binary resolution deterministic.

---

## Implementation

### Step 1 — Capture and restore env state

**Files:** integration test files above

- Save original env values in `beforeEach`.
- Restore in `afterEach` regardless of test outcome.

### Step 2 — Prefer per-process env injection

- For subprocess calls, pass PATH via `spawn/spawnSync` `env` option rather than mutating globals when possible.

---

## Acceptance criteria

- [ ] Integration tests no longer leak PATH mutations across files.
- [ ] Tests remain deterministic with fixture binaries.
- [ ] Existing integration suites continue to pass.

---

## Tests

- Add assertions or sentinel checks that env state is restored after test completion.

---

## Verification

```bash
npx vitest run -c orchestrator/vitest.integration.config.mjs
```
