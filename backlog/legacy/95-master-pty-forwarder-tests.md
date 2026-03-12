# Task 95 — Test Coverage for masterPtyForwarder and masterNotifyQueue Integration

Independent. Can run in parallel with Tasks 96–97.

## Scope

**In scope:**
- `lib/masterPtyForwarder.test.mjs` — new test file with full unit coverage
- `lib/masterNotifyQueue.test.mjs` — extend with integration-style consume-mark loop tests

**Out of scope:**
- `masterPtyForwarder.mjs` source code — do not modify; only test
- `masterNotifyQueue.mjs` source code — do not modify; only test
- Any coordinator or PTY adapter tests

---

## Context

`lib/masterPtyForwarder.mjs` was introduced as part of the notification
architecture and has **zero test coverage**. The module manages a critical user-facing
behaviour: it reads pending notifications, enforces a quiet-stdin gate, injects formatted
text into the master PTY, and marks entries consumed. A bug in any of these steps causes
silent notification loss or spurious injection mid-typing.

`masterNotifyQueue.test.mjs` exists but does not cover the full consume-mark cycle as
exercised by the forwarder (append → read pending → write to PTY → markConsumed → read again
= empty).

**Affected files:**
- `lib/masterPtyForwarder.mjs` — module under test
- `lib/masterNotifyQueue.mjs` — module under test (integration angle)
- `lib/masterPtyForwarder.test.mjs` — to create
- `lib/masterNotifyQueue.test.mjs` — to extend

---

## Goals

1. Must test the quiet-stdin gate: no injection when stdin active within 2 s.
2. Must test the happy path: notification injected when stdin idle ≥ 2 s.
3. Must test `markConsumed` is called for injected notifications.
4. Must test that a `masterPty.write` throw does not propagate out of the interval.
5. Must test the forwarder stop function: interval cleared, no further polling.
6. Must test the full consume-mark loop: after injection, `readPendingNotifications` returns empty.
7. Must use `vi.useFakeTimers()` — no real timers or real PTY processes.

---

## Implementation

### Step 1 — Create `lib/masterPtyForwarder.test.mjs`

**File:** `lib/masterPtyForwarder.test.mjs`

```js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendNotification, readPendingNotifications } from './masterNotifyQueue.mjs';
import { startMasterPtyForwarder } from './masterPtyForwarder.mjs';

describe('startMasterPtyForwarder', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fwd-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('injects notification when stdin has been idle for > QUIET_THRESHOLD_MS', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE', task_ref: 'orch/t1',
      agent_id: 'orc-1', success: true, finished_at: 'now',
    });
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };

    const stop = startMasterPtyForwarder(dir, fakePty);
    vi.advanceTimersByTime(5_000); // 2s idle + 3s poll
    stop();

    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toContain('[ORCHESTRATOR] TASK_COMPLETE');
    expect(writes[0]).toContain('orch/t1');
    expect(writes[0]).toContain('orc-1');
    expect(writes[0]).toContain('✓ success');
  });

  it('does NOT inject when stdin was active within QUIET_THRESHOLD_MS', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE', task_ref: 'orch/t2',
      agent_id: 'orc-1', success: true, finished_at: 'now',
    });
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };

    const stop = startMasterPtyForwarder(dir, fakePty);
    // Simulate recent typing (< 2 s before the poll fires)
    vi.advanceTimersByTime(2_500);
    process.stdin.emit('data', Buffer.from('x')); // stdin active now
    vi.advanceTimersByTime(500); // poll fires at 3000ms, but stdin was active 500ms ago
    stop();

    expect(writes).toHaveLength(0);
  });

  it('marks notifications consumed after injection', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE', task_ref: 'orch/t3',
      agent_id: 'orc-1', success: false, finished_at: 'now',
    });
    const fakePty = { write: () => {} };

    const stop = startMasterPtyForwarder(dir, fakePty);
    vi.advanceTimersByTime(5_000);
    stop();

    expect(readPendingNotifications(dir)).toHaveLength(0);
  });

  it('does not throw when masterPty.write throws', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE', task_ref: 'orch/t4',
      agent_id: 'orc-1', success: true, finished_at: 'now',
    });
    const fakePty = { write: () => { throw new Error('PTY exited'); } };

    const stop = startMasterPtyForwarder(dir, fakePty);
    expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
    stop();
  });

  it('stop() clears the interval so no further polling occurs', () => {
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };

    const stop = startMasterPtyForwarder(dir, fakePty);
    stop(); // stop immediately

    appendNotification(dir, {
      type: 'TASK_COMPLETE', task_ref: 'orch/t5',
      agent_id: 'orc-1', success: true, finished_at: 'now',
    });
    vi.advanceTimersByTime(10_000); // advance well past poll interval

    expect(writes).toHaveLength(0);
  });

  it('formats failed tasks with ✗ failed result', () => {
    appendNotification(dir, {
      type: 'TASK_COMPLETE', task_ref: 'orch/t6',
      agent_id: 'orc-2', success: false, finished_at: 'now',
    });
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };

    const stop = startMasterPtyForwarder(dir, fakePty);
    vi.advanceTimersByTime(5_000);
    stop();

    expect(writes[0]).toContain('✗ failed');
  });
});
```

### Step 2 — Extend `lib/masterNotifyQueue.test.mjs`

**File:** `lib/masterNotifyQueue.test.mjs`

Add inside the existing `describe('masterNotifyQueue', ...)` block:

```js
it('full consume-mark cycle: after markConsumed, readPendingNotifications returns empty', () => {
  appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'a', agent_id: 'w1', success: true, finished_at: 't' });
  appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'b', agent_id: 'w1', success: true, finished_at: 't' });
  const pending = readPendingNotifications(dir);
  expect(pending).toHaveLength(2);
  markConsumed(dir, pending.map((n) => n.seq));
  expect(readPendingNotifications(dir)).toHaveLength(0);
});

it('does not mark entries with non-matching seq', () => {
  appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'a', agent_id: 'w1', success: true, finished_at: 't' });
  appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'b', agent_id: 'w1', success: true, finished_at: 't' });
  markConsumed(dir, [999]); // non-existent seq
  expect(readPendingNotifications(dir)).toHaveLength(2);
});
```

---

## Acceptance criteria

- [ ] `masterPtyForwarder.test.mjs` exists with ≥ 6 tests covering: idle injection, active-stdin gate, consumed-after-injection, write-throw safety, stop(), failed-task format.
- [ ] Quiet-stdin gate test uses `process.stdin.emit('data', ...)` to simulate activity.
- [ ] Consume-mark loop test in `masterNotifyQueue.test.mjs` confirms `readPendingNotifications` returns empty after `markConsumed`.
- [ ] All tests use `vi.useFakeTimers()` — no wall-clock dependency.
- [ ] No changes to source files outside test files.
- [ ] `nvm use 24 && npm test` passes with no failures.

---

## Tests

```bash
npx vitest run -c orchestrator/vitest.config.mjs lib/masterPtyForwarder.test.mjs
npx vitest run -c orchestrator/vitest.config.mjs lib/masterNotifyQueue.test.mjs
```

---

## Verification

```bash
nvm use 24 && npm test
```
