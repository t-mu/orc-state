# Task 91 — PTY Forwarder: Inject TASK_COMPLETE Notifications into Master Session

Depends on Tasks 89 and 90. Blocks Task 93.

## Scope

**In scope:**
- `lib/masterPtyForwarder.mjs` — new module: poll queue, quiet-stdin gate, inject, mark consumed
- `cli/start-session.mjs` — start forwarder after masterPty is created; stop on PTY exit

**Out of scope:**
- Coordinator, backlog, agents, claims — no changes
- Bootstrap template — that is Task 93
- The `masterNotifyQueue` module itself — already created by Task 90

---

## Context

Task 89 creates a `masterPty` node-pty reference in `start-session.mjs`.
Task 90 causes the coordinator to append `TASK_COMPLETE` entries to `master-notify-queue.jsonl`.
This task closes the loop: a `setInterval` poller running in the `start-session.mjs` process
reads the queue, waits for stdin to be quiet (so it does not interrupt active typing), then
writes a formatted notification block into the master PTY and marks the entries consumed.

**Affected files:**
- `lib/masterPtyForwarder.mjs` — new file
- `cli/start-session.mjs` — start/stop forwarder

---

## Goals

1. Must poll `master-notify-queue.jsonl` every 3 seconds.
2. Must not inject while the user has typed within the last 2 seconds (quiet-stdin gate).
3. Must inject a human-readable block for each pending notification via `masterPty.write()`.
4. Must mark injected entries consumed immediately after a successful write.
5. Must stop the poll interval when the master PTY exits.
6. Must never throw — all errors caught and logged.

---

## Implementation

### Step 1 — Create `lib/masterPtyForwarder.mjs`

**File:** `lib/masterPtyForwarder.mjs`

```js
import { readPendingNotifications, markConsumed } from './masterNotifyQueue.mjs';

const POLL_INTERVAL_MS  = 3_000;
const QUIET_THRESHOLD_MS = 2_000;

/**
 * Start a background poller that injects coordinator notifications into the
 * master PTY when stdin has been idle for at least QUIET_THRESHOLD_MS.
 *
 * @param {string} stateDir   - orc-state directory path
 * @param {import('node-pty').IPty} masterPty - the spawned master PTY handle
 * @returns {() => void}      - call to stop the forwarder
 */
export function startMasterPtyForwarder(stateDir, masterPty) {
  let lastStdinActivity = Date.now();

  // Track every keystroke so we know when the user is idle.
  const onStdinData = () => { lastStdinActivity = Date.now(); };
  process.stdin.on('data', onStdinData);

  const timer = setInterval(() => {
    try {
      const idleMs = Date.now() - lastStdinActivity;
      if (idleMs < QUIET_THRESHOLD_MS) return;

      const pending = readPendingNotifications(stateDir);
      if (pending.length === 0) return;

      const block = formatNotifications(pending);
      masterPty.write(block + '\n');
      markConsumed(stateDir, pending.map((n) => n.seq));
    } catch (err) {
      console.error('[masterPtyForwarder] error:', err?.message);
    }
  }, POLL_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    process.stdin.off('data', onStdinData);
  };
}

function formatNotifications(notifications) {
  const lines = notifications.flatMap((n) => [
    '',
    '[ORCHESTRATOR] TASK_COMPLETE',
    `  Task:    ${n.task_ref}`,
    `  Worker:  ${n.agent_id}`,
    `  Result:  ${n.success ? '✓ success' : '✗ failed'}`,
    `  Time:    ${n.finished_at}`,
  ]);
  lines.push(
    '',
    'Please inform the user a task has completed and ask:',
    '  1) Ignore for now',
    '  2) React immediately',
  );
  return lines.join('\n');
}
```

### Step 2 — Integrate into `start-session.mjs`

**File:** `cli/start-session.mjs`

Add import near the top:

```js
import { startMasterPtyForwarder } from '../lib/masterPtyForwarder.mjs';
```

After `masterPty = ptyProcess;` (Task 89), start the forwarder:

```js
const stopForwarder = startMasterPtyForwarder(STATE_DIR, masterPty);
```

In the PTY exit/cleanup block, before or after `masterPty = null`:

```js
stopForwarder();
```

Invariant: do not change the masterPty spawn logic, stdin bridge, or resize handler from Task 89.

---

## Acceptance criteria

- [ ] `lib/masterPtyForwarder.mjs` exists and exports `startMasterPtyForwarder`.
- [ ] `startMasterPtyForwarder` is called from `start-session.mjs` after the PTY is spawned.
- [ ] With stdin idle ≥ 2 s and a pending notification, the formatted block is written to `masterPty`.
- [ ] After injection, the consumed entries are marked in `master-notify-queue.jsonl`.
- [ ] With stdin active within 2 s, no injection occurs on that poll cycle.
- [ ] The `setInterval` is cleared when the returned stop function is called.
- [ ] A thrown error inside the interval does not propagate (caught and logged only).
- [ ] No changes to coordinator, queue module, or bootstrap template.
- [ ] `nvm use 24 && npm test` passes.

---

## Tests

Add `lib/masterPtyForwarder.test.mjs`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendNotification } from './masterNotifyQueue.mjs';
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

  it('injects notification when stdin has been idle', () => {
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'orch/t1', agent_id: 'orc-1', success: true, finished_at: 't' });
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };

    const stop = startMasterPtyForwarder(dir, fakePty);
    vi.advanceTimersByTime(5_000); // idle > 2 s, poll fires
    stop();

    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toContain('TASK_COMPLETE');
    expect(writes[0]).toContain('orch/t1');
  });

  it('does not inject when stdin was recently active', () => {
    appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'orch/t2', agent_id: 'orc-1', success: true, finished_at: 't' });
    const writes = [];
    const fakePty = { write: (s) => writes.push(s) };

    const stop = startMasterPtyForwarder(dir, fakePty);
    // Simulate typing
    process.stdin.emit('data', Buffer.from('x'));
    vi.advanceTimersByTime(3_000); // poll fires but stdin was just active
    stop();

    expect(writes).toHaveLength(0);
  });
});
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
# Manual: trigger a task completion, wait 3 s idle, observe notification appear in master shell
orc-master-check
# Expected: shows pending notification; after idle injection, shows none
```

---

## Risk / Rollback

**Risk:** If `masterPty.write()` is called after PTY exit it throws — caught by the try/catch.
The quiet-stdin gate may delay notifications if the user is continuously typing; this is intentional.

**Rollback:** Remove `startMasterPtyForwarder` call from `start-session.mjs` and delete `masterPtyForwarder.mjs`. Queue entries remain unconsumed but cause no harm.
