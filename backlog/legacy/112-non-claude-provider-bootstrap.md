---
ref: orch/task-112-non-claude-provider-bootstrap
epic: orch
status: done
---

# Task 112 — Deliver Bootstrap for Non-Claude Master Providers

Independent. Blocks Task 113.

## Scope

**In scope:**
- `cli/start-session.mjs` — extend the provider-specific spawn-args block to handle `codex` and `gemini` providers with appropriate CLI flags
- `templates/` — add `master-bootstrap-codex-v1.txt` and `master-bootstrap-gemini-v1.txt` templates (may be identical to the Claude template in content initially; provider-specific flags differ)
- `lib/binaryCheck.mjs` — verify `PROVIDER_BINARIES` entries for `codex` and `gemini` are correct

**Out of scope:**
- Changes to worker session bootstrap (workers use adapter.start() which is already provider-agnostic)
- Changes to PTY prompt pattern or bracketed paste logic (Task 113)
- Changes to coordinator.mjs

## Context

`start-session.mjs` gates all bootstrap and MCP wiring behind `if (master.provider === 'claude')`:

```js
// start-session.mjs lines 334-356:
if (master.provider === 'claude') {
  const mcpConfigPath = writeMcpConfig();
  const bootstrap = renderTemplate('master-bootstrap-v1.txt', { ... });
  spawnArgs = ['--mcp-config', mcpConfigPath, '--system-prompt', bootstrap];
  ...
}
// For codex / gemini: spawnArgs = []  ← no bootstrap, no MCP
```

A Codex or Gemini master agent starts with no system prompt and no MCP tools, making it unable to fulfill the orchestration role. Each provider CLI has different flags for injecting a system prompt:

- **Claude Code**: `--system-prompt <text>` and `--mcp-config <path>`
- **Codex**: `--instructions <text>` (MCP config via `--mcp-servers` JSON or config file — research required)
- **Gemini CLI**: `--system-instruction <text>` (MCP via `--mcp-config <path>` as of Gemini CLI 0.1+)

**Affected files:**
- `cli/start-session.mjs` — provider bootstrap dispatch
- `templates/master-bootstrap-codex-v1.txt` — new
- `templates/master-bootstrap-gemini-v1.txt` — new

## Goals

1. Must pass a system prompt (bootstrap) to Codex master sessions via the correct CLI flag.
2. Must pass a system prompt (bootstrap) to Gemini master sessions via the correct CLI flag.
3. Must wire MCP config for providers that support it (Gemini supports `--mcp-config`; Codex MCP support should be documented if unavailable).
4. Must fall through to a logged warning (not a hard failure) if a provider's MCP flag is unknown, so the session still starts with the bootstrap text.
5. Must not break the existing Claude provider path.

## Implementation

### Step 1 — Add provider bootstrap templates

**Files:** `templates/master-bootstrap-codex-v1.txt`, `templates/master-bootstrap-gemini-v1.txt`

Copy the content of `master-bootstrap-v1.txt`. Provider-specific sections (e.g. tool names) can be adjusted in a follow-up task once the templates are in place.

### Step 2 — Extend start-session.mjs spawn-args dispatch

**File:** `cli/start-session.mjs`

Replace the `if (master.provider === 'claude')` block with a switch/map:

```js
const mcpConfigPath = writeMcpConfig();
const bootstrap = renderTemplate(`master-bootstrap-${master.provider}-v1.txt`, {
  agent_id: master.agent_id,
  provider: master.provider,
}).catch?.() ?? renderTemplate('master-bootstrap-v1.txt', { ... }); // fallback

switch (master.provider) {
  case 'claude':
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-prompt', bootstrap];
    break;
  case 'gemini':
    spawnArgs = ['--mcp-config', mcpConfigPath, '--system-instruction', bootstrap];
    break;
  case 'codex':
    // Codex does not yet support --mcp-config; pass bootstrap only
    console.warn('[start-session] Codex MCP wiring not available; MCP tools will be absent.');
    spawnArgs = ['--instructions', bootstrap];
    break;
  default:
    console.warn(`[start-session] Unknown provider '${master.provider}'; starting without bootstrap.`);
    spawnArgs = [];
}
```

## Acceptance criteria

- [ ] A Codex master session starts with `--instructions <bootstrap>` in spawnArgs.
- [ ] A Gemini master session starts with `--mcp-config <path> --system-instruction <bootstrap>`.
- [ ] The Claude path is unchanged.
- [ ] `master-bootstrap-codex-v1.txt` and `master-bootstrap-gemini-v1.txt` exist in `templates/`.
- [ ] An unknown provider logs a warning and starts without crashing.
- [ ] `nvm use 24 && npm test` passes.
- [ ] No changes to files outside the stated scope.

## Tests

No automated integration tests for PTY spawn (requires a live CLI binary). Verify by:
1. Reading the modified `start-session.mjs` and confirming the switch statement is correct.
2. Confirming template files exist with non-empty content.

## Verification

```bash
nvm use 24 && npm test
# Manual: orc-start-session --provider=gemini --agent-id=master-test
# Confirm bootstrap text appears in the session
```

## Open questions

- Codex MCP flag name: if Codex adds `--mcp-config` support, update the `codex` case to include it. Document the flag in a comment if unknown at implementation time.
