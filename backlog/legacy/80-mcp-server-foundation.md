# Task 80 — MCP Server Foundation

Blocks Tasks 81–84.

## Scope

**In scope:**
- `orchestrator/package.json` — add `@modelcontextprotocol/sdk` dependency
- `mcp/server.mjs` — stdio MCP server entry point (no real tools yet)
- `orchestrator/package.json` `bin` — add `orc-mcp-server`
- `cli/orc.mjs` — add `mcp-server` to COMMANDS map
- `mcp/server.test.mjs` — smoke test: server starts and responds to ListTools

**Out of scope:**
- Any real tool or resource implementations (Tasks 81–82)
- `orc-start-session` integration (Task 83)
- Master bootstrap changes (Task 84)

---

## Context

The MCP server is a stdio-transport subprocess that the `claude` CLI spawns automatically
when `--mcp-config <path>` is passed. The server communicates exclusively via stdin/stdout
using the MCP JSON-RPC protocol. **All debug output must go to stderr** — any stdout write
that isn't valid MCP protocol corrupts the connection.

Transport lifecycle:
```
orc-start-session
  └── spawn('claude', ['--mcp-config', STATE_DIR/mcp-config.json], { stdio: 'inherit' })
        └── claude spawns: node mcp/server.mjs  (stdio transport)
              ↕ MCP JSON-RPC over stdin/stdout
            claude tool calls → server handler → state file read/write → response
```

The server process is owned by the claude subprocess and exits when claude exits.
`orc-start-session` does not manage the server lifecycle directly.

---

## Goals

1. Establish working stdio MCP server that claude can connect to.
2. Server exports a `ping` tool (used for smoke testing only; remove in Task 81).
3. `ORCH_STATE_DIR` env var flows from MCP config into server process.
4. All console/debug output goes to `process.stderr`, never `process.stdout`.

---

## Implementation

### Step 1 — Add SDK dependency

**File:** `orchestrator/package.json`

Check npm for latest `@modelcontextprotocol/sdk` `1.x` version:
```bash
npm show @modelcontextprotocol/sdk version
```

Add to `"dependencies"`:
```json
"@modelcontextprotocol/sdk": "<latest-1.x>"
```

Run `npm install` in `orchestrator/`.

### Step 2 — Create server entry point

**File:** `mcp/server.mjs`

```js
#!/usr/bin/env node
/**
 * mcp/server.mjs
 *
 * Stdio MCP server for the orchestrator.
 * Spawned by the claude CLI via --mcp-config. Communicates over stdin/stdout.
 *
 * IMPORTANT: process.stdout is the MCP transport — never write to it directly.
 * All diagnostic output must use process.stderr.
 *
 * Environment:
 *   ORCH_STATE_DIR — state directory path (set by orc-start-session in the mcp config)
 */
import { Server }             from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { STATE_DIR } from '../lib/paths.mjs';

const server = new Server(
  { name: 'orchestrator', version: '0.1.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// ── Tool registry ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'ping',
    description: 'Health check. Returns { ok: true, stateDir }.',
    inputSchema: { type: 'object', properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'ping':
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, stateDir: STATE_DIR }) }] };

      default:
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
});

// ── Resource registry ──────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return { isError: true, content: [{ type: 'text', text: `Unknown resource: ${request.params.uri}` }] };
});

// ── Start ──────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[orc-mcp] Server started. STATE_DIR=${STATE_DIR}\n`);
```

### Step 3 — Register bin entry and add `mcp` to files list

**File:** `orchestrator/package.json`

Add to `"bin"`:
```json
"orc-mcp-server": "./mcp/server.mjs"
```

Also add `"mcp"` to the `"files"` array (currently lists `"adapters"`, `"cli"`, `"lib"`,
`"schemas"`, `"templates"`, `"coordinator.mjs"`, etc.). Without this, `npm pack` will
omit the `mcp/` directory from the published package.

### Step 4 — Register in orc.mjs

**File:** `cli/orc.mjs`

Add to the COMMANDS map:
```js
'mcp-server': '../mcp/server.mjs',
```

How the resolver works (orc.mjs line 58):
```js
const scriptPath = resolve(import.meta.dirname, script);
```
`import.meta.dirname` is `cli/`. So `resolve('cli/', '../mcp/server.mjs')`
resolves correctly to `mcp/server.mjs`. The `../` prefix is intentional and correct.

### Step 5 — Export TOOLS array from server.mjs

**File:** `mcp/server.mjs`

Export the `TOOLS` array so Task 84's cross-check test can verify the bootstrap
documents every tool:
```js
export const TOOLS = [ ... ];
```

**Recommended structure to avoid test import issues:**

Extract the `TOOLS` constant to `mcp/tools-list.mjs` (added in Task 81 with
the full list). Both `server.mjs` and tests import from `tools-list.mjs`. This means
tests never need to import `server.mjs` (which has a top-level `await server.connect()`
that would hang the test runner).

```
mcp/
  tools-list.mjs   ← exports TOOLS array (Tasks 81 adds the full list)
  handlers.mjs     ← pure handler functions
  server.mjs       ← imports tools-list.mjs + handlers.mjs, runs connect()
```

For Task 80, `tools-list.mjs` only contains the `ping` tool. Task 81 populates it fully.

Guard the connect call in server.mjs for cases where it IS imported in tests:
```js
// Only connect transport when run as a script, not when imported by tests.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[orc-mcp] Server started. STATE_DIR=${STATE_DIR}\n`);
}
```

---

## Acceptance criteria

- [ ] `node mcp/server.mjs` starts without error (exits cleanly when stdin closes).
- [ ] `@modelcontextprotocol/sdk` is in `package.json` dependencies and `node_modules`.
- [ ] `orc-mcp-server` bin entry exists and resolves to `mcp/server.mjs`.
- [ ] `orc mcp-server` via orc.mjs dispatcher works.
- [ ] No `process.stdout.write` or `console.log` calls in `server.mjs` (only `process.stderr`).
- [ ] `ORCH_STATE_DIR` env var is read and reflected in `ping` tool response.

---

## Tests

**File:** `mcp/server.test.mjs`

The vitest unit config (`vitest.config.mjs`) picks up all `**/*.test.mjs` files excluding
`e2e/**` — so `mcp/server.test.mjs` is automatically included in `npm test`.

**Do NOT test server.mjs directly with MCP transports in this task.** The `InMemoryTransport`
from `@modelcontextprotocol/sdk` requires bidirectional async setup that is complex and
fragile in vitest. Instead, test only that:
1. The server module exports `TOOLS` (static check)
2. The `ping` handler logic (from handlers.mjs) returns correct output

The bulk of functional testing happens in `handlers.test.mjs` (Task 81).

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orc-mcp-test-')); process.env.ORCH_STATE_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.ORCH_STATE_DIR; });

describe('server TOOLS export', () => {
  it('exports a TOOLS array with at least ping', async () => {
    vi.resetModules();
    const { TOOLS } = await import('./server.mjs');
    expect(Array.isArray(TOOLS)).toBe(true);
    expect(TOOLS.some((t) => t.name === 'ping')).toBe(true);
    expect(TOOLS.every((t) => typeof t.name === 'string')).toBe(true);
    expect(TOOLS.every((t) => typeof t.description === 'string')).toBe(true);
    expect(TOOLS.every((t) => t.inputSchema != null)).toBe(true);
  });
});
```

---

## Verification

```bash
cd orchestrator && npm install
node mcp/server.mjs < /dev/null   # should start then exit cleanly
cd orchestrator && npm test -- mcp/server
npm test
```
