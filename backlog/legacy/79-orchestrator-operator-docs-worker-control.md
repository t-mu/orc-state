# Task 79 — Update Operator Docs for `start-session` and Worker Control

Depends on Tasks 74–78.

## Scope

**In scope:**
- `orchestrator/README.md` — full rewrite to match PTY-backed session model
- `orchestrator/contracts.md` — verify Task 74 completed; add anything still missing
- CLI file headers in `start-session.mjs`, `start-worker-session.mjs`, `control-worker.mjs`, `attach.mjs` — verify usage strings match actual flags

**Out of scope:**
- Product marketing docs
- Game design docs under `docs/` unrelated to orchestrator
- New architectural features
- `AGENTS.md` (currently non-existent; would be a new file — skip unless specifically requested)

---

## Current State (read before implementing)

### `orchestrator/README.md` — outdated (full rewrite needed)

Current README describes the **old API-key SDK model**:
- "Required Environment Variables" section lists `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`
- Quick Start: calls `orc-worker-register worker-01 --provider=claude` then `orc-worker-start-session worker-01 --provider=claude` then `orc-coordinator --mode=autonomous`
- Runtime Model: says "Workers return normal response text plus embedded `[ORC_EVENT]` JSON lines"

**All of this is obsolete.** The actual model:
- No API keys — providers use their own CLI auth (e.g. `claude` binary)
- Entry point is `orc-start-session` (interactive wizard) — not individual commands
- Workers use `orc-run-start/finish/fail` CLI commands, not `[ORC_EVENT]` lines
- Coordinator is started automatically by `orc-start-session`

### `orchestrator/contracts.md` — should be updated by Task 74
If Task 74 is complete, contracts.md should already reflect the PTY model.
Verify it contains: `pty:{agentId}` format, PTY worker lifecycle, no API key references.
If gaps remain, fill them here.

### CLI file header comments — check accuracy

| File | Current `Usage:` line | Flags to verify |
|------|----------------------|-----------------|
| `start-session.mjs` | `orc-start-session [--provider=<...>] [--agent-id=<id>]` | Also accepts `--worker-id`, `--worker-provider` |
| `start-worker-session.mjs` | lists `--provider`, `--role`, `--force-rebind` | Correct |
| `control-worker.mjs` | NEW — may not have header yet | Add usage header |
| `attach.mjs` | `orc-attach <agent_id>` | Correct |

---

## Goals

1. README.md matches the actual `orc-start-session` wizard entry point.
2. README.md documents worker ID policy (`orc-<N>` default).
3. README.md describes headless worker model (coordinator manages PTY sessions).
4. README.md quick start is executable with no API keys.
5. CLI file headers match actual flag signatures.

---

## Implementation

### Step 1 — Rewrite `orchestrator/README.md`

Replace the entire file content:

```markdown
# @t-mu/orc-state

Provider-agnostic orchestration runtime for autonomous coding agents.
Workers run as CLI agents in background PTY sessions (no API keys required).

## Runtime Model

- **Master session** — foreground CLI started by `orc-start-session`. The operator's
  terminal becomes the master agent UI.
- **Worker sessions** — background PTY processes managed by the coordinator. Workers
  report task lifecycle by calling `orc-run-*` CLI commands directly.
- **Coordinator** — background process started automatically by `orc-start-session`.
  Dispatches tasks, monitors PTY liveness, retries dead sessions.
- **State** — file-backed under `ORCH_STATE_DIR` (`./orc-state` by default):
  `backlog.json`, `agents.json`, `claims.json`, `events.jsonl`.

## Provider Binaries

| Provider | Binary | Install |
|----------|--------|---------|
| Claude | `claude` | `npm install -g @anthropic-ai/claude-code` |
| Codex | `codex` | `npm install -g @openai/codex` |
| Gemini | `gemini` | `npm install -g @google/gemini-cli` |

No `ANTHROPIC_API_KEY` or similar env vars required. Provider CLIs handle their own auth.

## Quick Start

### 1. Start a session (interactive)

```bash
orc-start-session
```

The wizard guides you through:
1. Coordinator — start or reuse
2. Master agent — register or reuse (prompts for provider)
3. Worker pool — reuse, clear, or create workers
4. Master foreground session opens when wizard completes

Workers created in the wizard are assigned auto IDs (`orc-1`, `orc-2`, …) and
started in the background by the coordinator.

### 2. Non-interactive (CI / scripted)

```bash
orc-start-session --provider=claude --agent-id=master \
  --worker-provider=claude
```

Flags:
- `--provider=<claude|codex|gemini>` — master provider
- `--agent-id=<id>` — master agent ID (default: `master`)
- `--worker-id=<id>` — worker ID override (default: auto `orc-<N>`)
- `--worker-provider=<claude|codex|gemini>` — creates one worker in non-interactive mode

### 3. Start an additional worker later

```bash
orc-worker-start-session orc-2 --provider=claude
```

The coordinator picks up the registration and starts the PTY on its next tick.

### 4. Control a worker

```bash
orc-control-worker orc-1        # view PTY log tail
orc-control-worker               # interactive list picker

# Live stream (shell):
tail -f "$ORCH_STATE_DIR/pty-logs/orc-1.log"
```

### 5. Monitor

```bash
orc-status          # agent list + status
orc-watch           # live watch loop
orc-runs-active     # active task runs
orc-events-tail     # event stream
```

### 6. Create and assign tasks

```bash
orc-task-create --epic=project --ref=feat-1 --title="Add login page"
orc-delegate --task-ref=feat-1 --agent=orc-1
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCH_STATE_DIR` | `./orc-state` | Path to state directory |

## Worker ID Policy

New workers created via `orc-start-session` are auto-assigned IDs `orc-1`, `orc-2`, …
(lowest available gap). Override with `--worker-id=<custom-id>`.

## See Also

- `orchestrator/contracts.md` — session model, adapter interface, worker protocol
- `docs/backlog/` — development task history
```

### Step 2 — Verify/update CLI file headers

**File:** `cli/start-session.mjs` (lines 8–14)

Update the `Usage:` comment to include worker flags:
```js
 * Usage:
 *   orc-start-session [--provider=<claude|codex|gemini>] [--agent-id=<id>]
 *                     [--worker-id=<id>] [--worker-provider=<claude|codex|gemini>]
```

**File:** `cli/control-worker.mjs` (line 1–10)

Add a standard header if Task 75 didn't include one:
```js
#!/usr/bin/env node
/**
 * cli/control-worker.mjs
 * Usage: orc-control-worker [<worker_id>]
 *
 * Attaches to a worker's PTY output log. Selects interactively when <worker_id>
 * is omitted. Exits 1 for master agents or missing/offline sessions.
 */
```

### Step 3 — Verify `contracts.md` (Task 74 deliverable)

Read `orchestrator/contracts.md`. If Task 74 is complete, verify:
- [ ] Session handle format is `pty:{agentId}`
- [ ] No `[ORC_EVENT]` response protocol section
- [ ] Worker Contract describes `orc-run-*` CLI commands
- [ ] Provider Support table lists binaries (not API keys)

If any of the above are missing, apply the same rewrite described in Task 74.

---

## Acceptance criteria

- [ ] `README.md` does not mention `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`.
- [ ] `README.md` does not mention `[ORC_EVENT]` lines.
- [ ] `README.md` Quick Start is executable as written (no missing steps).
- [ ] `README.md` documents `orc-control-worker` command.
- [ ] `README.md` documents worker ID auto-numbering policy.
- [ ] `start-session.mjs` usage comment includes `--worker-id` and `--worker-provider`.
- [ ] `control-worker.mjs` has a usage comment.
- [ ] `contracts.md` is consistent with README (no contradictory info).
- [ ] No doc files reference "tmux" as the session mechanism.

---

## Tests

No new automated tests required for this task.

Manual verification:
```bash
node cli/start-session.mjs --help 2>&1 | head -5
node cli/control-worker.mjs --help 2>&1 | head -5
grep -r "ANTHROPIC_API_KEY" orchestrator/README.md   # should return nothing
grep -r "ORC_EVENT" orchestrator/contracts.md         # should return nothing
```

---

## Verification

```bash
cd orchestrator && npm test   # no regressions
```
