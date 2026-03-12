# Task 72 — Enforce PTY Integration Coverage in CI-Capable Environments

Depends on Task 65 and Task 68.

## Scope

**In scope:**
- PTY integration test gating strategy (`orchestrator/test-fixtures/ptySupport.mjs`, integration tests)
- CI command/docs update to ensure PTY tests are required where supported

**Out of scope:**
- Runtime orchestrator behavior
- Non-PTY unit/e2e tests

---

## Context

Current PTY integration tests are conditionally skipped when PTY support probe fails. This is correct for constrained environments but can hide regressions in environments that should support PTY unless CI explicitly enforces PTY coverage.

**Affected files:**
- `orchestrator/test-fixtures/ptySupport.mjs`
- `adapters/pty.integration.test.mjs`
- `cli/attach.integration.test.mjs`
- `package.json` (scripts) and/or CI workflow file

---

## Goals

1. Must keep local/dev behavior tolerant on non-PTY environments.
2. Must enforce PTY integration tests in CI jobs intended to validate PTY behavior.
3. Must fail CI when PTY tests are unexpectedly skipped in PTY-capable jobs.
4. Must document expected env toggle(s).

---

## Implementation

### Step 1 — Add explicit strict mode toggle

**Files:** `orchestrator/test-fixtures/ptySupport.mjs`, integration test files

- Introduce env flag such as `ORC_STRICT_PTY_TESTS=1`.
- If strict mode is enabled and probe fails, fail tests instead of skipping.

### Step 2 — Wire CI/testing command

**Files:** `package.json` and CI workflow

- Add integration command variant that enables strict PTY test mode.
- Use strict command in PTY-capable CI job.

### Step 3 — Document behavior

**File:** `orchestrator/test-fixtures/README.md`

- Document default skip behavior and strict-mode behavior.

---

## Acceptance criteria

- [ ] PTY tests still skip on unsupported local environments by default.
- [ ] Strict PTY mode fails when PTY is unavailable.
- [ ] CI PTY job uses strict mode.
- [ ] Documentation describes both modes.

---

## Tests

- Update integration tests to assert strict-mode failure behavior.
- Validate normal skip path still works when strict mode disabled.

---

## Verification

```bash
# default mode
npx vitest run -c orchestrator/vitest.integration.config.mjs

# strict mode
ORC_STRICT_PTY_TESTS=1 npx vitest run -c orchestrator/vitest.integration.config.mjs
```
