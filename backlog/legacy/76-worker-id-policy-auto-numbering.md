# Task 76 — Implement Worker ID Policy: Auto `orc-<N>` with Optional Override

Depends on Task 74. Blocks Tasks 77–79.

## Scope

**In scope:**
- `lib/agentRegistry.mjs` — add exported `nextWorkerId(stateDir)` helper
- `cli/start-session.mjs` — use `nextWorkerId` in the create-worker path
- `lib/prompts.mjs` — update `promptCreateWorkerAction` text to mention auto-id

**Out of scope:**
- Renaming existing registered agents
- Aliases or synonyms for agent IDs
- Backfilling historical IDs in state files

---

## Current State (read before implementing)

### `start-session.mjs` create-worker path (lines 180–203)

```js
if (createWorkerAction === 'create') {
  ensureState();
  const workerId = await promptAgentId(workerIdFlag);   // ← THIS changes
  if (!workerId) {
    console.error('Missing worker ID. Use --worker-id=<id> or run interactively.');
    process.exit(1);
  }
  if (workerId === 'master') {
    console.error("Worker ID 'master' is reserved for the master session.");
    process.exit(1);
  }
  const existingWorker = getAgent(STATE_DIR, workerId);
  if (existingWorker) { /* log and skip */ }
  else {
    const workerProvider = await promptProvider(workerProviderFlag);
    ...
    registerAgent(STATE_DIR, { agent_id: workerId, provider: workerProvider, role: 'worker' });
  }
}
```

### `promptCreateWorkerAction` in `prompts.mjs` (lines 241–264)
Shows choices: "Skip worker creation" / "Create worker" / "Cancel".

### `agentRegistry.mjs`
Exports: `registerAgent`, `updateAgentRuntime`, `getAgent`, `listAgents`, `removeAgent`.
Does NOT yet export a `nextWorkerId` helper.

---

## Goals

1. New workers auto-assigned IDs `orc-1`, `orc-2`, … (lowest available gap).
2. No collisions with any existing agents (worker or master).
3. `--worker-id=<id>` flag still overrides auto-id and skips prompting.
4. `master` ID remains reserved and can never be auto-generated.
5. Worker provider prompt (`--worker-provider`) unchanged.

---

## Implementation

### Step 1 — Add `nextWorkerId` to `agentRegistry.mjs`

**File:** `lib/agentRegistry.mjs`

Add as a new named export at the bottom of the file:

```js
/**
 * Return the next available auto-generated worker ID in the form `orc-<N>`.
 * Scans all registered agents (any role) to avoid collisions.
 * Fills gaps: if orc-1 is deleted, orc-1 is reused before orc-3 is created.
 *
 * @param {string} stateDir
 * @returns {string}  e.g. 'orc-1'
 */
export function nextWorkerId(stateDir) {
  const agents = readAgents(stateDir).agents;
  const used = new Set(agents.map((a) => a.agent_id));
  for (let n = 1; ; n++) {
    const id = `orc-${n}`;
    if (!used.has(id)) return id;
  }
}
```

Note: `readAgents` is a module-private function already defined in `agentRegistry.mjs`
at line 9. The new export uses it directly — no changes to `readAgents`.

### Step 2 — Use `nextWorkerId` in the create-worker path

**File:** `cli/start-session.mjs`

Add import (update the `agentRegistry.mjs` import line):
```js
import {
  listAgents, registerAgent, getAgent, removeAgent, updateAgentRuntime, nextWorkerId,
} from '../lib/agentRegistry.mjs';
```

Replace the create-worker block (lines 180–203). New logic:

```js
if (createWorkerAction === 'create') {
  ensureState();

  // If --worker-id provided, validate it; otherwise auto-generate.
  let workerId;
  if (workerIdFlag) {
    workerId = workerIdFlag;
    if (workerId === 'master') {
      console.error("Worker ID 'master' is reserved for the master session.");
      process.exit(1);
    }
  } else {
    workerId = nextWorkerId(STATE_DIR);
  }

  const existingWorker = getAgent(STATE_DIR, workerId);
  if (existingWorker) {
    console.log(`✓ Worker '${workerId}' already exists (${existingWorker.provider}) status=${existingWorker.status}`);
  } else {
    // Still prompt for provider (unchanged)
    const workerProvider = await promptProvider(workerProviderFlag);
    if (!workerProvider) {
      console.error('Missing worker provider. Use --worker-provider=<claude|codex|gemini> or run interactively.');
      process.exit(1);
    }
    registerAgent(STATE_DIR, { agent_id: workerId, provider: workerProvider, role: 'worker' });
    console.log(`✓ Registered worker '${workerId}' (${workerProvider})`);
  }
}
```

Key changes from current code:
- Remove `await promptAgentId(workerIdFlag)` call and the "Missing worker ID" error path
- Replace with `nextWorkerId(STATE_DIR)` when no `--worker-id` flag
- When `--worker-id` is provided, use it directly (same as before) but skip `promptAgentId`

### Step 3 — Update `promptCreateWorkerAction` description text

**File:** `lib/prompts.mjs` (`promptCreateWorkerAction`, lines 241–264)

Update the "Create worker" choice description:
```js
{
  value: 'create',
  name: 'Create worker',
  description: 'Auto-assigns next orc-<N> ID; prompts for provider. Override with --worker-id.',
},
```

---

## Acceptance criteria

- [ ] Running `start-session.mjs` with `--provider=claude` and choosing "Create worker" registers `orc-1` (first run), `orc-2` (second run), etc.
- [ ] If `orc-1` is deleted and `orc-2` exists, next ID is `orc-1` (gap fill).
- [ ] `--worker-id=my-agent` bypasses auto-numbering and uses `my-agent`.
- [ ] `--worker-id=master` exits 1 with "reserved" error.
- [ ] `nextWorkerId(stateDir)` never returns `'master'`.
- [ ] Non-interactive mode with no `--worker-id` uses auto-id without prompting.
- [ ] `promptCreateWorkerAction` description mentions auto-id.

---

## Tests

### `agentRegistry.mjs` tests
**File:** `lib/agentRegistry.test.mjs` — add a `nextWorkerId` describe block.

```js
describe('nextWorkerId()', () => {
  it('returns orc-1 when no workers registered', () => {
    expect(nextWorkerId(dir)).toBe('orc-1');
  });
  it('returns orc-2 when orc-1 already registered', () => {
    registerAgent(dir, { agent_id: 'orc-1', provider: 'claude', role: 'worker' });
    expect(nextWorkerId(dir)).toBe('orc-2');
  });
  it('fills gaps — returns orc-1 when only orc-2 exists', () => {
    registerAgent(dir, { agent_id: 'orc-2', provider: 'claude', role: 'worker' });
    expect(nextWorkerId(dir)).toBe('orc-1');
  });
  it('never returns master', () => {
    // Even if somehow master is in the list
    expect(nextWorkerId(dir)).not.toBe('master');
  });
  it('ignores non-orc-N IDs when finding next', () => {
    registerAgent(dir, { agent_id: 'custom-agent', provider: 'claude', role: 'worker' });
    expect(nextWorkerId(dir)).toBe('orc-1');
  });
});
```

### `start-session.mjs` tests
**File:** `cli/start-session.test.mjs`

Add cases to the "create worker" describe block:
- No `--worker-id` → registered agent has id `orc-1`
- With `--worker-id=my-bot` → registered agent has id `my-bot`
- `--worker-id=master` → process.exit(1)
- With existing `orc-1` registered → second create assigns `orc-2`

---

## Verification

```bash
cd orchestrator && npm test -- agentRegistry start-session
npm test
```
