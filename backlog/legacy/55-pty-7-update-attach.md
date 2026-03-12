# Task 55 — Update `cli/attach.mjs`

Depends on Task 52 (pty adapter active). Blocks Task 58.

---

## Scope

**In scope:**
- `cli/attach.mjs` — update messaging and remove tmux-specific hints

**Out of scope:**
- Adapter implementation — `attach()` behaviour is already correct after Task 51
- Any other CLI scripts — do not touch

---

## Context

`orc-attach <agent_id>` resolves the agent's `session_handle` from `agents.json`, calls `adapter.heartbeatProbe()` to confirm the session is alive, then calls `adapter.attach()` to print output.

After the pty migration, `adapter.attach()` reads the last 8 KB from `STATE_DIR/pty-logs/{agentId}.log` instead of running `tmux capture-pane`. The command output and messaging should reflect this.

Specific changes:
- Remove the tmux interactive session tip: `"Tip: for a live interactive view, run: tmux attach-session -t orc"`
- Update the `console.error` status line to describe log-file output rather than pane capture
- Print the log file path so users know where to find the full output
- Remove the `ORCH_TMUX_SESSION` env var reference (no longer meaningful)
- Update the file header comment

**Affected files:**
- `cli/attach.mjs`

---

## Goals

1. Must remove all tmux references from the file (the interactive view tip and the `ORCH_TMUX_SESSION` variable).
2. Must update the status `console.error` line to say "Reading output log" rather than "Capturing tmux pane output".
3. Must print the log file path (`STATE_DIR/pty-logs/{agentId}.log`) for user reference.
4. Must preserve the existing logic: agent lookup, `heartbeatProbe` check, `adapter.attach()` call.
5. Must not change the exit codes or error paths.

---

## Implementation

### Step 1 — Update the file header comment

```js
// before
/**
 * cli/attach.mjs
 * ...
 * Resolve agent_id -> session_handle from agents.json, then delegate to the
 * provider adapter's attach() behavior (tmux mode: capture pane output).
 */

// after
/**
 * cli/attach.mjs
 * Usage: node cli/attach.mjs <agent_id>
 *
 * Resolve agent_id -> session_handle from agents.json, then print the tail
 * of the agent's PTY output log via adapter.attach().
 */
```

### Step 2 — Remove `ORCH_TMUX_SESSION` reference and update status line

Find:
```js
console.error(`Capturing tmux pane output for ${agentId} (${agent.session_handle}) ...`);
```
Replace with:
```js
console.error(`Reading output log for ${agentId} ...`);
```

### Step 3 — Add log path hint

After `adapter.attach(agent.session_handle)`, add:
```js
const logPath = join(STATE_DIR, 'pty-logs', `${agentId}.log`);
console.error(`Log file: ${logPath}`);
```

Add the `join` import from `node:path` if not already present (check existing imports).
Add `STATE_DIR` import from `../lib/paths.mjs` if not already imported (it likely already is via `getAgent`).

### Step 4 — Remove the tmux tip

Find and delete:
```js
const sessionName = process.env.ORCH_TMUX_SESSION ?? 'orc';
console.error(`Tip: for a live interactive view, run: tmux attach-session -t ${sessionName}`);
```

---

## Acceptance criteria

- [ ] `orc-attach <agent_id>` prints the log file path after showing output.
- [ ] No tmux references remain in the file.
- [ ] The `ORCH_TMUX_SESSION` env var is not read.
- [ ] Exit codes are unchanged: 0 on success, 1 when agent not found or session unreachable.
- [ ] `npm run lint` passes.
- [ ] No other files are modified.

---

## Tests

Add to `cli/attach.test.mjs`:

```js
it('prints log path after output', async () => { ... });
it('no reference to tmux in output', async () => { ... });
```

---

## Verification

```bash
nvm use 24 && npm run lint
npm run test:orc:unit
```
