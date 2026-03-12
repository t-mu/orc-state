# Task 83 — Integrate MCP Server into `orc-start-session`

Depends on Tasks 80–82. Blocks Task 84.

## Scope

**In scope:**
- `cli/start-session.mjs` — write MCP config; pass `--mcp-config` to claude
- `cli/start-session.test.mjs` — assert MCP config written and claude gets flag

**Out of scope:**
- Master bootstrap changes (Task 84)
- MCP server tool implementations (Tasks 81–82)
- Other providers (codex/gemini): MCP integration is claude-only for now

---

## Context

### How MCP works with the claude binary

The `claude` CLI (Claude Code) supports MCP servers configured in a JSON file:
```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/server.mjs"],
      "env": { "ORCH_STATE_DIR": "/absolute/path/to/orc-state" }
    }
  }
}
```

When started with `claude --mcp-config /path/to/config.json`, the claude binary:
1. Reads the config file
2. Spawns `node mcp/server.mjs` as a child process
3. Communicates with it via stdin/stdout (MCP JSON-RPC)
4. Exposes the MCP tools to the active claude session

**Verify the flag name before implementing.** Run `claude --help` and search for `mcp-config`.
If the flag is different (e.g. `--config` or requires env var), adjust accordingly.

### Current master spawn in `start-session.mjs` (line 263)

```js
const binary = PROVIDER_BINARIES[master.provider] ?? master.provider;
const cli = spawn(binary, [], { stdio: 'inherit' });
```

This becomes:
```js
const binary = PROVIDER_BINARIES[master.provider] ?? master.provider;
const spawnArgs = master.provider === 'claude'
  ? ['--mcp-config', mcpConfigPath]
  : [];
const cli = spawn(binary, spawnArgs, { stdio: 'inherit' });
```

### MCP config file location

Write to `STATE_DIR/mcp-config.json`. This is:
- Co-located with other state files
- Absolute paths ensure the server is found regardless of cwd

### MCP server binary path

Use `fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))` to get the absolute path
to `server.mjs` relative to `start-session.mjs`.

---

## Goals

1. `orc-start-session` with `--provider=claude` writes MCP config and passes it to claude.
2. MCP config contains absolute paths (state dir, server script).
3. Non-claude providers are unaffected — no `--mcp-config` flag passed.
4. MCP config is written before spawning the CLI (so claude can read it immediately).
5. No change to the coordinator spawn or the rest of the wizard flow.

---

## Implementation

### Step 1 — Verify the `--mcp-config` flag name (do this first)

**Before writing any code**, run:
```bash
claude --help 2>&1 | grep -i mcp
claude --help 2>&1 | grep -i config
```

The flag name may be `--mcp-config`, `--config`, or require an env var approach.
If the flag is different, adjust Steps 2–3 accordingly.

If `--mcp-config` doesn't exist, check if an env var like `CLAUDE_CODE_MCP_SERVERS`
(JSON string) works instead:
```js
const mcpEnv = JSON.stringify({ mcpServers: { orchestrator: { command, args, env } } });
// spawn('claude', [], { stdio: 'inherit', env: { ...process.env, CLAUDE_CODE_MCP_SERVERS: mcpEnv } });
```
Document whichever approach works in the implementation.

### Step 2 — Add missing import to `start-session.mjs`

**File:** `cli/start-session.mjs`

The current import line 17:
```js
import { resolve, join } from 'node:path';
```

Add `node:url` import (not currently present):
```js
import { fileURLToPath } from 'node:url';
```

Add a helper function after the `stopCoordinator` function:

```js
// ── MCP config ──────────────────────────────────────────────────────────────

/**
 * Write the MCP server config JSON to STATE_DIR/mcp-config.json.
 * Returns the path to the written file.
 * Only called when provider is 'claude'.
 */
function writeMcpConfig() {
  const serverPath = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
  const config = {
    mcpServers: {
      orchestrator: {
        command: process.execPath,     // absolute path to node binary — same as what runs this script
        args: [serverPath],            // absolute path to server.mjs
        env: { ORCH_STATE_DIR: STATE_DIR },
      },
    },
  };
  // STATE_DIR is guaranteed to exist here: state files are read at lines 130–132
  // (listAgents, coordinatorStatus) which require the directory to exist.
  // Call mkdirSync anyway as a safety guard for edge cases:
  mkdirSync(STATE_DIR, { recursive: true });
  const configPath = join(STATE_DIR, 'mcp-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
```

### Step 3 — Pass config to claude spawn

**File:** `cli/start-session.mjs` (lines 246–268, the "Master foreground session" section)

Replace:
```js
const cli = spawn(binary, [], { stdio: 'inherit' });
```

With:
```js
let spawnArgs = [];
if (master.provider === 'claude') {
  const mcpConfigPath = writeMcpConfig();
  spawnArgs = ['--mcp-config', mcpConfigPath];
  console.log(`  MCP server: orchestrator tools available in this session.`);
}

const cli = spawn(binary, spawnArgs, { stdio: 'inherit' });
```

### Step 4 — Confirm `writeFileSync` and `mkdirSync` are imported

**File:** `cli/start-session.mjs` (line 15)

Current import: `import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';`
Both `writeFileSync` and `mkdirSync` are already present. No change needed.

---

## Acceptance criteria

- [ ] `start-session.mjs` with `--provider=claude` writes `STATE_DIR/mcp-config.json`.
- [ ] Written config contains `mcpServers.orchestrator.command` (absolute node path).
- [ ] Written config contains `mcpServers.orchestrator.args[0]` (absolute server.mjs path).
- [ ] Written config contains `mcpServers.orchestrator.env.ORCH_STATE_DIR` = STATE_DIR.
- [ ] `claude` is spawned with `['--mcp-config', configPath]` args for claude provider.
- [ ] `codex` and `gemini` providers spawn without `--mcp-config` (empty args array).
- [ ] Console output includes "MCP server: orchestrator tools available" for claude provider only.
- [ ] Error handling for spawn failure is unchanged (lines 269–288 of current file).

---

## Tests

**File:** `cli/start-session.test.mjs`

Add a `describe('MCP config integration', ...)` block.

```js
describe('MCP config integration', () => {
  it('writes mcp-config.json when provider is claude', async () => {
    // Seed empty state, mock binaryCheck (returns true), mock spawn
    // Run with --provider=claude --agent-id=master
    // Assert join(dir, 'mcp-config.json') exists
    const config = JSON.parse(readFileSync(join(dir, 'mcp-config.json'), 'utf8'));
    expect(config.mcpServers.orchestrator).toBeTruthy();
    expect(config.mcpServers.orchestrator.env.ORCH_STATE_DIR).toBe(dir);
  });

  it('passes --mcp-config flag to claude spawn', async () => {
    // Mock spawn to capture args
    // Assert spawn was called with args[0] === '--mcp-config'
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      ['--mcp-config', expect.stringContaining('mcp-config.json')],
      expect.objectContaining({ stdio: 'inherit' }),
    );
  });

  it('does not write mcp-config.json when provider is codex', async () => {
    // Run with --provider=codex
    expect(existsSync(join(dir, 'mcp-config.json'))).toBe(false);
  });

  it('spawns codex without --mcp-config flag', async () => {
    // Assert spawn called with empty args for codex
    expect(spawnMock).toHaveBeenCalledWith('codex', [], expect.any(Object));
  });
});
```

Use the existing `mockSpawn` / `makeSpawnMock` helpers already in `start-session.test.mjs`.

---

## Verification

```bash
cd orchestrator && npm test -- start-session
npm test

# Manual smoke test (requires claude binary):
ORCH_STATE_DIR=/tmp/orc-smoke orc-start-session --provider=claude --agent-id=master
# → check /tmp/orc-smoke/mcp-config.json exists with correct content
# → verify claude session opens and has orchestrator tools in /tools
```
