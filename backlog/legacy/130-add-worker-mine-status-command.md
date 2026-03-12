---
ref: orch/task-130-add-worker-mine-status-command
epic: orch
status: done
---

# Task 130 — Add Worker `status --mine` Command Support

Independent. Blocks Task 131.

## Scope

**In scope:**
- `cli/status.mjs` — add a documented `--mine` mode with explicit agent targeting
- `lib/statusView.mjs` — build filtered status output for one agent without breaking existing output
- `cli/orc.mjs` — ensure `orc status --mine` forwards arguments unchanged
- `templates/worker-bootstrap-v2.txt` — keep worker instructions aligned with the real CLI contract
- `cli/status.test.mjs` and/or `lib/statusView.test.mjs` — cover the new worker-facing mode

**Out of scope:**
- Changing task dispatch policy, claim lifecycle, or coordinator nudging
- Adding new MCP tools or changing MCP schemas
- Refactoring unrelated CLI commands or status formatting outside the new `--mine` path

## Context

The current worker bootstrap tells autonomous workers to run `orc status --mine`, but the actual status CLI only accepts `--json`. That is an execution-time mismatch in the worker contract, not just a documentation problem. An LLM worker following the bootstrap literally will invoke an unsupported command path and fail before it can even discover assigned work.

The fix should make the documented worker command real, compact, and deterministic. The worker-facing output must answer one question quickly: "Do I have assigned work, and if so, what action is required next?" The implementation should not depend on hidden session state; agent identity must come from an explicit flag or another deterministic source.

**Affected files:**
- `cli/status.mjs` — current CLI entrypoint for status
- `lib/statusView.mjs` — builds status data and terminal output
- `cli/orc.mjs` — subcommand dispatcher used by worker prompts
- `templates/worker-bootstrap-v2.txt` — active worker instruction contract
- `cli/status.test.mjs` — CLI coverage for status behavior

## Goals

1. Must make `orc status --mine` a supported, tested command path.
2. Must require deterministic agent selection for `--mine` mode, either via explicit `--agent-id=<id>` or a well-documented equivalent.
3. Must show only the requesting agent's assigned tasks and active claims in `--mine` mode.
4. Must keep existing default status output and `--json` behavior backward-compatible.
5. Must update the worker bootstrap so every documented status command exists exactly as written.

## Implementation

### Step 1 — Define the worker-specific CLI contract

**File:** `cli/status.mjs`

```js
const json = process.argv.includes('--json');
const mine = process.argv.includes('--mine');
const agentId = flag('agent-id');

if (mine && !agentId) {
  console.error('Usage: orc-status --mine --agent-id=<id> [--json]');
  process.exit(1);
}
```

Preserve the current default command shape. Do not infer agent identity from PTY session state.

### Step 2 — Add filtered status data and output helpers

**File:** `lib/statusView.mjs`

```js
export function buildAgentStatus(stateDir, agentId) {
  const status = buildStatus(stateDir);
  return {
    agent: status.agents.list.find((agent) => agent.agent_id === agentId) ?? null,
    assigned_tasks: status.claims.active.filter((claim) => claim.agent_id === agentId),
    queued_tasks: /* non-terminal tasks with owner === agentId */,
  };
}
```

Keep the existing `buildStatus()` and `formatStatus()` behavior stable. Add a dedicated formatter for the mine view instead of overloading the global formatter.

### Step 3 — Keep the worker bootstrap aligned with the implemented command

**File:** `templates/worker-bootstrap-v2.txt`

```txt
When you receive the message CHECK_WORK, immediately run:

  orc status --mine --agent-id={{agent_id}}
```

Update every `status --mine` reference in the template to the exact supported command syntax.

### Step 4 — Add focused CLI tests

**File:** `cli/status.test.mjs`

```js
it('prints agent-scoped status for --mine --agent-id');
it('returns code 1 when --mine is used without --agent-id');
it('preserves existing status output when --mine is absent');
```

Cover both human-readable and JSON output paths if both are supported for `--mine`.

## Acceptance criteria

- [ ] `orc status --mine --agent-id=<id>` exits 0 and returns only that agent's relevant work state.
- [ ] `orc status --mine` without an agent id exits with code 1 and a descriptive usage message.
- [ ] The existing `orc status` and `orc status --json` outputs remain unchanged for non-`--mine` callers.
- [ ] `templates/worker-bootstrap-v2.txt` references only supported status commands.
- [ ] Tests cover the happy path and the missing-agent-id failure path.
- [ ] No changes to files outside the stated scope.

## Tests

Add to `cli/status.test.mjs`:

```js
it('prints only agent-scoped work for --mine --agent-id=orc-1', () => { ... });
it('fails when --mine is passed without --agent-id', () => { ... });
it('keeps legacy status output stable when --mine is omitted', () => { ... });
```

## Verification

```bash
nvm use 24 && npm test
nvm use 24 && npm run test:orc
```

```bash
npm run orc:doctor
npm run orc:status
```

## Risk / Rollback

**Risk:** Changing the CLI contract for worker status could break existing operator scripts or worker bootstrap flows if argument parsing is inconsistent between `orc` and `orc-status`.
**Rollback:** `git restore cli/status.mjs lib/statusView.mjs cli/orc.mjs templates/worker-bootstrap-v2.txt cli/status.test.mjs && nvm use 24 && npm run test:orc`
