# Task 47 — Update `cli/attach.mjs` (tmux Pane Output)

Depends on Tasks 41 and 42. Independent of Tasks 43–46.

---

## Scope

**In scope:**
- Rewrite `cli/attach.mjs` to work with tmux session handles
- `adapter.attach()` now captures tmux pane output instead of printing in-memory conversation history

**Out of scope:**
- `adapters/tmux.mjs` — `attach()` already implemented there (Task 41)
- No changes to other CLI scripts or lib files

---

## Context

### Current `attach.mjs` flow

```
1. Parse agentId from argv
2. getAgent(STATE_DIR, agentId)
3. createAdapter(agent.provider)
4. adapter.heartbeatProbe(session_handle)
5. adapter.attach(session_handle)  → prints last assistant message from in-memory history
```

With SDK adapters, `attach()` printed the most recent assistant message stored in the
adapter's in-memory `sessions` map. This only worked in the same process as the coordinator.

With the tmux adapter, `attach()` runs `tmux capture-pane -p -t {target}` and prints
the raw terminal output. This works from any process — the tmux pane is shared state.

### The "note" to update

`attach.mjs` currently prints (line 40–41):
```
Note: session history is held in coordinator memory. For live interaction, attach directly.
```

This should be updated to explain the new behaviour — it now shows raw tmux terminal
output, not parsed conversation history.

### New output guidance

After printing pane output, suggest:
```
Tip: For a live interactive view, run: tmux attach-session -t orc
```

**Affected files:**
- `cli/attach.mjs` — update messaging, remove stale SDK-specific notes

---

## Goals

1. Must call `adapter.attach(session_handle)` as before — the adapter handles the tmux capture
2. Must update the informational messages to reflect tmux pane capture (not in-memory history)
3. Must print a `tmux attach-session` tip after the output
4. Must keep the same error handling for missing agent, missing session_handle, dead session

---

## Implementation

### Step 1 — Read current `cli/attach.mjs`

Read the full file. Confirm the lines that print the SDK-specific note (around lines 40–41).

### Step 2 — Update the informational messages

Replace the SDK-specific note:
```js
// BEFORE (remove):
console.error('Note: session history is held in coordinator memory. For live interaction, attach directly.');

// AFTER (add after adapter.attach() call):
const sessionName = process.env.ORCH_TMUX_SESSION ?? 'orc';
console.error(`Tip: for a live interactive view, run: tmux attach-session -t ${sessionName}`);
```

Update the header line (line ~34) from:
```js
console.error(`Fetching last response for ${agentId} via ${provider} ...`);
```
to:
```js
console.error(`Capturing tmux pane output for ${agentId} (${agent.session_handle}) ...`);
```

### Step 3 — No changes to logic

The `heartbeatProbe` check, the `getAgent` lookup, and the `adapter.attach()` call all
remain unchanged.

---

## Acceptance criteria

- [ ] `orc-attach bob` prints recent tmux pane output (or "(could not capture pane output)" if dead)
- [ ] Prints a `tmux attach-session` tip after the output
- [ ] No mention of "coordinator memory" or "session history" in the output
- [ ] Exits 1 with error when agent not found or session_handle is null (unchanged behaviour)
- [ ] Exits 1 with error when heartbeatProbe returns false (unchanged behaviour)

---

## Tests

No new test needed. Covered by tmux adapter tests (Task 48) which verify `attach()` captures
pane output. Manual smoke test in verification below.

---

## Verification

```bash
# With a live tmux session and worker window
tmux new-session -s orc -d
ORCH_TMUX_SESSION=orc orc-worker-start-session bob --provider=claude
orc-attach bob
# Expected: shows raw terminal output from the bob tmux window
# Expected: prints "Tip: for a live interactive view, run: tmux attach-session -t orc"

# With a dead session
orc-attach nonexistent-agent
# Expected: exit 1, "Agent not found"
```
