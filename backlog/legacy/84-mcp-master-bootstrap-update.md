# Task 84 — Update Master Bootstrap for MCP Tools

Depends on Task 83.

## Scope

**In scope:**
- `templates/master-bootstrap-v1.txt` — rewrite to document MCP tools
- `lib/templateRender.mjs` — verify bootstrap is rendered and sent as system prompt
- `mcp/handlers.test.mjs` — final integration: verify full tool list matches bootstrap

**Out of scope:**
- Worker bootstrap (workers still use CLI commands — unchanged)
- Changes to coordinator dispatch logic
- New MCP tools beyond Tasks 81–82

---

## Context

### Current master bootstrap (read before implementing)

`templates/master-bootstrap-v1.txt` (lines 1–62):
- Documents CLI commands: `orc-task-create`, `orc-delegate`, `orc-status`, `orc-runs-active`
- Tells master to "use the shell tool directly"
- Does NOT mention MCP tools at all

### `renderTemplate` API (read this before implementing)

`lib/templateRender.mjs` signature:
```js
export function renderTemplate(templateName, vars)
```

- `templateName` is just the **filename** (e.g. `'master-bootstrap-v1.txt'`), NOT a path.
- The function reads from `TEMPLATE_DIR` (hardcoded to `templates/`).
- Substitutes `{{key}}` placeholders with `vars[key]`. Missing vars render as empty string + console.warn.

Correct call from `start-session.mjs`:
```js
import { renderTemplate } from '../lib/templateRender.mjs';

const bootstrap = renderTemplate('master-bootstrap-v1.txt', {
  agent_id: master.agent_id,
  provider: master.provider,
});
```

**Do NOT use `readFileSync` for the template** — `renderTemplate` already does that internally.

### How the bootstrap reaches master

The bootstrap is currently sent via PTY for workers (via `ptyProcess.write()`). For the
foreground master session spawned with `stdio: 'inherit'`, no system prompt injection currently exists.

**This gap must be resolved in this task. Check `claude --help` first:**
```bash
claude --help 2>&1 | grep -iE 'system|prompt|bootstrap'
```

Two likely approaches — implement whichever works:

**Option A — `--system-prompt` flag (preferred if supported):**
```js
const spawnArgs = master.provider === 'claude'
  ? ['--mcp-config', mcpConfigPath, '--system-prompt', bootstrap]
  : [];
```
Clean — no terminal noise, bootstrap goes directly into Claude's system context.

**Option B — print to stdout before spawn (fallback):**
```js
console.log('\n' + bootstrap + '\n');
```
Claude CLI reads its terminal history. The user also sees the bootstrap text, which is
acceptable — it tells the operator what the master's instructions are.

**Do not pass bootstrap as a user-turn message.** The master treats its first user message
as the operator's intent; injecting bootstrap there would confuse the session flow.

Note: if `--system-prompt` and other flags make the arg list long, Claude CLI should
handle this fine. If the flag doesn't exist, fall back to Option B and add a code comment
noting the flag was checked on the implementation date.

### Goal of the bootstrap rewrite

The bootstrap currently documents CLI commands because master has no better interface.
After MCP integration, master should:
- Use MCP tools for ALL orchestrator reads and writes
- Use the Bash tool only for non-orchestrator shell operations
- Never construct `orc-task-create` CLI strings manually

---

## Goals

1. Bootstrap tells master to use MCP tools — not orc CLI commands.
2. Each tool is documented with its name, purpose, and key parameters.
3. Bootstrap is delivered to master on session start.
4. Behavioral instructions remain: wait for user direction, don't act speculatively.

---

## Implementation

### Step 1 — Rewrite `master-bootstrap-v1.txt`

Replace the entire file:

```
MASTER_BOOTSTRAP v2
agent_id: {{agent_id}}
provider: {{provider}}

You are the orchestration master agent. Your role is to translate user intent
into concrete tasks and assign them to worker agents. You do not execute tasks
yourself.

You have MCP tools available for all orchestrator operations. Use them instead
of orc CLI commands. The Bash tool remains available for non-orchestrator work.

────────────────────────────────────────────────────────────────────
READ STATE
────────────────────────────────────────────────────────────────────

list_tasks(status?, epic?)
  → All backlog tasks. Filter by status: todo|claimed|in_progress|done|blocked
  → Filter by epic ref (e.g. 'project')

list_agents(role?)
  → Registered agents. Filter by role: worker|reviewer|master

list_active_runs()
  → Currently running task claims (claimed + in_progress)

list_stalled_runs(stale_after_ms?)
  → Claims with no recent heartbeat. Default threshold: 10 minutes.
  → Returns stale_for_ms for each run.

get_task(task_ref)
  → Full task object for 'epic/slug'. Returns { error: 'not_found' } if absent.

get_recent_events(limit?)
  → Last N events from events.jsonl. Default: 50.

────────────────────────────────────────────────────────────────────
WRITE STATE
────────────────────────────────────────────────────────────────────

create_task(epic, title, task_type?, description?, acceptance_criteria?, depends_on?,
            required_capabilities?, owner?, ref?, actor_id?)
  → Creates a task in the backlog. Returns the created task object.
  → task_type: 'implementation' (default) or 'refactor'
  → acceptance_criteria: string[] — each criterion as a separate string
  → actor_id: defaults to '{{agent_id}}'
  → Epic must already exist. Check list_tasks() or get_recent_events() for valid epics.

delegate_task(task_ref, target_agent_id?, task_type?, note?, actor_id?)
  → Assigns a task to a worker. Emits task_delegated event.
  → Omit target_agent_id to auto-assign to the first eligible worker.
  → Returns { task_ref, assigned_to } or { warning: 'no_eligible_worker' } if no worker available.
  → actor_id: defaults to '{{agent_id}}'

────────────────────────────────────────────────────────────────────
RESOURCES (passive context)
────────────────────────────────────────────────────────────────────

orchestrator://state/backlog   — Full backlog.json
orchestrator://state/agents    — Full agents.json

────────────────────────────────────────────────────────────────────
TYPICAL FLOW
────────────────────────────────────────────────────────────────────

1. User gives direction.
2. Call list_agents(role='worker') — verify workers are available.
3. Call create_task(epic, title, ...) — one task per unit of work.
4. Call delegate_task(task_ref) for each created task.
5. Report back: task refs created, workers assigned, next check-in point.

To check progress:
  list_active_runs() + list_stalled_runs()

To intervene on a stalled run:
  list_stalled_runs() → identify → delegate_task(task_ref) to re-assign

────────────────────────────────────────────────────────────────────
INVARIANTS
────────────────────────────────────────────────────────────────────

- Tasks must belong to an existing epic. Default epic: 'project'.
- Task refs are auto-generated as '{epic}/{slugified-title}' unless --ref provided.
- Do not create tasks speculatively. Wait for user direction.
- Coordinator handles worker dispatch, PTY management, and lease expiry automatically.
- Workers report task state via orc-run-* CLI commands — you do not need to manage this.

MASTER_BOOTSTRAP_END
```

### Step 2 — Deliver bootstrap to master session

**File:** `cli/start-session.mjs`

Add import (not currently in the file):
```js
import { renderTemplate } from '../lib/templateRender.mjs';
```

Add bootstrap rendering and delivery in the "Master foreground session" section, after
`writeMcpConfig()` is called (Task 83) and before `spawn()`:

```js
// ── Master bootstrap ──────────────────────────────────────────────────────
const bootstrap = renderTemplate('master-bootstrap-v1.txt', {
  agent_id: master.agent_id,
  provider: master.provider,
});

// Deliver bootstrap via --system-prompt flag (Option A, preferred) or stdout (Option B).
// See Context section above — check claude --help for the correct approach.
```

The `spawnArgs` construction (Task 83, Step 3) must incorporate the bootstrap:
```js
let spawnArgs = [];
if (master.provider === 'claude') {
  const mcpConfigPath = writeMcpConfig();
  // Try --system-prompt flag; if it doesn't exist, remove it and use console.log(bootstrap)
  spawnArgs = ['--mcp-config', mcpConfigPath, '--system-prompt', bootstrap];
  console.log('  MCP server: orchestrator tools available in this session.');
}
```

---

## Acceptance criteria

- [ ] Bootstrap v2 documents all 6 read tools and 2 write tools.
- [ ] Bootstrap does NOT mention `orc-task-create`, `orc-delegate`, `orc-status` as the
  primary interface (may mention them as fallback for troubleshooting only).
- [ ] Bootstrap instructs master to use MCP tools, not Bash `orc-*` commands.
- [ ] Bootstrap is printed to terminal before claude is spawned.
- [ ] `actor_id` default in bootstrap matches `{{agent_id}}` template variable.
- [ ] Template renders correctly: `{{agent_id}}` and `{{provider}}` are substituted.
- [ ] Worker bootstrap (`worker-bootstrap-v2.txt`) is unchanged.

---

## Tests

**File:** `mcp/handlers.test.mjs` — add a describe block at the end.

(`renderTemplate` is already tested via its own unit if `lib/templateRender.test.mjs` exists.
Check — if it doesn't exist, add the template render test there instead.)

```js
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('master bootstrap template', () => {
  it('renders with agent_id and provider substituted', () => {
    // renderTemplate takes filename only — it reads from templates/ dir internally
    const { renderTemplate } = await import('../lib/templateRender.mjs');
    const rendered = renderTemplate('master-bootstrap-v1.txt', {
      agent_id: 'master',
      provider: 'claude',
    });
    expect(rendered).toContain('agent_id: master');
    expect(rendered).toContain('provider: claude');
    expect(rendered).toContain('list_tasks');
    expect(rendered).toContain('create_task');
    expect(rendered).toContain('delegate_task');
    expect(rendered).not.toContain('{{agent_id}}');
    expect(rendered).not.toContain('{{provider}}');
  });

  it('bootstrap documents every tool exported by server.mjs', async () => {
    // TOOLS is exported from server.mjs (Task 80, Step 5).
    // Guard: if server.mjs top-level await causes issues, wrap in vi.mock or
    // extract TOOLS to a separate mcp/tools-list.mjs that server.mjs imports.
    vi.resetModules();
    const { TOOLS } = await import('./server.mjs');
    const { renderTemplate } = await import('../lib/templateRender.mjs');
    const bootstrap = renderTemplate('master-bootstrap-v1.txt', { agent_id: 'master', provider: 'claude' });
    for (const tool of TOOLS) {
      expect(bootstrap, `bootstrap should document tool '${tool.name}'`).toContain(tool.name);
    }
  });
});
```

**Note on server.mjs import in tests:** If the top-level `await server.connect(transport)`
in server.mjs causes the import to hang, extract the `TOOLS` constant to a separate file
`mcp/tools-list.mjs` that both `server.mjs` and tests import. This avoids
the "guard the connect call" complexity described in Task 80.

---

## Verification

```bash
cd orchestrator && npm test -- handlers templateRender
npm test

# Manual: verify bootstrap printed on session start
ORCH_STATE_DIR=/tmp/orc-smoke orc-start-session --provider=claude --agent-id=master
# → should see bootstrap text printed before claude CLI opens
```
