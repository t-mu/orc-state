# Task 69 — Handle Master CLI Spawn Errors in `orc-start-session`

Depends on Task 60. Independent of Tasks 70–73.

## Scope

**In scope:**
- `cli/start-session.mjs` — treat provider CLI spawn failure as a hard failure with explicit exit code
- `cli/start-session.test.mjs` — add regression test for spawn error path

**Out of scope:**
- Coordinator runtime behavior in `coordinator.mjs`
- Worker startup flow in `cli/start-worker-session.mjs`

---

## Context

Current master foreground startup waits on both `error` and `close`, then always marks master offline and prints `Master session ended.`. If `spawn(binary)` fails immediately (e.g. binary missing after PATH drift), command exits with success-like output instead of failing fast.

**Affected files:**
- `cli/start-session.mjs`
- `cli/start-session.test.mjs`

---

## Goals

1. Must exit with code `1` when master CLI fails to spawn.
2. Must print a clear error message including provider/binary context.
3. Must avoid printing successful session-end messaging on spawn failure.
4. Must keep current successful foreground behavior unchanged.

---

## Implementation

### Step 1 — Distinguish `error` vs `close` outcomes

**File:** `cli/start-session.mjs`

- Replace generic `new Promise(resolve => on('error'|'close', resolve))` with structured result capture.
- If `error` fires before `close`, print failure and `process.exit(1)`.
- Preserve offline-status update for normal close path.

### Step 2 — Add regression test

**File:** `cli/start-session.test.mjs`

- Mock provider binary spawn to emit `error` (e.g. `ENOENT`).
- Assert exit code `1` and error text.
- Assert success-only log lines are absent.

---

## Acceptance criteria

- [ ] Spawn failure exits with code `1`.
- [ ] Output includes actionable error message.
- [ ] Success messaging is not emitted on spawn failure.
- [ ] Existing happy-path tests remain green.

---

## Tests

Add to `cli/start-session.test.mjs`:

```js
it('exits 1 when master provider CLI spawn fails', async () => { ... });
```

---

## Verification

```bash
npx vitest run -c orchestrator/vitest.config.mjs cli/start-session.test.mjs
```
