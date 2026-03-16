---
ref: general/3-packaged-agents-skills-mcp
feature: general
priority: normal
status: todo
---

# Task 3 — Ship Agents, Skills, and MCP as First-Class Package Artifacts

Independent.

## Scope

**In scope:**
- Add `postinstall` script or document install step so skills are available after `npm install`
- Add Codex and Gemini skill files parallel to existing Claude skills in `skills/`
- Expose `lib/sessionBootstrap.ts` bootstrap templates as a documented public API (exported from `index.ts`)
- Add a `README.md` section documenting MCP server startup, available tools, and how to connect Claude/Codex/Gemini to it
- Validate that `skills/` is included in the npm `files` array

**Out of scope:**
- Changing any MCP tool implementations (already complete)
- Auto-registering the MCP with provider CLI config (out of scope for this task)
- Implementing new MCP tools
- Changing bootstrap template content

---

## Context

The MCP server (`mcp/server.ts`) is fully implemented with 13 tools and is ready to ship. However, consumers have no way to discover it, connect to it, or know it exists. Skills exist only for Claude (`skills/claude/`) and are not installed automatically. Bootstrap templates are hardcoded strings in `lib/sessionBootstrap.ts` with no public export. A consumer installing `@t-mu/orc-state` gets none of these working out of the box.

### Current state
- `skills/claude/` has `orc-commands/SKILL.md` and `create-task/SKILL.md`
- No `skills/codex/` or `skills/gemini/` directories
- `lib/sessionBootstrap.ts` reads templates from `templates/` and returns strings — not exported publicly
- MCP server: `mcp/server.ts` works but is undocumented for consumers
- `skills/` is in the `files` array — included in pack, but not installed

### Desired state
- `skills/codex/` and `skills/gemini/` have equivalent skill files for orc-commands
- MCP server startup command is documented in README with connection instructions
- `lib/sessionBootstrap.ts` exports `getWorkerBootstrap(provider)` and `getMasterBootstrap(provider)` as named public API
- README documents all 13 MCP tools with a one-line description each

### Start here
- `skills/claude/orc-commands/SKILL.md` — reference for Codex/Gemini equivalents
- `lib/sessionBootstrap.ts` — template loading logic to expose
- `mcp/server.ts` — server startup for documentation

**Affected files:**
- `skills/codex/orc-commands/SKILL.md` — new file
- `skills/gemini/orc-commands/SKILL.md` — new file
- `lib/sessionBootstrap.ts` — add named exports
- `README.md` — MCP documentation section
- `index.ts` — re-export sessionBootstrap public API

---

## Goals

1. Must: `skills/codex/orc-commands/SKILL.md` exists with provider-appropriate orc command reference.
2. Must: `skills/gemini/orc-commands/SKILL.md` exists with provider-appropriate orc command reference.
3. Must: `lib/sessionBootstrap.ts` exports `getWorkerBootstrap(provider: string): string` and `getMasterBootstrap(provider: string): string`.
4. Must: README contains a "MCP Server" section listing startup command and all 13 tool names with one-line descriptions.
5. Must: `npm pack --dry-run` includes `skills/codex/` and `skills/gemini/` paths.

---

## Implementation

### Step 1 — Create Codex skill file

**File:** `skills/codex/orc-commands/SKILL.md`

Adapt the Claude version (`skills/claude/orc-commands/SKILL.md`) replacing Claude-specific invocation patterns with Codex equivalents (bash tool calls, codex agent format).

### Step 2 — Create Gemini skill file

**File:** `skills/gemini/orc-commands/SKILL.md`

Adapt the Claude version for Gemini CLI conventions.

### Step 3 — Export bootstrap API from `sessionBootstrap.ts`

**File:** `lib/sessionBootstrap.ts`

```ts
// Add named public exports (existing logic unchanged):
export function getWorkerBootstrap(provider: string): string { ... }
export function getMasterBootstrap(provider: string): string { ... }
```

### Step 4 — Re-export from index

**File:** `index.ts`

```ts
export { getWorkerBootstrap, getMasterBootstrap } from './lib/sessionBootstrap.ts';
```

### Step 5 — Document MCP in README

**File:** `README.md`

Add a "MCP Server" section:

```md
## MCP Server

Start the MCP server (stdio transport):
```bash
node --experimental-strip-types mcp/server.ts --state-dir=.orc-state
```

### Available tools
| Tool | Description |
|------|-------------|
| `create_task` | Add a task to the backlog |
| `update_task` | Modify an existing task |
| `delegate_task` | Assign a task to a worker agent |
| `cancel_task` | Cancel a task and its active runs |
| `list_tasks` | List tasks, optionally filtered by status or epic |
| `get_task` | Get full detail for one task |
| `list_agents` | List registered agents |
| `get_agent_workview` | Get a worker's current task queue and active run |
| `list_active_runs` | List all in-progress claims |
| `list_stalled_runs` | List runs that have missed their heartbeat |
| `get_recent_events` | Tail the event log |
| `get_status` | Full orchestrator status snapshot |
| `respond_input` | Answer a worker's input request |
```

---

## Acceptance criteria

- [ ] `skills/codex/orc-commands/SKILL.md` exists and contains orc CLI command reference adapted for Codex.
- [ ] `skills/gemini/orc-commands/SKILL.md` exists and contains orc CLI command reference adapted for Gemini.
- [ ] `getWorkerBootstrap('claude')` and `getMasterBootstrap('claude')` are importable from the package root.
- [ ] README "MCP Server" section lists all 13 tools.
- [ ] `npm pack --dry-run` output includes `skills/codex/` and `skills/gemini/` entries.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new unit tests required for skill markdown files or README content.

Add to `lib/sessionBootstrap.test.ts` (create if absent):

```ts
it('getWorkerBootstrap returns non-empty string for claude', () => { ... });
it('getMasterBootstrap returns non-empty string for claude', () => { ... });
it('getWorkerBootstrap throws for unknown provider', () => { ... });
```

---

## Verification

```bash
# Confirm new skills are in pack manifest
npm pack --dry-run | grep 'skills/codex'
npm pack --dry-run | grep 'skills/gemini'

# Confirm exports resolve
node --experimental-strip-types -e "
  import { getWorkerBootstrap } from './index.ts';
  console.log(getWorkerBootstrap('claude').slice(0, 40));
"

# Full suite
nvm use 24 && npm test
```
