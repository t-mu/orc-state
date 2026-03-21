---
ref: general/9-update-control-worker-cli
feature: general
priority: normal
status: todo
---

# Task 9 — Update cli/control-worker.ts for Interactive tmux Attach

Depends on Task 7. Blocks Task 13.

## Scope

**In scope:**
- `cli/control-worker.ts`: add a TTY guard, update messaging, remove log-path print
- Mirror the same changes applied to `cli/attach.ts` in Task 8

**Out of scope:**
- `cli/attach.ts` (Task 8)
- Any changes to `adapters/tmux.ts` or `adapters/index.ts`
- Removing `pty-logs/` infrastructure (Task 13)

---

## Context

`cli/control-worker.ts` is the debug-path equivalent of `cli/attach.ts` — it resolves a worker agent and calls `adapter.attach()`. After Task 7, `adapter.attach()` execs into a live tmux session. This task applies the same TTY guard and messaging update that Task 8 applies to `cli/attach.ts`, ensuring both attach paths are consistent.

### Current state

`cli/control-worker.ts` calls `adapter.attach()` (previously a log tail) and prints `Log file: .orc-state/pty-logs/{workerId}.log`. No TTY guard exists. The file is ~64 lines.

### Desired state

`cli/control-worker.ts` guards against non-TTY stdout, prints `Attaching to {workerId} (debug) — press Ctrl-b d to detach`, calls `adapter.attach()`, and does not print a log path.

### Start here

- `cli/control-worker.ts` — read in full before editing; ~64 lines
- `cli/attach.ts` — reference for the identical TTY guard pattern applied in Task 8

**Affected files:**
- `cli/control-worker.ts` — add TTY guard, update messaging, remove log-path line

---

## Goals

1. Must exit 1 with a clear message when `process.stdout.isTTY` is falsy.
2. Must print `Attaching to {workerId} (debug) — press Ctrl-b d to detach` before calling `adapter.attach()`.
3. Must not print the `Log file: ...` line.
4. Must retain the `heartbeatProbe` aliveness check before attempting to attach.
5. Must retain the interactive worker-selection prompt (`@inquirer/prompts`) and all existing role/session validation paths unchanged.

---

## Implementation

### Step 1 — Add TTY guard after session validation

**File:** `cli/control-worker.ts`

Insert after the `session_handle` check and before the `heartbeatProbe` call:

```ts
if (!process.stdout.isTTY) {
  console.error('orc control-worker requires an interactive terminal (stdout is not a TTY).');
  process.exit(1);
}
```

### Step 2 — Update attach message and remove log-path line

**File:** `cli/control-worker.ts`

```ts
// Before:
console.error(`Attaching to worker ${workerId} (debug) ...`);
adapter.attach(worker.session_handle);
const logPath = join(STATE_DIR, 'pty-logs', `${workerId}.log`);
console.error(`Log file: ${logPath}`);

// After:
console.error(`Attaching to ${workerId} (debug) — press Ctrl-b d to detach`);
adapter.attach(worker.session_handle);
// (no logPath line)
```

Remove the `join` import from `node:path` and the `STATE_DIR` import if they are no longer used after removing the log-path line. Do not remove them if they are still used elsewhere in the file.

---

## Acceptance criteria

- [ ] Running `orc control-worker <id>` in a non-TTY context exits 1 with a descriptive message.
- [ ] Running `orc control-worker <id>` in a TTY prints `Attaching to {workerId} (debug) — press Ctrl-b d to detach`.
- [ ] No `Log file:` line is printed.
- [ ] Interactive worker-selection prompt still works when no worker ID is provided.
- [ ] Role=master guard still exits 1 with its existing message.
- [ ] `npm test` passes.
- [ ] No changes to files outside `cli/control-worker.ts`.

---

## Tests

No new unit tests — the TTY guard is tested manually. The adapter's `attach()` is covered by Task 11.

---

## Verification

```bash
# Confirm no log-path reference remains
grep -n "pty-logs\|logPath\|Log file" cli/control-worker.ts  # should return nothing

# Confirm TTY guard present
grep -n "isTTY" cli/control-worker.ts

# Full suite
nvm use 24 && npm test
```
