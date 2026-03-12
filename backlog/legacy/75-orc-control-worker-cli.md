# Task 75 — Add `orc-control-worker` CLI for Worker Attach/Control

Depends on Task 74. Blocks Tasks 78–79.

## Scope

**In scope:**
- `cli/control-worker.mjs` (new)
- `orchestrator/package.json` — add bin entry
- `cli/orc.mjs` — add COMMANDS entry
- `lib/prompts.mjs` — add `promptWorkerSelect()` for interactive worker picker
- `cli/control-worker.test.mjs` (new)

**Out of scope:**
- Rewriting `cli/attach.mjs`
- Changing provider adapter API shape
- Coordinator scheduling/claim logic

---

## Current State (read before implementing)

### Existing command registry
`cli/orc.mjs` COMMANDS map (lines 15–38): does NOT yet contain `control-worker`.
`orchestrator/package.json` bin section (lines 7–32): does NOT yet contain `orc-control-worker`.

### Available primitives
- `getAgent(STATE_DIR, id)` and `listAgents(STATE_DIR)` — from `lib/agentRegistry.mjs`
- `createAdapter(provider)` — from `adapters/index.mjs`; returns pty adapter
- `adapter.heartbeatProbe(sessionHandle)` — returns Promise<boolean>
- `adapter.attach(sessionHandle)` — prints last 8 KB of `STATE_DIR/pty-logs/{agentId}.log` to stdout; returns void (not a promise)
- `promptAgentId(existing)` — from `lib/prompts.mjs` — free-text input
- `isInteractive()` — from `lib/prompts.mjs`
- `STATE_DIR` — from `lib/paths.mjs`
- `flag(name)` — from `lib/args.mjs`

### `attach.mjs` vs `control-worker.mjs`
`attach.mjs` is a thin one-shot read: it gets the agent, probes liveness, calls `adapter.attach()`.
`control-worker.mjs` wraps the same logic but adds:
- Worker-role enforcement (rejects master agent)
- Interactive worker selection when no `<id>` provided
- Cleaner actionable error messages

---

## Goals

1. Single command for common operator workflow: pick a worker, view its output.
2. Positional `<worker_id>` or interactive list selection when not provided.
3. Must reject `master` role agents with an actionable error.
4. Missing or dead session: exit 1 with guidance to run `orc-worker-start-session`.
5. No adapter API changes.

---

## Implementation

### Step 1 — Add `promptWorkerSelect` to `prompts.mjs`

**File:** `lib/prompts.mjs`

Add a new export after `promptCreateWorkerAction`. Use `select` from `@inquirer/prompts`.

```js
/**
 * Present an interactive list of registered non-master workers.
 * Returns the selected agent_id.
 * Returns null in non-interactive mode or when the list is empty.
 *
 * @param {Array<{agent_id: string, provider: string, status: string}>} workers
 */
export async function promptWorkerSelect(workers) {
  if (!workers || workers.length === 0) return null;
  if (!isInteractive()) return null;
  return select({
    message: 'Select worker',
    choices: workers.map((w) => ({
      value: w.agent_id,
      name:  `${w.agent_id} (${w.provider}) status=${w.status}`,
    })),
  }).catch(onCancel);
}
```

### Step 2 — Create `control-worker.mjs`

**File:** `cli/control-worker.mjs`

```js
#!/usr/bin/env node
/**
 * cli/control-worker.mjs
 * Usage: orc-control-worker [<worker_id>]
 *
 * Attaches to a registered worker's PTY output log.
 * Selects interactively if <worker_id> is omitted.
 */
import { getAgent, listAgents } from '../lib/agentRegistry.mjs';
import { createAdapter }        from '../adapters/index.mjs';
import { STATE_DIR }            from '../lib/paths.mjs';
import { isInteractive, promptWorkerSelect } from '../lib/prompts.mjs';

let workerId = process.argv[2] && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : null;

if (!workerId) {
  const workers = listAgents(STATE_DIR).filter((a) => a.role !== 'master');
  workerId = await promptWorkerSelect(workers);
  if (!workerId) {
    console.error('Usage: orc-control-worker <worker_id>');
    console.error('Run: orc-status  to list registered workers.');
    process.exit(1);
  }
}

const agent = getAgent(STATE_DIR, workerId);

if (!agent) {
  console.error(`Worker not found: ${workerId}`);
  console.error('Run: orc-status  to list registered agents.');
  process.exit(1);
}

if (agent.role === 'master') {
  console.error(`'${workerId}' is a master agent. Use orc-start-session to interact with master.`);
  process.exit(1);
}

if (!agent.session_handle) {
  console.error(`Worker '${workerId}' has no active session (status: ${agent.status}).`);
  console.error(`Run: orc-worker-start-session ${workerId}`);
  process.exit(1);
}

const adapter = createAdapter(agent.provider);
const alive = await adapter.heartbeatProbe(agent.session_handle);
if (!alive) {
  console.error(`Session ${agent.session_handle} is not reachable.`);
  console.error(`Run: orc-worker-start-session ${workerId} --force-rebind`);
  process.exit(1);
}

adapter.attach(agent.session_handle);
```

Note: `adapter.attach()` prints last 8 KB of the PTY log. For live tail:
```bash
tail -f "$ORCH_STATE_DIR/pty-logs/<worker_id>.log"
```

### Step 3 — Wire into package.json

**File:** `orchestrator/package.json`

Add to the `"bin"` section:
```json
"orc-control-worker": "./cli/control-worker.mjs",
"orc-worker-control": "./cli/control-worker.mjs"
```

Both names point to the same file. `orc-control-worker` is the primary name;
`orc-worker-control` matches the `orc-worker-*` naming pattern.

### Step 4 — Wire into orc.mjs

**File:** `cli/orc.mjs`

Add to the COMMANDS map (alphabetical or at the end):
```js
'control-worker': 'control-worker.mjs',
```

---

## Acceptance criteria

- [ ] `orc-control-worker <id>` attaches to a live worker's PTY output log.
- [ ] Exits 1 with "not found" + `orc-status` guidance when worker missing.
- [ ] Exits 1 with "is a master agent" when target is master role.
- [ ] Exits 1 with `orc-worker-start-session` guidance when no session handle.
- [ ] Exits 1 with `--force-rebind` guidance when heartbeat returns false.
- [ ] Interactive mode: presents select list of non-master workers when no `<id>` provided.
- [ ] Interactive mode: exits 1 with usage when no workers registered and no TTY.
- [ ] `orc control-worker <id>` (via orc.mjs dispatcher) works identically.
- [ ] `promptWorkerSelect` returns null in non-interactive mode.
- [ ] Both bin names (`orc-control-worker`, `orc-worker-control`) are registered.

---

## Tests

**File:** `cli/control-worker.test.mjs` (new)

Pattern: use `vi.doMock` + dynamic import for unit tests; use `spawnSync` for exit-code tests
without a TTY. Follow the pattern from `cli/start-worker-session.test.mjs`.

```js
// Helper: seed agents.json with given agents array
function seedAgents(agentsArray) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1', agents: agentsArray,
  }));
}
```

Test cases:
- `orc-control-worker` with no args and no TTY → exits 1, prints usage
- `orc-control-worker nonexistent` → exits 1, "Worker not found"
- `orc-control-worker master` (agent exists, role=master) → exits 1, "master agent"
- Agent exists, role=worker, session_handle=null → exits 1, `orc-worker-start-session` guidance
- Agent exists, role=worker, session alive → adapter.attach() called, exit 0
- Agent exists, role=worker, session dead (heartbeat false) → exits 1, `--force-rebind` guidance
- `promptWorkerSelect` in non-interactive mode → returns null

---

## Verification

```bash
cd orchestrator && npm test -- control-worker
npm test
# Then manually if node-pty is available:
orc-worker-start-session orc-1 --provider=claude
orc-control-worker orc-1
```
