# Task 39 — Code Quality Bundle: Low-Severity Fixes

Low severity. Independent — no dependencies on other tasks. All items are small,
self-contained corrections that reduce technical debt without changing observable behaviour.

> **Execution note:** Each numbered step below should be its own git commit. The four
> changes are fully independent — separate commits make regression bisection trivial.

## Scope

**In scope:**
- `claimManager.mjs` — add `return` before `withLock` in `startRun` (Issue #13)
- `eventLog.mjs` — replace double-open fsync pattern with single-fd pattern (Issue #14)
- `cli/preflight.mjs` — use `lib/stateReader.mjs` instead of private duplicate functions (Issue #16)
- `cli/delegate-task.mjs` — validate `actorId` against registered agents when non-'human' (Issue #17)
- Add or update tests for each change

**Out of scope:**
- `cli/events-tail.mjs` O(n) full read (acceptable for an ops tool; leave for dedicated perf work)
- Any schema changes
- Any coordinator logic changes

---

## Context

### Issue 13 — `startRun` missing `return`

`claimManager.mjs::startRun` calls `withLock(lp(stateDir), () => { ... })` without `return`.
`withLock` returns the callback's return value (`undefined` in this case). Sibling functions
`claimTask` and `heartbeat` both `return withLock(...)`. `startRun` is the odd one out.
Currently no caller uses `startRun`'s return value, so this is not a bug — but it is an
API inconsistency that could surprise future callers.

### Issue 14 — `appendEvent` double-open fsync

```js
appendFileSync(logPath, line, 'utf8');   // open-write-close internally
if (fsyncPolicy === 'always') {
  const fd = openSync(logPath, 'a');     // second open — redundant
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
```

The file is opened twice: once by `appendFileSync` (internally) and once by `openSync`.
The `appendFileSync` + separate fsync works correctly (the fsync flushes OS dirty pages for
the inode, not just the fd), but opening the file twice is wasteful. Replace with a single
`openSync`/`writeSync`/`fsyncSync`/`closeSync` sequence.

### Issue 16 — `preflight.mjs` duplicates stateReader helpers

`cli/preflight.mjs` defines private `readAgents()` and `readClaims()` functions at the
bottom of the file (lines 89–105). These are identical in behaviour to `readAgents` and
`readClaims` in `lib/stateReader.mjs`. Using the library functions reduces duplication.

### Issue 17 — `delegate-task.mjs` actorId not validated against registry

`--actor-id=<any-string>` is accepted as long as it matches the regex. If an agent ID is
passed that does not exist in `agents.json`, the delegated event has a non-existent `actor_id`.
Add a check: when `actorId !== 'human'`, verify the agent exists in the registry.

**Affected files:**
- `lib/claimManager.mjs` — Issue 13
- `lib/eventLog.mjs` — Issue 14
- `cli/preflight.mjs` — Issue 16
- `cli/delegate-task.mjs` — Issue 17

---

## Goals

1. Must add `return` before `withLock` call in `startRun`
2. Must replace the double-open fsync pattern in `appendEvent` with a single-fd approach
3. Must have `preflight.mjs` import and use `readAgents`/`readClaims` from `lib/stateReader.mjs`
4. Must reject `orc-delegate` with exit code 1 and descriptive message when `--actor-id` is
   a non-human, non-registered agent
5. Must not break any existing passing tests
6. Must add tests for the actor validation change (Issue 17)

---

## Implementation

### Step 1 — Add `return` in `startRun` (Issue 13)

**File:** `lib/claimManager.mjs`

```js
// Before:
export function startRun(stateDir, runId, agentId) {
  withLock(lp(stateDir), () => {
    // ...
  });
}

// After:
export function startRun(stateDir, runId, agentId) {
  return withLock(lp(stateDir), () => {
    // ...
  });
}
```

No other changes to the function body.

### Step 2 — Fix double-open fsync pattern in `appendEvent` (Issue 14)

**File:** `lib/eventLog.mjs`

Replace:

```js
export function appendEvent(logPath, event, { fsyncPolicy = 'always' } = {}) {
  const errors = validateEventObject(event);
  if (errors.length > 0) {
    throw new Error(`event validation failed: ${errors.join('; ')}`);
  }

  const line = JSON.stringify(event) + '\n';
  appendFileSync(logPath, line, 'utf8');  // open-write-close internally

  if (fsyncPolicy === 'always') {
    const fd = openSync(logPath, 'a');   // second open
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
```

With:

```js
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
// (replace the appendFileSync import with openSync, writeSync, fsyncSync, closeSync)

export function appendEvent(logPath, event, { fsyncPolicy = 'always' } = {}) {
  const errors = validateEventObject(event);
  if (errors.length > 0) {
    throw new Error(`event validation failed: ${errors.join('; ')}`);
  }

  const line = JSON.stringify(event) + '\n';
  // Use a single fd for write + optional fsync.
  const fd = openSync(logPath, 'a');
  try {
    writeSync(fd, line, null, 'utf8');
    if (fsyncPolicy === 'always') {
      fsyncSync(fd);
    }
  } finally {
    closeSync(fd);
  }
}
```

Update the `fs` import at the top of `eventLog.mjs` — remove `appendFileSync` from the
import list; add `openSync`, `writeSync`, `fsyncSync`, `closeSync` if not already imported.

### Step 3 — Use `lib/stateReader.mjs` in `preflight.mjs` (Issue 16)

**File:** `cli/preflight.mjs`

Add import:

```js
import { readAgents as readAgentsFromLib, readClaims as readClaimsFromLib } from '../lib/stateReader.mjs';
```

Replace the local helper definitions at the bottom of the file (the two private functions):

```js
// Delete these:
function readAgents() { ... }
function readClaims() { ... }
```

Update call-sites to use the imported functions. Note that `lib/stateReader.mjs::readAgents`
returns the full `{ version, agents }` object, not just the array. Adjust call-sites:

```js
// Before (local helper returned just the array):
const agents = readAgents();

// After (stateReader returns the full object):
const agents = readAgentsFromLib(STATE_DIR).agents ?? [];
const claims = readClaimsFromLib(STATE_DIR).claims ?? [];
```

### Step 4 — Validate actorId against agent registry in `delegate-task.mjs` (Issue 17)

**File:** `cli/delegate-task.mjs`

After the `actorId` regex validation, add a registry check when the actor is not 'human'.
This check must happen OUTSIDE the `withLock` block (reading agents.json without the lock
is acceptable here — we just need to know if the agent exists):

```js
// After the ACTOR_ID_RE check (around line 31-34):

if (actorId !== 'human') {
  // Validate that the actor agent is registered.
  const allAgentsCheck = listAgents(STATE_DIR);
  const actorExists = allAgentsCheck.some((a) => a.agent_id === actorId);
  if (!actorExists) {
    console.error(`Actor agent not found: ${actorId}. Registered agents: ${allAgentsCheck.map((a) => a.agent_id).join(', ') || '(none)'}`);
    process.exit(1);
  }
}
```

---

## Acceptance criteria

- [ ] `startRun` returns the result of `withLock` (consistent with `claimTask` and `heartbeat`)
- [ ] `appendEvent` opens the log file exactly once per call (single-fd pattern)
- [ ] `appendEvent` still fsyncs when `fsyncPolicy === 'always'`
- [ ] `preflight.mjs` imports `readAgents`/`readClaims` from `lib/stateReader.mjs` — no private duplicates
- [ ] `orc-delegate --actor-id=nonexistent-agent ...` exits 1 with "Actor agent not found" message
- [ ] `orc-delegate --actor-id=human ...` still works without an agent registry check
- [ ] All existing tests pass
- [ ] New test for actor-id validation in delegate-task passes

---

## Tests

### Issue 13 — No new test needed

The `return` addition is observable only by callers of `startRun`; no current test exercises
the return value. Verify by code review (grep).

### Issue 14 — Verify existing eventLog tests still pass

The behaviour of `appendEvent` is unchanged; only the implementation changes. The existing
`eventLog.test.mjs` tests cover read/write correctness and should still pass without modification.

### Issue 16 — No new test needed

Behavioural equivalence between the old local functions and the library functions is verified
by the existing `preflight.test.mjs` tests.

### Issue 17 — Add test to `cli/delegate-task.test.mjs` (if it exists)

```js
it('exits 1 when actor-id is a non-existent agent', () => {
  // Seed state with no registered agents (or one agent named 'alice').
  // Run: orc-delegate --task-ref=epic/task --actor-id=nonexistent
  // Assert: status === 1, stderr contains 'Actor agent not found'
});

it('succeeds when actor-id is human', () => {
  // Run with --actor-id=human (the default); assert exit 0.
});
```

If `delegate-task.test.mjs` does not yet exist, create it using the same `spawnSync` +
temp dir pattern used in `doctor.test.mjs` and `preflight.test.mjs`.

---

## Verification

```bash
nvm use 22 && npm run test:orc
```

```bash
# Issue 13: confirm return is present
grep -A2 'export function startRun' lib/claimManager.mjs | grep 'return withLock'
# Expected: match found

# Issue 14: confirm appendFileSync is no longer used in eventLog.mjs
grep 'appendFileSync' lib/eventLog.mjs
# Expected: no output

# Issue 16: confirm no private readAgents/readClaims in preflight.mjs
grep -n 'function readAgents\|function readClaims' cli/preflight.mjs
# Expected: no output

# Issue 17: confirm actor validation present
grep -n 'Actor agent not found' cli/delegate-task.mjs
# Expected: one match
```
