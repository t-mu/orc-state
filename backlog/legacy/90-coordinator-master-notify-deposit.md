# Task 90 — Coordinator Deposits TASK_COMPLETE to master-notify-queue.jsonl

Depends on Task 89. Blocks Tasks 91 and 92.

## Scope

**In scope:**
- `lib/masterNotifyQueue.mjs` — new module: `appendNotification`, `readPendingNotifications`, `markConsumed`
- `coordinator.mjs` — call `appendNotification` after `finishRun` (run_finished) and after run_failed handling

**Out of scope:**
- PTY forwarder, CLI scripts, or bootstrap template — those are Tasks 91–93
- Any changes to `backlog.json`, `agents.json`, `claims.json`, or `events.jsonl` schemas
- The MCP server

---

## Context

When a worker finishes a task the coordinator processes `run_finished` / `run_failed` and calls
`finishRun()`. Currently nothing notifies the master agent. The PTY forwarder (Task 91) will poll
`orc-state/master-notify-queue.jsonl` and inject pending notifications into the master PTY.
This task creates that queue and the coordinator hook that writes to it.

**Affected files:**
- `coordinator.mjs` — `tick()` function, `finishRun` call sites
- `lib/masterNotifyQueue.mjs` — new file

---

## Goals

1. Must create `lib/masterNotifyQueue.mjs` with three exports: `appendNotification`, `readPendingNotifications`, `markConsumed`.
2. Must append a `TASK_COMPLETE` entry to `master-notify-queue.jsonl` whenever the coordinator processes `run_finished` (success: true) or `run_failed` (success: false).
3. Must use JSONL format (one JSON object per line) with monotonically increasing `seq` values.
4. Must never crash the coordinator tick — `appendNotification` failures must be caught and logged.
5. Must not alter any existing state file (backlog, agents, claims, events).

---

## Implementation

### Step 1 — Create `lib/masterNotifyQueue.mjs`

**File:** `lib/masterNotifyQueue.mjs`

```js
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const QUEUE_FILE = 'master-notify-queue.jsonl';

/**
 * Append a notification entry to master-notify-queue.jsonl.
 * Never throws — failures are caught and logged.
 */
export function appendNotification(stateDir, notification) {
  try {
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
  } catch (err) {
    console.error('[masterNotifyQueue] appendNotification failed:', err?.message);
  }
}

/**
 * Return all unconsumed notification entries.
 */
export function readPendingNotifications(stateDir) {
  const path = join(stateDir, QUEUE_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((n) => n && !n.consumed);
}

/**
 * Mark the given seq numbers as consumed (in-place rewrite).
 */
export function markConsumed(stateDir, seqs) {
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
}
```

### Step 2 — Hook into coordinator after `finishRun`

**File:** `coordinator.mjs`

Add import at the top:

```js
import { appendNotification } from './lib/masterNotifyQueue.mjs';
```

Find the `run_finished` handling block in `tick()` (after the `finishRun(...)` call) and add:

```js
appendNotification(STATE_DIR, {
  type:        'TASK_COMPLETE',
  task_ref:    claim.task_ref,
  agent_id:    claim.agent_id,
  success:     true,
  finished_at: new Date().toISOString(),
});
```

Find the `run_failed` handling block (or the path that calls `finishRun` with `success: false`) and add:

```js
appendNotification(STATE_DIR, {
  type:        'TASK_COMPLETE',
  task_ref:    claim.task_ref,
  agent_id:    claim.agent_id,
  success:     false,
  finished_at: new Date().toISOString(),
});
```

Invariant: do not alter the `finishRun` call itself or any surrounding claims/events logic.

---

## Acceptance criteria

- [ ] `lib/masterNotifyQueue.mjs` exists and exports `appendNotification`, `readPendingNotifications`, `markConsumed`.
- [ ] After a worker emits `run_finished`, `master-notify-queue.jsonl` contains a new entry with `type: 'TASK_COMPLETE'`, `success: true`, and the correct `task_ref` and `agent_id`.
- [ ] After a worker emits `run_failed`, a new entry appears with `success: false`.
- [ ] `seq` values are monotonically increasing across multiple appends.
- [ ] `consumed` is `false` on newly appended entries.
- [ ] A simulated `appendFileSync` failure does not crash the coordinator (error is logged only).
- [ ] No changes to `backlog.json`, `agents.json`, `claims.json`, or `events.jsonl`.
- [ ] `nvm use 24 && npm test` passes.

---

## Tests

Add `lib/masterNotifyQueue.test.mjs`:

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  appendNotification,
  readPendingNotifications,
  markConsumed,
} from './masterNotifyQueue.mjs';

describe('masterNotifyQueue', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mnq-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('appends entries with monotonically increasing seq', () => {
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'a', agent_id: 'w1', success: true, finished_at: 't' });
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'b', agent_id: 'w1', success: false, finished_at: 't' });
    const pending = readPendingNotifications(dir);
    expect(pending[0].seq).toBe(1);
    expect(pending[1].seq).toBe(2);
  });

  it('readPendingNotifications returns only unconsumed entries', () => {
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'a', agent_id: 'w1', success: true, finished_at: 't' });
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'b', agent_id: 'w1', success: true, finished_at: 't' });
    markConsumed(dir, [1]);
    const pending = readPendingNotifications(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0].task_ref).toBe('b');
  });

  it('returns empty array when queue file does not exist', () => {
    expect(readPendingNotifications(dir)).toEqual([]);
  });
});
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
# Smoke: trigger a run_finished and check the queue
cat orc-state/master-notify-queue.jsonl
# Expected: one JSONL entry with type=TASK_COMPLETE, consumed=false
```

---

## Risk / Rollback

**Risk:** `master-notify-queue.jsonl` grows unbounded if `markConsumed` is never called (forwarder not running). Mitigated by keeping it append-only and small per entry; a future compaction task can truncate consumed lines.

**Rollback:** Remove `appendNotification` calls from `coordinator.mjs` and delete `masterNotifyQueue.mjs`. Queue file can be deleted safely — it has no effect on backlog or claims.
