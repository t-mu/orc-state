# Task 46 — Update `cli/start-worker-session.mjs` (tmux Session Guard)

Depends on Tasks 41 and 42 (tmux adapter exists and is wired). Independent of Tasks 43–45.

---

## Scope

**In scope:**
- Add a tmux session existence check to `cli/start-worker-session.mjs`
- Print a clear error with setup instructions if the tmux session doesn't exist
- Print the tmux window target after session start for user orientation

**Out of scope:**
- `lib/sessionBootstrap.mjs` — unchanged
- `adapters/tmux.mjs` — unchanged
- No changes to agent registration, claim logic, or other CLI scripts

---

## Context

With the SDK adapters, `adapter.start()` just created an in-memory session — no external
setup required. With the tmux adapter, `adapter.start()` calls `tmux new-window`, which
requires a tmux session (`ORCH_TMUX_SESSION`, default `orc`) to already exist.

If the user runs `orc-worker-start-session bob` before creating the tmux session, they will
get an unhelpful error from tmux. This task adds a pre-flight check with a clear error
message and remediation instructions.

### Current `start-worker-session.mjs` flow (lines 59–105)

1. `createAdapter(worker.provider)` — now returns tmux adapter
2. If session_handle exists: `heartbeatProbe()` → determine if still alive
3. If no session_handle: `adapter.start(agentId, { system_prompt: bootstrap })`
4. Store session_handle + provider_ref in registry

The tmux session guard should be added before step 3 (before calling `adapter.start()`).

### tmux session check

```bash
tmux has-session -t {sessionName}
# exit 0 = session exists, non-zero = does not exist
```

Implemented via `execFileSync('tmux', ['has-session', '-t', sessionName])` with try/catch.
The session name comes from `process.env.ORCH_TMUX_SESSION ?? 'orc'`.

### Error message to show

```
Error: tmux session 'orc' not found.
Create it first:

  tmux new-session -s orc -d

Then re-run this command.
Set ORCH_TMUX_SESSION=<name> to use a different session name.
```

### Output after successful start

After `adapter.start()`, add a line showing the tmux target so the user knows where the
agent window is:

```
✓ Worker session started: tmux:orc:bob
  Attach: tmux attach-session -t orc (then select window 'bob')
```

**Affected files:**
- `cli/start-worker-session.mjs` — add guard + improved output

---

## Goals

1. Must check for tmux session existence before calling `adapter.start()`
2. Must print a clear error and `process.exit(1)` if the session doesn't exist
3. Must print the tmux target and attach hint after a successful session start
4. Must not change any existing agent registration or session lifecycle logic
5. Must skip the check when `--force-rebind` is not starting a new session (heartbeat probe path)

---

## Implementation

### Step 1 — Read current `cli/start-worker-session.mjs`

Read the file fully before editing. Confirm exact line numbers for the session-start path.

### Step 2 — Add tmux guard before `adapter.start()`

Import `execFileSync` from `node:child_process` at the top if not already imported.

Add a helper function:

```js
function assertTmuxSessionExists() {
  const sessionName = process.env.ORCH_TMUX_SESSION ?? 'orc';
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' });
  } catch {
    console.error(`Error: tmux session '${sessionName}' not found.`);
    console.error(`Create it first:\n\n  tmux new-session -s ${sessionName} -d\n`);
    console.error(`Then re-run this command.`);
    console.error(`Set ORCH_TMUX_SESSION=<name> to use a different session name.`);
    process.exit(1);
  }
}
```

Call `assertTmuxSessionExists()` immediately before the `adapter.start()` call in the
"no session_handle" branch. Do NOT call it in the heartbeat probe branch (session may
already be alive even if the user changed their tmux session name).

### Step 3 — Improve output after successful start

After `adapter.start()` returns and the handle is stored, print:

```js
const sessionName = process.env.ORCH_TMUX_SESSION ?? 'orc';
console.log(`✓ Worker session started: ${session_handle}`);
console.log(`  Attach: tmux attach-session -t ${sessionName}  (select window '${worker.agent_id}')`);
```

---

## Acceptance criteria

- [ ] Running `orc-worker-start-session bob` without a tmux session exits 1 with a message containing the tmux session name and the `tmux new-session` command
- [ ] Running with an existing tmux session proceeds to open a window without error
- [ ] The attach hint is printed after a successful start
- [ ] `--force-rebind` still works when the session exists
- [ ] No changes to agent registration fields or registry file format

---

## Tests

No dedicated test file needed. The error path is covered by the tmux adapter tests (Task 48)
which mock `execFileSync`. Manual smoke test via verification steps below.

---

## Verification

```bash
# Test the guard — no tmux session running
ORCH_TMUX_SESSION=nonexistent-orc-session \
  node cli/start-worker-session.mjs bob --provider=claude
# Expected: exit 1, error message with 'tmux new-session -s nonexistent-orc-session -d'

# Test the happy path — session exists
tmux new-session -s orc-test -d
ORCH_TMUX_SESSION=orc-test node cli/start-worker-session.mjs bob --provider=claude
# Expected: tmux window 'bob' created in 'orc-test', prints attach hint
tmux kill-session -t orc-test  # cleanup
```
