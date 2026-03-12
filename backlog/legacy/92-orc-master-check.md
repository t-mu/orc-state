# Task 92 — Add `orc-master-check` CLI Fallback Script

Depends on Task 90. Blocks Task 93.

## Scope

**In scope:**
- `cli/master-check.mjs` — new read-only script: print unconsumed notifications from queue
- `package.json` — add `orc-master-check` bin entry

**Out of scope:**
- Any changes to `masterNotifyQueue.mjs`, coordinator, or bootstrap template
- Marking entries consumed — this script is read-only

---

## Context

The PTY forwarder (Task 91) injects notifications automatically, but it only runs while
`start-session.mjs` is active. The master bootstrap (Task 93) will instruct Claude to run
`orc-master-check` as a fallback: after a long pause, or after resuming a session, Claude can
call this script via a shell command to see any task completions it may have missed.

The script must be read-only so Claude can call it safely without side effects.

**Affected files:**
- `cli/master-check.mjs` — new file
- `package.json` — `bin` section

---

## Goals

1. Must read `master-notify-queue.jsonl` and print all unconsumed entries in a human-readable format.
2. Must exit 0 in all cases (pending or not).
3. Must NOT mark entries consumed — read-only.
4. Must support `--state-dir=<path>` override for testing.
5. Must follow existing CLI script conventions (shebang, `node:fs` imports, `flag()` from `lib/args.mjs`).

---

## Implementation

### Step 1 — Create `cli/master-check.mjs`

**File:** `cli/master-check.mjs`

```js
#!/usr/bin/env node
/**
 * cli/master-check.mjs
 *
 * Print unconsumed TASK_COMPLETE notifications from master-notify-queue.jsonl.
 * Read-only — does not mark entries consumed.
 *
 * Usage: orc-master-check [--state-dir=<path>]
 */
import { readPendingNotifications } from '../lib/masterNotifyQueue.mjs';
import { flag } from '../lib/args.mjs';
import { STATE_DIR } from '../lib/paths.mjs';

const stateDir = flag('state-dir') ?? STATE_DIR;
const pending  = readPendingNotifications(stateDir);

if (pending.length === 0) {
  console.log('No pending task notifications.');
  process.exit(0);
}

console.log(`${pending.length} pending task notification(s):\n`);
for (const n of pending) {
  console.log(`  [${n.seq}] ${n.type}`);
  console.log(`        Task:    ${n.task_ref}`);
  console.log(`        Worker:  ${n.agent_id}`);
  console.log(`        Result:  ${n.success ? '✓ success' : '✗ failed'}`);
  console.log(`        Time:    ${n.finished_at}`);
  console.log('');
}
```

### Step 2 — Add bin entry to `package.json`

**File:** `package.json`

In the `"bin"` section, add alongside existing entries (`orc-status`, `orc-attach`, etc.):

```json
"orc-master-check": "cli/master-check.mjs"
```

Invariant: do not change any other bin entry or package field.

---

## Acceptance criteria

- [ ] `cli/master-check.mjs` exists with a `#!/usr/bin/env node` shebang.
- [ ] `package.json` `bin` section contains `"orc-master-check"`.
- [ ] Running `orc-master-check` with no queue file prints `No pending task notifications.` and exits 0.
- [ ] Running `orc-master-check` with unconsumed entries prints each with task_ref, agent_id, success, finished_at.
- [ ] Running `orc-master-check` does NOT modify `master-notify-queue.jsonl` (entries remain unconsumed).
- [ ] `--state-dir=<path>` override works correctly.
- [ ] No changes outside `master-check.mjs` and `package.json`.
- [ ] `nvm use 24 && npm test` passes.

---

## Tests

Add to `cli/master-check.test.mjs` (or inline in a broader CLI test file):

```js
it('prints "No pending task notifications." when queue is absent', async () => {
  const { stdout } = await execa('node', ['cli/master-check.mjs',
    `--state-dir=${emptyDir}`]);
  expect(stdout).toContain('No pending task notifications.');
});

it('prints pending entries without modifying the queue', async () => {
  appendNotification(dir, { type: 'TASK_COMPLETE', task_ref: 'orch/t1',
    agent_id: 'orc-1', success: true, finished_at: 't' });
  const { stdout } = await execa('node', ['cli/master-check.mjs',
    `--state-dir=${dir}`]);
  expect(stdout).toContain('orch/t1');
  // Still unconsumed after the read
  expect(readPendingNotifications(dir)).toHaveLength(1);
});
```

---

## Verification

```bash
nvm use 24 && npm test
```

```bash
# Smoke: with a fresh state dir
orc-master-check
# Expected: "No pending task notifications."

# After a task completes:
orc-master-check
# Expected: lists task_ref, agent_id, result, time
```

```bash
npm run orc:doctor
# Expected: exits 0, no validation errors
```

---

## Risk / Rollback

**Risk:** None — read-only script with no stateful side effects.

**Rollback:** Remove bin entry from `package.json` and delete `master-check.mjs`.
