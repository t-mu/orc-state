---
ref: general/151-consumer-lifecycle-e2e-test
feature: general
priority: normal
status: todo
depends_on:
  - general/148-init-max-workers-default
  - general/149-init-auto-create-backlog-dir
---

# Task 151 — Add Consumer Lifecycle End-to-End Integration Test

Depends on Task 148 and Task 149.

## Scope

**In scope:**
- Create `e2e/consumer-lifecycle.e2e.test.ts`
- Validate full consumer lifecycle: init → task creation → sync → dispatch → worker completion
- Use `test-fixtures/fake-provider-cli.ts` (no real provider required)

**Out of scope:**
- Testing real providers (Claude, Codex, Gemini)
- Testing the TUI or interactive prompts
- Testing error recovery or failure paths (separate future task)
- Modifying existing e2e tests or infrastructure

---

## Context

The project has unit tests and some e2e tests, but no test validates the
complete consumer path from `orc init` to task completion. A consumer who
installs the package, initializes, creates a task, and starts a session should
see the task dispatched and completed. This test proves that path works.

The test must run via `npm run test:e2e` (uses `vitest.e2e.config.mjs`), not
the default `npm test` (which uses `vitest.config.mjs` and only runs unit tests).

Existing e2e infrastructure in `e2e/` provides patterns for temp git repos,
coordinator lifecycle, and fake provider usage. The fake provider CLI at
`test-fixtures/fake-provider-cli.ts` simulates worker behavior.

This task depends on Task 148 (`max_workers: 1` in generated config) and
Task 149 (auto-create backlog dir) so that `orc init` produces a working
setup without manual intervention.

**Affected files:**
- `e2e/consumer-lifecycle.e2e.test.ts` — new file

---

## Goals

1. Must validate the complete consumer lifecycle from init to task completion.
2. Must run via `npm run test:e2e`, not `npm test`.
3. Must use `fake-provider-cli.ts` fixture (no real provider dependency).
4. Must assert task reaches `done` status.
5. Must assert no stale claims remain after completion.

---

## Implementation

### Step 1 — Create e2e test file

**File:** `e2e/consumer-lifecycle.e2e.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('consumer lifecycle', () => {
  // Setup: create temp git repo, run orc init with fake provider
  // Create a task spec markdown in backlog/
  // Start coordinator (headless/in-process or backgrounded)
  // Wait for task to be dispatched to fake provider worker
  // Worker completes lifecycle phases
  // Assert: task status is done, no stale claims

  it('completes a full task lifecycle from init to done', async () => {
    // 1. orc init --provider=<fake> --skip-skills --skip-agents --skip-mcp
    // 2. Write task spec to backlog/
    // 3. orc backlog-sync-check
    // 4. Start coordinator
    // 5. Delegate task
    // 6. Fake worker runs lifecycle
    // 7. Assert task done, claims clean
  });
});
```

Follow patterns from existing `e2e/orchestrationLifecycle.e2e.test.ts` and
`e2e/coordinatorPolicies.e2e.test.ts` for coordinator setup/teardown and
state file seeding.

---

## Acceptance criteria

- [ ] `e2e/consumer-lifecycle.e2e.test.ts` exists.
- [ ] Test runs via `npm run test:e2e`.
- [ ] Validates init → task creation → backlog sync → dispatch → worker completion.
- [ ] Uses `fake-provider-cli.ts` fixture (no real provider binary needed).
- [ ] Asserts task status reaches `done`.
- [ ] Asserts no stale claims remain after completion.
- [ ] `npm run test:e2e` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

This task is itself a test. The single test file validates the consumer path:

```typescript
it('completes a full task lifecycle from init to done', async () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm run test:e2e
```

```bash
nvm use 24 && npm test
```
