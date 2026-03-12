# Task 43 — Add Run-Reporting CLI Commands

Independent of Tasks 41–42. Depends on Task 40 only (clean slate). Blocks Tasks 44 and 45.

---

## Scope

**In scope:**
- Create 4 new CLI scripts in `cli/`:
  - `run-start.mjs`
  - `run-heartbeat.mjs`
  - `run-finish.mjs`
  - `run-fail.mjs`
- Register all 4 in `orchestrator/package.json` `bin`
- Register all 4 in `cli/orc.mjs` `COMMANDS` map
- Register all 4 in root `package.json` scripts

**Out of scope:**
- `lib/claimManager.mjs` — used as-is, no changes
- Bootstrap templates — updated in Task 44
- Coordinator — updated in Task 45
- No schema changes

---

## Context

### Why these commands are needed

In the SDK adapter model, the coordinator called `adapter.send()`, received a response string
containing `[ORC_EVENT]` JSON lines, and parsed those lines to drive the claim state machine
(`startRun`, `heartbeat`, `finishRun`).

In the tmux adapter model, `adapter.send()` is fire-and-forget and returns `''`. There is no
response text to parse. Instead, agents running as CLI sessions must explicitly report their
state by calling orchestrator CLI commands via their Bash tool.

These 4 commands are thin wrappers around the existing `claimManager.mjs` functions:
- `run-start`    → `startRun(stateDir, runId, agentId)`
- `run-heartbeat` → `heartbeat(stateDir, runId, agentId)`
- `run-finish`   → `finishRun(stateDir, runId, agentId, { success: true })`
- `run-fail`     → `finishRun(stateDir, runId, agentId, { success: false, failureReason, ... })`

`claimManager` already handles file locking and event emission internally — the CLI commands
just parse flags and delegate.

### claimManager function signatures (from `lib/claimManager.mjs`)

```js
startRun(stateDir, runId, agentId)
heartbeat(stateDir, runId, agentId, { leaseDurationMs?, emitEvent? })
finishRun(stateDir, runId, agentId, { success, failureReason?, failureCode?, policy? })
```

All three throw on error (run not found, wrong agent, wrong state). CLI scripts catch and
`process.exit(1)`.

### Flag conventions (consistent with existing orc CLI)

All commands accept:
- `--run-id=<id>` (required)
- `--agent-id=<id>` (required)
- `run-fail` also accepts: `--reason=<text>`, `--code=<code>`, `--policy=<requeue|block>`

Uses `flag()` from `lib/args.mjs`.

**Affected files:**
- `cli/run-start.mjs` — new
- `cli/run-heartbeat.mjs` — new
- `cli/run-finish.mjs` — new
- `cli/run-fail.mjs` — new
- `orchestrator/package.json` — add 4 bin entries
- `cli/orc.mjs` — add 4 COMMANDS entries
- `package.json` (root) — add 4 script entries

---

## Goals

1. Must create 4 CLI scripts with node shebangs and correct flag parsing
2. Each script must call the appropriate `claimManager` function
3. Must exit 0 on success, exit 1 with descriptive stderr on any error
4. Must register all 4 in `orchestrator/package.json` bin, `orc.mjs`, and root `package.json`
5. Must print a brief confirmation line to stdout on success

---

## Implementation

### Step 1 — Create `cli/run-start.mjs`

```js
#!/usr/bin/env node
/**
 * cli/run-start.mjs
 * Report that an agent has started working on a claimed run.
 *
 * Usage: orc-run-start --run-id=<id> --agent-id=<id>
 */
import { startRun } from '../lib/claimManager.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag }      from '../lib/args.mjs';

const runId   = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-start --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  startRun(STATE_DIR, runId, agentId);
  console.log(`✓ run_started: ${runId} (${agentId})`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
```

### Step 2 — Create `cli/run-heartbeat.mjs`

```js
#!/usr/bin/env node
/**
 * cli/run-heartbeat.mjs
 * Renew the lease on an active run to prevent timeout expiry.
 *
 * Usage: orc-run-heartbeat --run-id=<id> --agent-id=<id>
 */
import { heartbeat } from '../lib/claimManager.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag }      from '../lib/args.mjs';

const runId   = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-heartbeat --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  const { lease_expires_at } = heartbeat(STATE_DIR, runId, agentId);
  console.log(`✓ heartbeat: ${runId} (lease until ${lease_expires_at})`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
```

### Step 3 — Create `cli/run-finish.mjs`

```js
#!/usr/bin/env node
/**
 * cli/run-finish.mjs
 * Report successful completion of a run.
 *
 * Usage: orc-run-finish --run-id=<id> --agent-id=<id>
 */
import { finishRun } from '../lib/claimManager.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag }      from '../lib/args.mjs';

const runId   = flag('run-id');
const agentId = flag('agent-id');

if (!runId || !agentId) {
  console.error('Usage: orc-run-finish --run-id=<id> --agent-id=<id>');
  process.exit(1);
}

try {
  finishRun(STATE_DIR, runId, agentId, { success: true });
  console.log(`✓ run_finished: ${runId} (${agentId})`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
```

### Step 4 — Create `cli/run-fail.mjs`

```js
#!/usr/bin/env node
/**
 * cli/run-fail.mjs
 * Report that a run has failed.
 *
 * Usage: orc-run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--code=<code>] [--policy=<requeue|block>]
 */
import { finishRun } from '../lib/claimManager.mjs';
import { STATE_DIR } from '../lib/paths.mjs';
import { flag }      from '../lib/args.mjs';

const runId         = flag('run-id');
const agentId       = flag('agent-id');
const failureReason = flag('reason') ?? 'worker reported failure';
const failureCode   = flag('code')   ?? 'ERR_WORKER_REPORTED_FAILURE';
const policy        = flag('policy') ?? 'requeue';

if (!runId || !agentId) {
  console.error('Usage: orc-run-fail --run-id=<id> --agent-id=<id> [--reason=<text>] [--code=<code>] [--policy=requeue|block]');
  process.exit(1);
}

try {
  finishRun(STATE_DIR, runId, agentId, { success: false, failureReason, failureCode, policy });
  console.log(`✓ run_failed: ${runId} (${agentId}) reason=${failureReason}`);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
```

### Step 5 — Add bin entries to `orchestrator/package.json`

Add inside the existing `"bin"` object:

```json
"orc-run-start":     "./cli/run-start.mjs",
"orc-run-heartbeat": "./cli/run-heartbeat.mjs",
"orc-run-finish":    "./cli/run-finish.mjs",
"orc-run-fail":      "./cli/run-fail.mjs"
```

### Step 6 — Add entries to `cli/orc.mjs` COMMANDS map

Add inside the existing `COMMANDS` object:

```js
'run-start':     'run-start.mjs',
'run-heartbeat': 'run-heartbeat.mjs',
'run-finish':    'run-finish.mjs',
'run-fail':      'run-fail.mjs',
```

### Step 7 — Add scripts to root `package.json`

Add inside the existing `"scripts"` object:

```json
"orc:run:start":     "node cli/run-start.mjs",
"orc:run:heartbeat": "node cli/run-heartbeat.mjs",
"orc:run:finish":    "node cli/run-finish.mjs",
"orc:run:fail":      "node cli/run-fail.mjs"
```

---

## Acceptance criteria

- [ ] `orc-run-start --run-id=R --agent-id=A` transitions a claimed run to `in_progress` and prints `✓ run_started`
- [ ] `orc-run-heartbeat --run-id=R --agent-id=A` renews the lease and prints `✓ heartbeat`
- [ ] `orc-run-finish --run-id=R --agent-id=A` marks the run done and prints `✓ run_finished`
- [ ] `orc-run-fail --run-id=R --agent-id=A --reason="..."` marks the run failed and prints `✓ run_failed`
- [ ] All 4 commands exit 1 with a descriptive stderr message when `--run-id` or `--agent-id` is missing
- [ ] All 4 commands exit 1 when the run_id does not exist in claims.json
- [ ] All 4 registered in `orchestrator/package.json` bin
- [ ] All 4 registered in `orc.mjs` COMMANDS
- [ ] `package-contract.test.mjs` still passes (bin entries map to existing files)

---

## Tests

Add to a new `cli/run-reporting.test.mjs` using `spawnSync` + temp state dir:

```js
it('run-start transitions claimed run to in_progress', () => {
  // Seed claims.json with a claimed run (state: 'claimed')
  // Run: orc-run-start --run-id=R --agent-id=A
  // Assert: claims.json shows state: 'in_progress'
  // Assert: events.jsonl contains run_started event
  // Assert: exit code 0
});

it('run-start exits 1 when run not found', () => {
  // Seed empty claims.json
  // Run: orc-run-start --run-id=nonexistent --agent-id=A
  // Assert: exit code 1, stderr contains 'Error'
});

it('run-heartbeat renews the lease', () => { ... });
it('run-finish marks task done in backlog and claims', () => { ... });
it('run-fail requeues task by default', () => { ... });
it('run-fail with --policy=block sets status to blocked', () => { ... });
```

---

## Verification

```bash
# After seeding a state dir with a claimed run:
ORCH_STATE_DIR=/tmp/orc-test node cli/run-start.mjs \
  --run-id=run-20260101000000-abcd --agent-id=bob
# Expected: ✓ run_started: run-20260101000000-abcd (bob)

nvm use 22 && npm run test:orc:unit
```
