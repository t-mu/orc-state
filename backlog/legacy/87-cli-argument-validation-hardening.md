# Task 87 — CLI Argument Validation Hardening

Independent. Can run in parallel with Tasks 85, 86, 88.

## Scope

**In scope:**
- `cli/run-fail.mjs` — validate `--policy` flag against allowed values
- `cli/register-worker.mjs` — validate `--dispatch-mode` flag against schema enum
- `cli/run-fail.test.mjs` (create if absent) — policy validation tests
- `cli/register-worker.test.mjs` (create if absent) — dispatch-mode tests

**Out of scope:**
- `lib/claimManager.mjs` — `finishRun` internal policy handling (no change)
- `lib/agentRegistry.mjs` — `registerAgent` internals (no change)
- Any other flag in either file
- Schema files

---

## Context

### `orc-run-fail` — unvalidated `--policy` flag

`run-fail.mjs` accepts `--policy=<value>` which is passed directly to `finishRun()`.
`claimManager.mjs` recognises exactly two values: `'requeue'` and `'block'`. Any other
string silently falls through as `'requeue'` (the else branch), giving no error feedback
to the agent that issued the command.

```js
// run-fail.mjs line 10 — current
const policy = flag('policy') ?? 'requeue';
// no validation — 'blok', 'BLOCK', '' all silently requeue
```

Workers call `orc-run-fail --policy=block` to prevent a task from being retried.
A typo silently re-queues instead of blocking, causing repeated failed attempts.

### `orc-worker-register` — unvalidated `--dispatch-mode` flag

`register-worker.mjs` accepts `--dispatch-mode=<value>` and passes it to `registerAgent`.
The `agents.schema.json` defines the allowed enum:
`['autonomous', 'supervised', 'human-commanded']`.
No validation is performed; any string (or an empty string from a typo) is stored.

```js
// register-worker.mjs line 39 — current
const dispatchMode = flag('dispatch-mode', args);
// no validation — stored verbatim, including invalid values
```

**Affected files:**
- `cli/run-fail.mjs` — lines 10–14
- `cli/register-worker.mjs` — lines 39–44

---

## Goals

1. `orc-run-fail --policy=<invalid>` must exit 1 with a descriptive message listing valid values.
2. `orc-run-fail --policy=requeue` and `--policy=block` must continue to work.
3. `orc-worker-register --dispatch-mode=<invalid>` must exit 1 with a descriptive message.
4. `orc-worker-register --dispatch-mode=autonomous` (and other valid values) must continue to work.
5. Omitting `--dispatch-mode` entirely must continue to work (optional flag).

---

## Implementation

### Step 1 — Validate `--policy` in `run-fail.mjs`

**File:** `cli/run-fail.mjs`

Add validation immediately after the `policy` assignment (after line 10):

```js
const VALID_POLICIES = ['requeue', 'block'];
if (!VALID_POLICIES.includes(policy)) {
  console.error(`Error: invalid --policy '${policy}'. Must be one of: ${VALID_POLICIES.join(', ')}`);
  process.exit(1);
}
```

Full resulting block (lines 6–15):
```js
const runId        = flag('run-id');
const agentId      = flag('agent-id');
const failureReason = flag('reason') ?? 'worker reported failure';
const failureCode   = flag('code')   ?? 'ERR_WORKER_REPORTED_FAILURE';
const policy        = flag('policy') ?? 'requeue';

const VALID_POLICIES = ['requeue', 'block'];
if (!VALID_POLICIES.includes(policy)) {
  console.error(`Error: invalid --policy '${policy}'. Must be one of: ${VALID_POLICIES.join(', ')}`);
  process.exit(1);
}

if (!runId || !agentId) {
  console.error('Usage: orc-run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--code=<code>] [--policy=requeue|block]');
  process.exit(1);
}
```

---

### Step 2 — Validate `--dispatch-mode` in `register-worker.mjs`

**File:** `cli/register-worker.mjs`

Add validation immediately after the `dispatchMode` assignment (after line 39):

```js
const VALID_DISPATCH_MODES = ['autonomous', 'supervised', 'human-commanded'];
if (dispatchMode !== null && dispatchMode !== undefined && !VALID_DISPATCH_MODES.includes(dispatchMode)) {
  console.error(`Error: invalid --dispatch-mode '${dispatchMode}'. Must be one of: ${VALID_DISPATCH_MODES.join(', ')}`);
  process.exit(1);
}
```

---

### Step 3 — Add tests

**File:** `cli/run-fail.test.mjs`

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('orc-run-fail policy validation', () => {
  it('exits 1 with error message on invalid --policy value', async () => {
    // Stub process.exit and console.error; invoke the module with bad policy flag
    // Assert exit(1) called and error message contains 'policy'
  });

  it('accepts --policy=requeue without error', async () => {
    // Stub finishRun; assert policy validation passes
  });

  it('accepts --policy=block without error', async () => {
    // Stub finishRun; assert policy validation passes
  });
});
```

**File:** `cli/register-worker.test.mjs`

```js
describe('orc-worker-register dispatch-mode validation', () => {
  it('exits 1 with error message on invalid --dispatch-mode value', async () => { ... });
  it('accepts --dispatch-mode=autonomous without error', async () => { ... });
  it('proceeds normally when --dispatch-mode is omitted', async () => { ... });
});
```

**Test infrastructure note:** `run-fail.mjs` and `register-worker.mjs` use top-level
`await` (ESM). Use `vi.resetModules()` and dynamic `import()` per test. Mock
`claimManager.mjs` / `agentRegistry.mjs` to prevent actual state file writes.
Follow the pattern in `cli/start-session.test.mjs` for how to capture
`process.exit` calls and stderr output.

---

## Acceptance criteria

- [ ] `orc-run-fail --run-id=r --agent-id=a --policy=invalid` exits with code 1.
- [ ] `orc-run-fail` error message for invalid policy names all valid values.
- [ ] `orc-run-fail --policy=requeue` and `--policy=block` succeed (no validation error).
- [ ] `orc-run-fail` without `--policy` defaults to `'requeue'` and succeeds.
- [ ] `orc-worker-register bob --provider=claude --dispatch-mode=invalid` exits with code 1.
- [ ] `orc-worker-register` error message for invalid dispatch-mode names all valid values.
- [ ] `orc-worker-register --dispatch-mode=autonomous` succeeds.
- [ ] `orc-worker-register` without `--dispatch-mode` succeeds.
- [ ] No changes to `claimManager.mjs` or `agentRegistry.mjs`.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs cli/run-fail.test.mjs
npx vitest run -c orchestrator/vitest.config.mjs cli/register-worker.test.mjs
```

---

## Verification

```bash
cd orchestrator && npm test
```
