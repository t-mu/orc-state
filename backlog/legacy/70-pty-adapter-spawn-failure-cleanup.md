# Task 70 — Prevent Resource Leak on PTY Spawn Failure

Depends on Task 51 and Task 65. Independent of Tasks 69, 71–73.

## Scope

**In scope:**
- `adapters/pty.mjs` — cleanup logic when `pty.spawn()` throws
- `adapters/pty.test.mjs` — unit test for spawn-failure cleanup

**Out of scope:**
- Coordinator dispatch policy
- Attach CLI behavior

---

## Context

`createPtyAdapter().start()` opens output log stream before `pty.spawn()`. If spawn throws, the stream may remain open and later surface unhandled I/O errors. This creates noisy failures and possible descriptor leaks under repeated startup failures.

**Affected files:**
- `adapters/pty.mjs`
- `adapters/pty.test.mjs`

---

## Goals

1. Must close any opened stream when `pty.spawn()` fails.
2. Must avoid writing PID/session map entries on spawn failure.
3. Must rethrow a descriptive error to caller.
4. Must keep successful startup behavior unchanged.

---

## Implementation

### Step 1 — Guard start sequence with try/catch

**File:** `adapters/pty.mjs`

- Wrap stream creation + spawn + startup wiring in try/catch.
- On catch: close stream (if opened), remove partial state, rethrow.
- Keep current return contract unchanged.

### Step 2 — Add failing-spawn unit test

**File:** `adapters/pty.test.mjs`

- Mock `node-pty.spawn` to throw.
- Assert `start()` rejects.
- Assert no PID file is created and no unhandled write-stream side effects remain.

---

## Acceptance criteria

- [ ] `start()` rejects cleanly when spawn throws.
- [ ] No PID file is written on spawn failure.
- [ ] No leaked stream or unhandled error occurs in failure path.
- [ ] Existing PTY unit tests remain green.

---

## Tests

Add to `adapters/pty.test.mjs`:

```js
it('cleans up log stream and pid state when pty.spawn throws', async () => { ... });
```

---

## Verification

```bash
npx vitest run -c orchestrator/vitest.config.mjs adapters/pty.test.mjs
```
