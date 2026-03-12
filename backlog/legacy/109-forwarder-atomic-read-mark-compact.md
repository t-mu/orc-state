---
ref: orch/task-109-forwarder-atomic-read-mark-compact
epic: orch
status: done
---

# Task 109 — Make Forwarder Read+Mark Atomic and Add Queue Compaction

Independent. Blocks none.

## Scope

**In scope:**
- `lib/masterNotifyQueue.mjs` — add a `readAndMarkConsumed(stateDir)` atomic helper; add `compactQueue(stateDir)` that removes consumed entries; export both
- `lib/masterPtyForwarder.mjs` — replace `readPendingNotifications` + `markConsumed` pair with the new atomic helper
- `lib/masterNotifyQueue.test.mjs` — add tests for the new functions

**Out of scope:**
- Changes to the append path (`appendNotification`)
- Changes to coordinator.mjs or any CLI file
- Auto-scheduling of compaction (manual call only for now)

## Context

`masterPtyForwarder.mjs` currently reads pending notifications without a lock, then acquires the lock to mark them consumed:

```js
// masterPtyForwarder.mjs (lines 53–63):
const pending = readPendingNotifications(stateDir);   // no lock — race window opens
if (pending.length === 0) return;
// ... format + write to PTY ...
markConsumed(stateDir, pending.map((n) => n.seq));    // lock acquired here
```

Between the two calls, `appendNotification` (called from the coordinator) could write a new entry. That entry is not in `pending` so it won't be injected, but it also won't be marked consumed — correct behaviour. However a *second* forwarder instance (e.g. during a restart race) could read the same unconsumed entries and inject them twice. Wrapping read+mark in a single lock eliminates the window.

Additionally the queue file grows without bound. All `consumed: true` entries accumulate. A `compactQueue` call can safely rewrite the file keeping only unconsumed entries.

**Affected files:**
- `lib/masterNotifyQueue.mjs` — new `readAndMarkConsumed`, `compactQueue` exports
- `lib/masterPtyForwarder.mjs` — use atomic helper
- `lib/masterNotifyQueue.test.mjs` — tests

## Goals

1. Must expose `readAndMarkConsumed(stateDir)` that reads unconsumed entries and marks them consumed in a single lock acquisition.
2. Must expose `compactQueue(stateDir)` that rewrites the file keeping only `consumed: false` entries.
3. `masterPtyForwarder` must use `readAndMarkConsumed` instead of the separate read+mark calls.
4. Must handle an empty or missing queue file gracefully (return `[]`).
5. `compactQueue` must be a no-op when no consumed entries exist.

## Implementation

### Step 1 — Add readAndMarkConsumed to masterNotifyQueue.mjs

**File:** `lib/masterNotifyQueue.mjs`

```js
export function readAndMarkConsumed(stateDir) {
  const lockPath = join(stateDir, '.lock');
  let pending = [];
  try {
    withLock(lockPath, () => {
      const path = queuePath(stateDir);
      if (!existsSync(path)) return;
      const lines = readQueueLines(path);
      const parsed = lines.map(parseJsonLine).filter(Boolean);
      pending = parsed.filter((e) => e.consumed !== true);
      if (pending.length === 0) return;
      const seqSet = new Set(pending.map((e) => e.seq).filter(Number.isInteger));
      const rewritten = lines.map((line) => {
        const p = parseJsonLine(line);
        if (!p || !seqSet.has(p.seq)) return line;
        return JSON.stringify({ ...p, consumed: true });
      });
      writeFileSync(path, rewritten.length > 0 ? `${rewritten.join('\n')}\n` : '', 'utf8');
    });
  } catch (error) {
    console.error(`[master-notify-queue] readAndMarkConsumed failed: ${error?.message}`);
  }
  return pending;
}
```

### Step 2 — Add compactQueue to masterNotifyQueue.mjs

```js
export function compactQueue(stateDir) {
  const lockPath = join(stateDir, '.lock');
  try {
    withLock(lockPath, () => {
      const path = queuePath(stateDir);
      if (!existsSync(path)) return;
      const lines = readQueueLines(path);
      const kept = lines.filter((line) => {
        const p = parseJsonLine(line);
        return p && p.consumed !== true;
      });
      if (kept.length === lines.length) return; // nothing to remove
      writeFileSync(path, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
    });
  } catch (error) {
    console.error(`[master-notify-queue] compactQueue failed: ${error?.message}`);
  }
}
```

### Step 3 — Update masterPtyForwarder.mjs

**File:** `lib/masterPtyForwarder.mjs`

```js
// Before:
import { markConsumed, readPendingNotifications } from './masterNotifyQueue.mjs';
// ...
const pending = readPendingNotifications(stateDir);
if (pending.length === 0) return;
// ... inject ...
markConsumed(stateDir, pending.map((n) => n.seq));
lastPromptAt = 0;

// After:
import { readAndMarkConsumed } from './masterNotifyQueue.mjs';
// ...
const pending = readAndMarkConsumed(stateDir);
if (pending.length === 0) return;
// ... inject ...
lastPromptAt = 0;
// (markConsumed call removed — already done atomically)
```

## Acceptance criteria

- [ ] `readAndMarkConsumed` reads and marks consumed within one lock acquisition.
- [ ] `compactQueue` removes consumed entries and is a no-op when nothing is consumed.
- [ ] `masterPtyForwarder` uses `readAndMarkConsumed`; `markConsumed` and `readPendingNotifications` calls are removed from the timer callback.
- [ ] Both functions return/complete gracefully on a missing queue file.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

**File:** `lib/masterNotifyQueue.test.mjs`

```js
it('readAndMarkConsumed returns pending entries and marks them consumed atomically');
it('readAndMarkConsumed returns [] when queue is empty');
it('compactQueue removes consumed entries and leaves unconsumed entries intact');
it('compactQueue is a no-op when no consumed entries exist');
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

## Risk / Rollback

**Risk:** Wrapping read+mark in a single lock increases the lock hold time slightly. Given POLL_INTERVAL_MS = 5000ms and the lock is for file I/O only, this is negligible.

**Rollback:** `git restore lib/masterNotifyQueue.mjs lib/masterPtyForwarder.mjs && npm test`
