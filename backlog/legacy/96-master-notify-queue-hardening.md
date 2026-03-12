# Task 96 — Harden masterNotifyQueue: Locking and Error Signalling

Independent. Can run in parallel with Tasks 94, 95, 97.

## Scope

**In scope:**
- `lib/masterNotifyQueue.mjs` — add `withLock` around `appendNotification` and `markConsumed`; return `boolean` from `appendNotification` to signal success
- `coordinator.mjs` — log a warning when `appendNotification` returns `false`
- `lib/masterNotifyQueue.test.mjs` — extend with tests for the lock and error-return behaviour

**Out of scope:**
- `masterPtyForwarder.mjs` — caller does not need to change (it ignores the return value; losing a notification is non-fatal from the forwarder's perspective)
- Any schema, state file, or CLI changes

---

## Context

Two concurrency/reliability issues were found in `masterNotifyQueue.mjs`:

**Issue 1 — No lock around file writes:**
`appendNotification` uses `appendFileSync` and `markConsumed` uses `writeFileSync` (full rewrite),
both without acquiring `withLock`. Concurrent calls from the coordinator process and the forwarder
(or two coordinator instances in tests) can produce a torn write or a lost consumed-marker.

**Issue 2 — Silent error swallow in `appendNotification`:**
When `appendFileSync` fails (disk full, permissions), the error is caught, logged to stderr, and
the function returns `undefined`. The coordinator has no way to detect the failure and log a
meaningful warning at the task-completion level.

**Affected files:**
- `lib/masterNotifyQueue.mjs` — add lock, change return type
- `coordinator.mjs` — warn on `false` return from `appendNotification`

---

## Goals

1. Must acquire the state lock (via `withLock`) before any file read+write in `appendNotification`.
2. Must acquire the state lock before the read+rewrite in `markConsumed`.
3. `appendNotification` must return `true` on success and `false` on failure (instead of `void`).
4. The coordinator must log `[coordinator] WARNING: failed to deposit notification for <task_ref>` when `appendNotification` returns `false`.
5. Must not change the external call signatures of `readPendingNotifications` or `markConsumed`.
6. Must not cause any existing tests to fail.

---

## Implementation

### Step 1 — Add lock to `masterNotifyQueue.mjs`

**File:** `lib/masterNotifyQueue.mjs`

Add imports:

```js
import { withLock } from './lock.mjs';
import { join } from 'node:path';
```

Wrap `appendNotification` body with `withLock`:

```js
export function appendNotification(stateDir, notification) {
  const lockPath = join(stateDir, '.lock');
  try {
    withLock(lockPath, () => {
      const path = join(stateDir, QUEUE_FILE);
      let nextSeq = 1;
      if (existsSync(path)) {
        const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
        const last = lines
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .at(-1);
        nextSeq = (last?.seq ?? 0) + 1;
      }
      const entry = { seq: nextSeq, consumed: false, ...notification };
      appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
    });
    return true;
  } catch (err) {
    console.error('[masterNotifyQueue] appendNotification failed:', err?.message);
    return false;
  }
}
```

Wrap `markConsumed` body with `withLock`:

```js
export function markConsumed(stateDir, seqs) {
  const lockPath = join(stateDir, '.lock');
  try {
    withLock(lockPath, () => {
      const path = join(stateDir, QUEUE_FILE);
      if (!existsSync(path)) return;
      const seqSet = new Set(seqs);
      const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
      const updated = lines.map((l) => {
        try {
          const obj = JSON.parse(l);
          if (seqSet.has(obj.seq)) return JSON.stringify({ ...obj, consumed: true });
          return l;
        } catch { return l; }
      });
      writeFileSync(path, updated.join('\n') + '\n', 'utf8');
    });
  } catch (err) {
    console.error('[masterNotifyQueue] markConsumed failed:', err?.message);
  }
}
```

`readPendingNotifications` is read-only — no lock needed (reads are naturally consistent on POSIX).

### Step 2 — Warn in coordinator on deposit failure

**File:** `coordinator.mjs`

Find the call to `appendNotification` in `processTerminalRunEvents` (or wherever the deposit occurs). Change from:

```js
appendNotification(STATE_DIR, { ... });
```

To:

```js
const deposited = appendNotification(STATE_DIR, { ... });
if (!deposited) {
  console.warn(`[coordinator] WARNING: failed to deposit notification for ${claim.task_ref}`);
}
```

### Step 3 — Extend tests

**File:** `lib/masterNotifyQueue.test.mjs`

```js
it('appendNotification returns true on success', () => {
  const result = appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'a',
    agent_id: 'w1', success: true, finished_at: 't' });
  expect(result).toBe(true);
});

it('appendNotification returns false and does not throw when write fails', () => {
  // Point at a non-writable path
  const result = appendNotification('/nonexistent/path', { type: 'TASK_COMPLETE',
    task_ref: 'a', agent_id: 'w1', success: true, finished_at: 't' });
  expect(result).toBe(false);
});

it('concurrent appends via withLock produce distinct seq values', () => {
  // Two synchronous calls should produce seq 1 and 2
  appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'a', agent_id: 'w1', success: true, finished_at: 't' });
  appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'b', agent_id: 'w1', success: true, finished_at: 't' });
  const pending = readPendingNotifications(dir);
  const seqs = pending.map((n) => n.seq);
  expect(new Set(seqs).size).toBe(seqs.length); // all unique
});
```

---

## Acceptance criteria

- [ ] `appendNotification` acquires the state lock before reading + appending.
- [ ] `markConsumed` acquires the state lock before reading + rewriting.
- [ ] `appendNotification` returns `true` on success and `false` on failure.
- [ ] The coordinator logs a WARNING when `appendNotification` returns `false`.
- [ ] All existing `masterNotifyQueue.test.mjs` tests still pass.
- [ ] New tests for `true`/`false` return and concurrent-seq uniqueness are added and pass.
- [ ] No changes to `readPendingNotifications`, its signature, or its behaviour.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs lib/masterNotifyQueue.test.mjs
```

---

## Verification

```bash
nvm use 24 && npm test
```

---

## Risk / Rollback

**Risk:** Adding `withLock` introduces lock contention if the coordinator and forwarder both append/consume in rapid succession. In practice, the forwarder polls every 3 s and the coordinator appends only on run completion — contention is negligible.

**Rollback:** `git restore lib/masterNotifyQueue.mjs coordinator.mjs`
