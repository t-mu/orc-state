---
ref: general/8-update-attach-cli
feature: general
priority: normal
status: todo
---

# Task 8 — Update cli/attach.ts for Interactive tmux Attach

Depends on Task 7. Blocks Task 13.

## Scope

**In scope:**
- `cli/attach.ts`: add a TTY guard, update messaging, remove log-path print
- The `adapter.attach()` call already executes `tmux attach-session` after Task 6 — this task updates the CLI wrapper to match

**Out of scope:**
- `cli/control-worker.ts` (Task 9)
- Any changes to `adapters/tmux.ts` or `adapters/index.ts`
- Removing `pty-logs/` infrastructure (Task 13)

---

## Context

After Task 7, `adapter.attach(session_handle)` calls `spawnSync('tmux', ['attach-session', ...], { stdio: 'inherit' })`. The current `cli/attach.ts` wrapper still prints a log-file path and has no TTY guard. This task updates the wrapper to match the new semantics: interactive attach requires a real terminal, and the log-file path line no longer applies.

### Current state

`cli/attach.ts` calls `adapter.attach()` (which previously tailed a log file) then prints `Log file: .orc-state/pty-logs/{agentId}.log`. There is no TTY check.

### Desired state

`cli/attach.ts` guards against non-TTY stdout, prints an informational message (`Attaching to {agentId} — press Ctrl-b d to detach`), calls `adapter.attach()`, and does not print a log path.

### Start here

- `cli/attach.ts` — read in full before editing; it is ~44 lines

**Affected files:**
- `cli/attach.ts` — add TTY guard, update messaging, remove log-path line

---

## Goals

1. Must exit 1 with a clear message when `process.stdout.isTTY` is falsy.
2. Must print `Attaching to {agentId} — press Ctrl-b d to detach` before calling `adapter.attach()`.
3. Must not print the `Log file: ...` line.
4. Must retain the `heartbeatProbe` aliveness check before attempting to attach.
5. Must retain agent-not-found and no-session-handle error paths unchanged.

---

## Implementation

### Step 1 — Add TTY guard after agent resolution

**File:** `cli/attach.ts`

Insert after the `session_handle` check and before the `heartbeatProbe` call:

```ts
if (!process.stdout.isTTY) {
  console.error('orc attach requires an interactive terminal (stdout is not a TTY).');
  console.error('Use: orc attach <agent_id>  from a real terminal session.');
  process.exit(1);
}
```

### Step 2 — Print attach message and remove log-path line

**File:** `cli/attach.ts`

```ts
// Before:
console.error(`Reading output log for ${agentId} ...`);
// ... heartbeatProbe ...
adapter.attach(agent.session_handle);
const logPath = join(STATE_DIR, 'pty-logs', `${agentId}.log`);
console.error(`Log file: ${logPath}`);

// After:
// ... heartbeatProbe (unchanged) ...
console.error(`Attaching to ${agentId} — press Ctrl-b d to detach`);
adapter.attach(agent.session_handle);
// (no logPath line)
```

Remove the `join` import from `node:path` and the `STATE_DIR` import if they are no longer used after removing the log-path line. Do not remove them if they are still used elsewhere in the file.

---

## Acceptance criteria

- [ ] Running `orc attach <agent_id>` in a non-TTY context (e.g. piped) exits 1 with a descriptive message.
- [ ] Running `orc attach <agent_id>` in a TTY prints `Attaching to {agentId} — press Ctrl-b d to detach`.
- [ ] No `Log file:` line is printed.
- [ ] Agent-not-found and no-session-handle error paths still exit 1 with their existing messages.
- [ ] `npm test` passes.
- [ ] No changes to files outside `cli/attach.ts`.

---

## Tests

No new unit tests — the TTY guard is tested manually during verification. The adapter's `attach()` is covered by Task 11.

---

## Verification

```bash
# Confirm no log-path reference remains
grep -n "pty-logs\|logPath\|Log file" cli/attach.ts  # should return nothing

# Confirm TTY guard present
grep -n "isTTY" cli/attach.ts  # should show the guard

# Full suite
nvm use 24 && npm test
```
