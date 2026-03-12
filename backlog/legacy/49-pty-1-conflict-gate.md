# Task 49 — Master Conflict Gate in `orc-start-session`

Independent of the node-pty migration — can be implemented first. Blocks Task 53.

---

## Scope

**In scope:**
- Add `promptExistingMasterConflict()` to `lib/prompts.mjs`
- Insert the conflict gate into `cli/start-session.mjs`
- Add `removeAgent` to the imports in `start-session.mjs`

**Out of scope:**
- All other CLI scripts — do not touch
- Adapter files — do not touch
- Coordinator logic — do not touch
- Any change to how sessions are created (that is Task 53)

---

## Context

Running `orc-start-session` twice — e.g. opening a second terminal and re-running the command — currently silently reuses the existing master registration and continues into session-start logic. This is confusing: the user is not told that a master already exists, and if they meant to start fresh, there is no way to do so interactively.

The fix: when `listAgents()` finds an existing `role === 'master'` entry, pause and prompt the user for one of three actions:

| Action | Behaviour |
|---|---|
| **Reuse** | Keep the existing registration. Ensure coordinator is running. Exit. |
| **Replace** | Call `removeAgent()` on the old master. Fall through to fresh registration. |
| **Cancel** | Exit 0 with no state changes. |

In non-interactive (CI / piped stdin) mode the script must not hang waiting for input — it prints an error message pointing the user to `orc-worker-remove` and exits 1.

**Affected files:**
- `lib/prompts.mjs` — add `promptExistingMasterConflict`
- `cli/start-session.mjs` — insert gate, add `removeAgent` import

---

## Goals

1. Must detect an existing master registration and pause before any state change.
2. `reuse` must verify the coordinator is running (starting it if not), print next-step hints, then exit 0.
3. `replace` must call `removeAgent(STATE_DIR, master.agent_id)` and set `master = null` so the registration block below the gate runs normally.
4. `cancel` must exit 0 with no state changes.
5. In non-interactive mode must exit 1 with a descriptive error and a command the user can run to fix the situation manually.
6. Must not break the happy path (no existing master) — the gate must be a strict no-op when `master === null`.

---

## Implementation

### Step 1 — Add `promptExistingMasterConflict` to `lib/prompts.mjs`

Append after the existing prompt functions:

```js
/**
 * Prompt when orc-start-session finds an existing master registration.
 * Returns 'reuse' | 'replace' | 'cancel'.
 *
 * In non-interactive mode: prints an actionable error and returns 'cancel'.
 *
 * @param {{ agent_id: string, provider: string }} existingMaster
 * @param {number|null} coordinatorPid  - null when coordinator is not running
 */
export async function promptExistingMasterConflict(existingMaster, coordinatorPid) {
  const pidInfo = coordinatorPid ? `running (PID ${coordinatorPid})` : 'not running';
  console.log(`\nMaster agent '${existingMaster.agent_id}' (${existingMaster.provider}) is already registered.`);
  console.log(`Coordinator: ${pidInfo}\n`);

  if (!isInteractive()) {
    console.error('Error: a master agent is already registered.');
    console.error('To remove it first, run:');
    console.error(`  orc-worker-remove ${existingMaster.agent_id}`);
    return 'cancel';
  }

  return select({
    message: 'What do you want to do?',
    choices: [
      {
        value: 'reuse',
        name:  'Reuse existing registration',
        description: 'Keep current master; ensure coordinator is running',
      },
      {
        value: 'replace',
        name:  `Replace — deregister '${existingMaster.agent_id}' and register this session`,
        description: 'Remove old registration and start fresh',
      },
      {
        value: 'cancel',
        name:  'Cancel',
        description: 'Exit without changes',
      },
    ],
  }).catch(onCancel);
}
```

### Step 2 — Update imports in `cli/start-session.mjs`

Add `removeAgent` to the agentRegistry import line:

```js
// before
import { listAgents, registerAgent, getAgent, updateAgentRuntime } from '../lib/agentRegistry.mjs';

// after
import { listAgents, registerAgent, getAgent, updateAgentRuntime, removeAgent } from '../lib/agentRegistry.mjs';
```

Add `promptExistingMasterConflict` to the prompts import line:

```js
// before
import { promptAgentId, promptProvider, isInteractive } from '../lib/prompts.mjs';

// after
import { promptAgentId, promptProvider, isInteractive, promptExistingMasterConflict } from '../lib/prompts.mjs';
```

### Step 3 — Insert conflict gate in `cli/start-session.mjs`

Find the line:
```js
let master = listAgents(STATE_DIR).find((a) => a.role === 'master') ?? null;
```

Immediately after it, before the `if (!master)` registration block, insert:

```js
// ── Conflict gate ──────────────────────────────────────────────────────────

if (master) {
  const { running, pid: existingPid } = coordinatorStatus();
  const action = await promptExistingMasterConflict(master, running ? existingPid : null);

  if (action === 'cancel') {
    console.log('Cancelled.');
    process.exit(0);
  }

  if (action === 'replace') {
    removeAgent(STATE_DIR, master.agent_id);
    console.log(`✓ Removed existing master '${master.agent_id}'`);
    master = null;
    // Fall through to registration block below.
  }

  if (action === 'reuse') {
    const { running: stillRunning, pid: pid2 } = coordinatorStatus();
    if (stillRunning) {
      console.log(`✓ Coordinator already running  (PID ${pid2})`);
    } else {
      console.log('Starting coordinator...');
      const newPid = await spawnCoordinator();
      console.log(newPid
        ? `✓ Coordinator running  (PID ${newPid})`
        : '  Coordinator spawned (PID confirmation pending)');
    }
    console.log('\n✓ Reusing existing master registration. Your terminal is the master.');
    console.log('\nNext steps:');
    console.log('  orc-status   — view system state');
    console.log('  orc-watch    — monitor progress');
    process.exit(0);
  }
}
```

Invariant: the `if (!master)` registration block immediately below must not be modified.

---

## Acceptance criteria

- [ ] Running `orc-start-session` when `agents.json` already contains a `role === 'master'` entry shows the conflict prompt before doing anything else.
- [ ] Choosing `cancel` exits 0 and leaves `agents.json` unchanged.
- [ ] Choosing `replace` removes the old master from `agents.json` and continues into normal registration (a new `role === 'master'` entry is created).
- [ ] Choosing `reuse` starts the coordinator if needed, prints next-step hints, and exits 0 without modifying `agents.json`.
- [ ] In non-interactive mode (piped stdin), the script exits 1 and prints an error that includes the `orc-worker-remove` command.
- [ ] When no existing master is found, the gate is a no-op — no prompt, no change in behaviour.
- [ ] No files outside the stated scope are modified.

---

## Tests

Add to `cli/start-session.test.mjs` (create file if it doesn't exist, following pattern of other CLI tests):

```js
it('conflict gate — cancel exits 0 without modifying agents.json', async () => { ... });
it('conflict gate — replace removes old master and continues to registration', async () => { ... });
it('conflict gate — reuse starts coordinator if not running and exits', async () => { ... });
it('conflict gate — non-interactive mode exits 1 with actionable error', async () => { ... });
it('no gate shown when no master is registered', async () => { ... });
```

Use `vi.doMock('../adapters/index.mjs', ...)` and `vi.doMock('../lib/prompts.mjs', ...)` to control prompt responses. Seed `agents.json` with a master entry for the conflict cases.

---

## Verification

```bash
nvm use 24 && npm run test:orc:unit

# Manual smoke — interactive
node cli/start-session.mjs --provider=claude
# Second run: should show conflict prompt
node cli/start-session.mjs --provider=claude

# Non-interactive
echo "" | node cli/start-session.mjs --provider=claude
# Expected: exits 1, prints 'orc-worker-remove' hint
```
