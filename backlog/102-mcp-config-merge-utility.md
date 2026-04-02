---
ref: publish/102-mcp-config-merge-utility
feature: publish
priority: normal
status: todo
---

# Task 102 — Create MCP Config Merge Utility

Independent.

## Scope

**In scope:**
- Create `lib/mcpConfig.ts` with a `mergeMcpConfig()` function
- Surgically merge orchestrator MCP server entry into an existing `.mcp.json`
- Preserve all user-defined MCP server entries
- Handle missing `.mcp.json` (create from scratch)
- Support dry-run mode
- Add tests

**Out of scope:**
- Modifying `cli/start-session.ts` MCP config writing (it writes to `.orc-state/mcp-config.json`, a different file)
- Creating the `orc install` CLI command (Task 103)
- Changing any existing MCP server or handler code

---

## Context

When consumers run `orc install`, the framework needs to register its MCP server in the project's `.mcp.json`. This file may already contain user-defined MCP servers that must be preserved. The merge must be surgical — only add/update the `orchestrator` entry.

### Current state

`cli/start-session.ts` writes a standalone `mcp-config.json` inside `.orc-state/` for Claude provider startup. There is no utility for merging into a project-root `.mcp.json`.

### Desired state

A reusable `mergeMcpConfig()` function that reads `.mcp.json`, adds/updates the orchestrator server entry, preserves everything else, and writes back.

### Start here

- `cli/start-session.ts` lines 165-180 — existing `writeMcpConfig()` for reference on the server entry shape
- `mcp/server.ts` — the server that needs to be referenced

**Affected files:**
- `lib/mcpConfig.ts` — new file
- `lib/mcpConfig.test.ts` — new test file

---

## Goals

1. Must create `.mcp.json` from scratch if it doesn't exist.
2. Must preserve all existing entries in `mcpServers` when merging.
3. Must add/update only the `orchestrator` key under `mcpServers`.
4. Must preserve any root-level keys beyond `mcpServers`.
5. Must support dry-run mode (return what would change without writing).
6. Must have test coverage for create, merge, and preserve scenarios.

---

## Implementation

### Step 1 — Create lib/mcpConfig.ts

**File:** `lib/mcpConfig.ts` (new)

```ts
export interface McpMergeResult {
  created: boolean;      // true if .mcp.json didn't exist
  updated: boolean;      // true if orchestrator entry was changed
  path: string;          // absolute path to .mcp.json
}

export function mergeMcpConfig(
  targetDir: string,
  serverPath: string,
  stateDir: string,
  dryRun: boolean,
): McpMergeResult
```

Logic:
1. Read `<targetDir>/.mcp.json` or start with `{}`
2. Ensure `mcpServers` key exists (object)
3. Set `mcpServers.orchestrator` to:
   ```json
   {
     "command": "node",
     "args": ["<serverPath>"],
     "env": { "ORCH_STATE_DIR": "<stateDir>" }
   }
   ```
4. If not dry-run, write back with `JSON.stringify(config, null, 2)`
5. Return result

The `serverPath` should be resolved to the installed package's `dist/mcp/server.js`.

### Step 2 — Add tests

**File:** `lib/mcpConfig.test.ts` (new)

```ts
it('creates .mcp.json from scratch when missing', () => { ... });
it('merges orchestrator into existing .mcp.json preserving other servers', () => { ... });
it('updates existing orchestrator entry', () => { ... });
it('preserves root-level keys beyond mcpServers', () => { ... });
it('dry-run makes no file changes', () => { ... });
```

---

## Acceptance criteria

- [ ] `mergeMcpConfig()` creates `.mcp.json` when it doesn't exist.
- [ ] `mergeMcpConfig()` preserves existing `mcpServers` entries (e.g. user's custom servers).
- [ ] `mergeMcpConfig()` preserves root-level keys beyond `mcpServers`.
- [ ] `mergeMcpConfig()` adds/updates only the `orchestrator` key.
- [ ] Dry-run mode returns result without writing.
- [ ] All tests pass.
- [ ] `npm test` passes.
- [ ] No changes to files outside `lib/mcpConfig.ts` and `lib/mcpConfig.test.ts`.

---

## Tests

Add to `lib/mcpConfig.test.ts`:

```ts
it('creates .mcp.json from scratch when missing');
it('merges orchestrator into existing .mcp.json preserving other servers');
it('updates existing orchestrator entry');
it('preserves root-level keys beyond mcpServers');
it('dry-run makes no file changes');
```

---

## Verification

```bash
npx vitest run lib/mcpConfig.test.ts
nvm use 24 && npm test
```
