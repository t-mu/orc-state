---
ref: general/3-packaged-agents-skills-mcp
feature: general
priority: normal
status: done
---

# Task 3 — Ship Agents, Skills, and MCP as First-Class Package Artifacts

Independent.

## Scope

**In scope:**
- Document how packaged skills are installed after `npm install` using the existing `orc install-skills` flow
- Audit and correct the shipped `skills/` content so it matches the current repository layout and CLI/MCP contracts
- Expose bootstrap template helpers from `lib/sessionBootstrap.ts` as a documented public API exported from `index.ts`
- Add a `README.md` section documenting MCP server startup, current available tools, and provider connection notes for Claude/Codex/Gemini
- Validate that packaged tarballs include the provider-agnostic `skills/` content shipped by the package

**Out of scope:**
- Changing any MCP tool implementations (already complete)
- Auto-registering the MCP with provider CLI config (out of scope for this task)
- Implementing new MCP tools
- Changing bootstrap behavior beyond extracting the existing template selection into public helpers

---

## Context

The MCP server (`mcp/server.ts`) is implemented and the package already ships `skills/`, `templates/`, and the MCP source in the npm tarball. However, the public-facing documentation and shipped instruction artifacts are stale in several places: they still refer to `docs/backlog/`, old npm script names, and an older MCP/tool surface. `lib/sessionBootstrap.ts` also does not expose provider-specific template helpers from the package root, even though master bootstrap selection already exists in `cli/start-session.ts`.

### Current state
- `skills/` is provider-agnostic and currently contains `orc-commands/` and `create-task/`
- `cli/install-skills.ts` already installs the same packaged skills into provider-specific target directories for Claude and Codex
- `lib/sessionBootstrap.ts` only exports `buildSessionBootstrap(agentId, provider, role)` and does not expose direct worker/master template helpers
- `cli/start-session.ts` chooses provider-specific master templates directly instead of through a public helper
- `mcp/server.ts` works but README does not document how to start it or what tools/resources it exposes
- Several shipped docs and prompts still reference `docs/backlog/`, `npm run backlog:sync:check`, or outdated MCP details

### Desired state
- Shipped skills and prompt templates reference the current `backlog/` layout, current CLI commands, and current MCP surface
- README documents an accurate MCP server startup command using `ORCH_STATE_DIR` and the current tool/resource surface
- `lib/sessionBootstrap.ts` exports `getWorkerBootstrap(provider)` and `getMasterBootstrap(provider)` as named public API
- `index.ts` re-exports those helpers and the public API contract tests are updated accordingly
- `npm pack --dry-run --ignore-scripts` includes the provider-agnostic `skills/` paths that consumers actually install

### Start here
- `skills/orc-commands/SKILL.md` — shipped command reference to correct
- `skills/create-task/SKILL.md` — shipped backlog task authoring reference to correct
- `lib/sessionBootstrap.ts` — template loading logic to expose
- `cli/start-session.ts` — current master-template selection logic
- `mcp/server.ts` and `mcp/tools-list.ts` — server startup and tool list for documentation

**Affected files:**
- `skills/orc-commands/SKILL.md` — correct shipped CLI reference
- `skills/create-task/SKILL.md` — correct shipped task-authoring guidance
- `skills/create-task/references/task-template.md` — align packaged template reference with current repo
- `templates/master-bootstrap-v1.txt` — correct shipped master bootstrap guidance
- `templates/master-bootstrap-codex-v1.txt` — correct shipped master bootstrap guidance
- `templates/master-bootstrap-gemini-v1.txt` — correct shipped master bootstrap guidance
- `templates/task-envelope-v2.txt` — correct shipped worker task instructions
- `lib/sessionBootstrap.ts` — add named exports
- `cli/start-session.ts` — route provider-specific master bootstrap selection through public helpers
- `README.md` — MCP documentation section
- `index.ts` — re-export sessionBootstrap public API
- `index.test.ts` — update stable public API expectations

---

## Goals

1. Must: shipped skill and bootstrap/template docs no longer reference `docs/backlog/` or nonexistent npm scripts.
2. Must: `lib/sessionBootstrap.ts` exports `getWorkerBootstrap(provider: string): string` and `getMasterBootstrap(provider: string): string`.
3. Must: `getWorkerBootstrap` and `getMasterBootstrap` are importable from the package root.
4. Must: README contains an accurate "MCP Server" section documenting startup, resources, and all current MCP tool names with one-line descriptions.
5. Must: `npm pack --dry-run --ignore-scripts` includes the provider-agnostic `skills/` paths shipped by the package.

---

## Implementation

### Step 1 — Correct shipped skill and prompt docs

**Files:** `skills/orc-commands/SKILL.md`, `skills/create-task/SKILL.md`, `skills/create-task/references/task-template.md`, `templates/master-bootstrap-v1.txt`, `templates/master-bootstrap-codex-v1.txt`, `templates/master-bootstrap-gemini-v1.txt`, `templates/task-envelope-v2.txt`

Replace stale `docs/backlog/` paths with `backlog/`, replace nonexistent npm script names with current commands, and remove references to direct state mutation through internal `.mjs` files where the current CLI/MCP contract should be used instead.

### Step 2 — Export bootstrap API from `sessionBootstrap.ts`

**File:** `lib/sessionBootstrap.ts`

```ts
export function getWorkerBootstrap(provider: string): string { ... }
export function getMasterBootstrap(provider: string): string { ... }
export function buildSessionBootstrap(agentId: string, provider: string, role: string): string { ... }
```

`getWorkerBootstrap()` should return the existing worker bootstrap template content.
`getMasterBootstrap()` should select the same provider-specific template currently chosen in `cli/start-session.ts`.
Reject unknown providers with a descriptive error.

### Step 3 — Route `start-session` through the new helper

**File:** `cli/start-session.ts`

Replace direct `renderTemplate('master-bootstrap-*.txt', ...)` calls with `getMasterBootstrap(provider)` so the public helper reflects the runtime’s actual selection logic.

### Step 4 — Re-export from index and update API contract tests

**Files:** `index.ts`, `index.test.ts`, `lib/sessionBootstrap.test.ts`

Re-export the new helpers from `index.ts`, then update package-root API contract tests to include them.

### Step 5 — Document MCP in README

**File:** `README.md`

Add a "MCP Server" section:

```md
## MCP Server

Start the MCP server (stdio transport):
```bash
ORCH_STATE_DIR=/path/to/project/.orc-state node --experimental-strip-types mcp/server.ts
```

Resources:
- `orchestrator://state/backlog`
- `orchestrator://state/agents`

### Available tools
| Tool | Description |
|------|-------------|
| `list_tasks` | List tasks, optionally filtered by status or feature |
| `list_agents` | List registered agents |
| `list_active_runs` | List active task claims |
| `list_stalled_runs` | List active claims missing heartbeats |
| `get_task` | Get full detail for one task |
| `get_recent_events` | Tail the event log |
| `get_status` | Get a compact orchestrator status snapshot |
| `get_agent_workview` | Get one agent's actionable work summary |
| `create_task` | Create a backlog task |
| `update_task` | Update mutable task fields |
| `delegate_task` | Assign a task to a worker |
| `cancel_task` | Cancel a task and remove active runs |
| `respond_input` | Answer a worker's input request |
| `get_run` | Get one run with merged task/worktree details |
| `list_waiting_input` | List runs waiting for master input |
| `query_events` | Filter the event log |
| `reset_task` | Reset a task to `todo` and cancel active claims |
| `list_worktrees` | List registered run worktrees |
```

---

## Acceptance criteria

- [ ] Shipped docs and prompts no longer reference `docs/backlog/`.
- [ ] Shipped docs and prompts no longer reference nonexistent npm scripts such as `npm run backlog:sync:check` or `npm run test:orc`.
- [ ] `getWorkerBootstrap('claude')` and `getMasterBootstrap('claude')` are importable from the package root.
- [ ] `getMasterBootstrap('codex')` and `getMasterBootstrap('gemini')` return the same template content the runtime uses for those providers.
- [ ] README "MCP Server" section lists all current MCP tools and the two MCP resources.
- [ ] `npm pack --dry-run --ignore-scripts` output includes the provider-agnostic `skills/` entries shipped by the package.
- [ ] No changes to files outside the stated scope.

---

## Tests

No new unit tests required for skill markdown files or README content.

Add to `lib/sessionBootstrap.test.ts`:

```ts
it('getWorkerBootstrap returns non-empty string for claude', () => { ... });
it('getMasterBootstrap returns non-empty string for claude', () => { ... });
it('getMasterBootstrap returns codex master template content', () => { ... });
it('getMasterBootstrap returns gemini master template content', () => { ... });
it('getWorkerBootstrap throws for unknown provider', () => { ... });
```

Update `index.test.ts` to assert the new top-level exports are part of the stable public API surface.

---

## Verification

```bash
# Confirm packaged skills are in pack manifest without running prepare
env npm_config_cache=/tmp/orc-npm-cache npm pack --dry-run --ignore-scripts | grep 'skills/orc-commands'
env npm_config_cache=/tmp/orc-npm-cache npm pack --dry-run --ignore-scripts | grep 'skills/create-task'

# Confirm exports resolve
node --experimental-strip-types -e "
  import { getWorkerBootstrap, getMasterBootstrap } from './index.ts';
  console.log(getWorkerBootstrap('claude').slice(0, 40));
  console.log(getMasterBootstrap('codex').slice(0, 40));
"

# Full suite
nvm use 24 && npm test
```
