# Task 74 — Codify Session Model: Master Foreground, Workers Headless

Depends on Task 73. Blocks Tasks 75–79.

## Scope

**In scope:**
- `orchestrator/contracts.md` — full rewrite to match PTY-backed session model
- `cli/start-session.mjs` — verify/tighten next-step output messaging
- `cli/attach.mjs` — add `--help` / usage output, verify wording
- `cli/start-worker-session.mjs` — verify headless messaging
- `cli/attach.test.mjs` — create if absent; add wording assertions

**Out of scope:**
- Provider adapter internals (`adapters/*`)
- Task dispatch/routing algorithms
- Any game runtime code under `src/`
- `orchestrator/README.md` (covered in Task 79)

---

## Current State (read before implementing)

### CLIs — already aligned
`start-session.mjs` (lines 255–261): already prints foreground + headless guidance:
```
✓ Starting <provider> CLI as master session...
  (Workers are managed in the background by the coordinator.)
Next steps:
  Register workers:   orc-worker-register <id> --provider=<claude|codex|gemini>
  Start workers:      orc-worker-start-session <id>
  Create tasks:       orc-task-create ...
  Monitor:            orc-watch
```
`start-worker-session.mjs` (lines 95–102): prints "Coordinator will start session on next tick" and `orc-attach` guidance.
`attach.mjs`: updated in a prior task, references PTY output log correctly.

### `contracts.md` — severely outdated (primary work for this task)
The current `contracts.md` describes the old API-key / SDK-backed model. Key stale sections:

| Section | Stale content | Correct state |
|---------|---------------|---------------|
| Session Handles | Format `<provider>:<uuid>` | Now `pty:{agentId}` (e.g. `pty:worker-01`) |
| Cross-process probing | "format-valid handles treated as reachable when API key present" | Now reads PID file at `STATE_DIR/pty-pids/{agentId}.pid` |
| `send()` semantics | "returns full assistant response text; may contain [ORC_EVENT] lines" | Fire-and-forget; returns `''` |
| `attach()` semantics | "prints most recent assistant response" | Prints last 8 KB of `STATE_DIR/pty-logs/{agentId}.log` |
| Worker Contract | "[ORC_EVENT] lines in response text" | Workers call `orc-run-start/finish/fail` CLI commands directly |
| Response Protocol | Full `[ORC_EVENT]` spec | Entire section should be removed |
| Provider Support table | Lists API keys | No API keys required; provider → binary mapping |

---

## Goals

1. `contracts.md` must accurately describe the PTY-backed session model.
2. `start-session.mjs` next-step output must explicitly name worker headless model.
3. `attach.mjs` must print actionable guidance for missing/offline session.
4. Non-interactive behavior remains deterministic and script-safe.

---

## Implementation

### Step 1 — Rewrite `contracts.md`

**File:** `orchestrator/contracts.md`

Replace the entire file. New structure:

```markdown
# Orchestrator Contracts

## Core State Files
(keep existing section — correct)

## Session Model

**Master session** — foreground CLI process started by `orc-start-session`.
The operator's terminal becomes the master agent UI. The coordinator continues
in the background after master exits.

**Worker sessions** — background PTY processes owned by the coordinator.
Coordinator calls `adapter.start(agentId, config)` on its first tick for each
registered worker with `session_handle: null`. Workers are never started in the
operator's terminal.

### Session Handles

Format: `pty:{agentId}` (e.g. `pty:worker-01`).

The handle is opaque to orchestrator core; only adapters interpret it.
Handles persist as long as the PTY process is alive. The coordinator calls
`adapter.start()` to obtain a new handle after a worker dies.

### Cross-process session probing

PTY sessions are owned by the coordinator process. The pty adapter writes a PID
file to `STATE_DIR/pty-pids/{agentId}.pid` on each `start()` call.
CLI tools (e.g. `orc-attach`, `orc-worker-gc`) use `process.kill(pid, 0)` against
the PID file for cross-process liveness checks.

## Adapter Interface
(keep method signatures)

### Method Semantics — PTY adapter

1. `start(agentId, config)` — Spawns the provider CLI binary as a PTY child process.
   Streams output to `STATE_DIR/pty-logs/{agentId}.log`. Writes PID file.
   Sends `config.system_prompt` to the PTY after 500 ms startup delay.

2. `send(sessionHandle, text)` — Writes text + newline to the PTY stdin.
   Fire-and-forget; returns `''`. State is driven by agent CLI calls, not response text.

3. `attach(sessionHandle)` — Prints last 8 KB of `STATE_DIR/pty-logs/{agentId}.log` to stdout.
   Prints `(no output log — agent session not yet started)` when log is absent.

4. `heartbeatProbe(sessionHandle)` — Returns true if PTY process is alive.
   Primary: checks in-process sessions Map. Fallback: reads PID file and probes with signal 0.

5. `stop(sessionHandle)` — Kills the PTY process and removes the PID file.

## Worker Contract

Workers are CLI agents running in background PTY sessions. They report lifecycle
by calling orchestrator CLI commands directly via their Bash tool:

- `orc-run-start --run-id=<id> --agent-id=<id>`
- `orc-run-heartbeat --run-id=<id> --agent-id=<id>`
- `orc-run-finish --run-id=<id> --agent-id=<id>`
- `orc-run-fail --run-id=<id> --agent-id=<id> --reason="..."`

Workers do NOT embed `[ORC_EVENT]` lines in response text. `[ORC_EVENT]` protocol is removed.

## Provider Support

| Provider | Binary | npm install |
|----------|--------|-------------|
| Claude | `claude` | `@anthropic-ai/claude-code` |
| Codex | `codex` | `@openai/codex` |
| Gemini | `gemini` | `@google/gemini-cli` |

No API keys or SDK credentials required. Provider binaries use their own auth.

## Dispatch and Claims
(keep existing section — still accurate)

## Public Binaries
(update list to add orc-run-start/heartbeat/finish/fail and orc-start-session)

## Invariants
(keep existing section — still accurate)
```

### Step 2 — Verify `start-session.mjs` next-step messaging

**File:** `cli/start-session.mjs` (lines 255–261)

Read the file. Verify:
- Output says "Workers are managed in the background by the coordinator."
- Next steps include `orc-worker-start-session` and `orc-watch`
- No phrasing implies a foreground worker shell is launched

No code changes expected; this step is verification only.

### Step 3 — Harden `attach.mjs` for missing session

**File:** `cli/attach.mjs`

Current code at line 29: if `agent.session_handle` is null → exits 1 with status message.
Current code at line 36–40: if heartbeat dead → exits 1.

Ensure the error messages tell the operator what to do next:
- Missing handle: `"Agent <id> has no active session. Run: orc-worker-start-session <id>"`
- Dead session: `"Session <handle> is unreachable. Run: orc-worker-start-session <id> --force-rebind"`

---

## Acceptance criteria

- [ ] `contracts.md` describes `pty:{agentId}` session handles (not `<provider>:<uuid>`).
- [ ] `contracts.md` Worker Contract section describes CLI commands (not `[ORC_EVENT]` lines).
- [ ] `contracts.md` has no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY` in the PTY model section.
- [ ] `contracts.md` `[ORC_EVENT]` response protocol section is removed.
- [ ] `start-session.mjs` output explicitly mentions headless worker background management.
- [ ] `attach.mjs` missing-session and dead-session error messages include actionable `orc-worker-start-session` guidance.
- [ ] No changes outside listed files.

---

## Tests

**File:** `cli/attach.test.mjs` (create if absent)

Pattern: use `spawnSync('node', ['cli/attach.mjs', ...], { cwd: repoRoot })` for
missing-agent and no-session-handle cases. For the alive/dead path, use dynamic import with
`vi.doMock('../lib/agentRegistry.mjs')` and `vi.doMock('../adapters/index.mjs')`.

Test cases:
- Exits 1 with usage when no agent_id provided
- Exits 1 with "Agent not found" when agent missing
- Exits 1 with guidance including "orc-worker-start-session" when session_handle is null
- Exits 1 with rebind guidance when heartbeat returns false
- Exits 0 and calls adapter.attach() when session alive

---

## Verification

```bash
cd orchestrator && npm test
node cli/attach.mjs  # no args → usage
node cli/attach.mjs nonexistent-agent 2>&1 | grep "not found"
```
