---
ref: runtime-robustness/64-worker-cli-test-coverage
title: "Add edge-case tests for run lifecycle CLI commands"
status: todo
feature: runtime-robustness
task_type: implementation
priority: high
depends_on:
  - runtime-robustness/61-split-brain-heartbeat-fix
  - runtime-robustness/60-input-wait-timeout
---

# Task 64 — Add Edge-Case Tests for Run Lifecycle CLI Commands

Depends on Task 61 (heartbeat fix) and Task 60 (input timeout). Tests must validate the fixed behavior.

## Scope

**In scope:**
- Create `cli/run-lifecycle-edge-cases.test.ts` with edge-case tests for: `run-start`, `run-heartbeat`, `run-work-complete`, `run-finish`, `run-fail`.
- Test error paths, state validation, idempotency, and the new heartbeat rejection behavior.

**Out of scope:**
- Happy-path tests (already covered in `cli/run-reporting.test.ts`).
- Tests for `run-input-request` and `run-input-respond` (separate task if needed).
- Tests for non-lifecycle CLI commands.

---

## Context

### Current state

`cli/run-reporting.test.ts` covers basic happy paths for all 5 run lifecycle commands. However, 21 CLI files have zero edge-case coverage. The core worker lifecycle commands — run-start, run-heartbeat, run-work-complete, run-finish, run-fail — are the most exercised code paths in production but lack validation of error paths, state guards, and idempotency.

### Desired state

Edge-case tests validate: mismatched agent-ids, wrong claim states, expired leases (heartbeat rejection from Task 61), invalid finalization state transitions, and idempotent retry behavior. These tests catch regressions in the critical worker-coordinator protocol.

### Start here

- `cli/run-reporting.test.ts` — existing test patterns, seed helpers, `runCli` helper
- `cli/run-heartbeat.ts` — heartbeat CLI (will have rejection behavior from Task 61)
- `lib/claimManager.ts` — state transition guards

**Affected files:**
- `cli/run-lifecycle-edge-cases.test.ts` — new test file

---

## Goals

1. Must test `run-start` with: mismatched agent-id, claim in `failed` state.
2. Must test `run-heartbeat` with: wrong agent-id, nonexistent run-id, expired lease (exits 1).
3. Must test `run-work-complete` with: invalid finalization state transitions.
4. Must test `run-finish` with: wrong agent-id, claim in `failed` state.
5. Must test `run-fail` with: `--policy=block` sets blocked status, `--code` appears in event payload.
6. Must follow the existing test pattern: `mkdtempSync`, seed state, `spawnSync` CLI, assert exit code + state + events.

---

## Implementation

### Step 1 — Create test file

**File:** `cli/run-lifecycle-edge-cases.test.ts`

Follow the pattern from `cli/run-reporting.test.ts`:

```typescript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach } from 'vitest';
// ... seed helpers from test infrastructure

describe('run-start edge cases', () => {
  it('rejects run-start with mismatched agent-id', () => { ... });
  it('rejects run-start when claim state is failed', () => { ... });
  it('is idempotent when already in_progress', () => { ... });
});

describe('run-heartbeat edge cases', () => {
  it('exits 1 with wrong agent-id', () => { ... });
  it('exits 1 for nonexistent run-id', () => { ... });
  it('exits 1 when lease is expired (split-brain guard)', () => { ... });
});

describe('run-work-complete edge cases', () => {
  it('rejects from awaiting_finalize state', () => { ... });
  it('accepts from finalize_rebase_in_progress', () => { ... });
});

describe('run-finish edge cases', () => {
  it('exits 1 with wrong agent-id', () => { ... });
  it('exits 1 when claim state is failed', () => { ... });
});

describe('run-fail edge cases', () => {
  it('includes --code in event payload', () => { ... });
  it('--policy=block sets task status to blocked', () => { ... });
});
```

---

## Acceptance criteria

- [ ] All described test cases are implemented and pass.
- [ ] Tests validate the heartbeat rejection behavior from Task 61.
- [ ] Tests use real state files and CLI spawning (not mocked).
- [ ] `npm test` passes with the new test file included.
- [ ] No changes to source files (test-only task).

---

## Tests

This task IS the test file:

**File:** `cli/run-lifecycle-edge-cases.test.ts`

Minimum 12 test cases across the 5 command groups.

---

## Verification

```bash
npx vitest run cli/run-lifecycle-edge-cases.test.ts
```

```bash
nvm use 24 && npm test
```
