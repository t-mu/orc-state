# Task 13 — Orchestrator A1: Extract Shared Arg Parser and State Reader

> **Track A — Step 1 of 3.** No prerequisites. Track B (tasks 16–18) can start in parallel.

## Context

Six orchestrator files each define their own private copy of the same 3-line argument parser. In `coordinator.mjs` (lines 30–40):

```js
function arg(name, defaultVal) {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag ? flag.split('=')[1] : defaultVal;
}

function intArg(name, defaultVal) {
  const raw = arg(name, String(defaultVal));
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultVal;
  return parsed;
}
```

Identical (or near-identical) `flag()` / `arg()` / `getFlag()` functions appear in `cli/doctor.mjs`, `cli/preflight.mjs`, `cli/runs-active.mjs`, and `cli/register-worker.mjs`. Each copy diverges subtly — some handle `=` in values, some don't; some call the function `flag`, others `arg`, others `getFlag`.

`lib/claimManager.mjs` defines its own private `readJson` (lines 14–16) and `findTask` (lines 24–30) helpers that are not exported or shared:

```js
function readJson(stateDir, file) {
  return JSON.parse(readFileSync(join(stateDir, file), 'utf8'));
}

function findTask(backlog, taskRef) {
  for (const epic of (backlog?.epics ?? [])) {
    const t = epic.tasks?.find(t => t.ref === taskRef);
    if (t) return t;
  }
  return null;
}
```

Both helpers are needed in at least two other modules (`statusView.mjs`, `coordinator.mjs`). Without a shared module every future caller copies these again.

---

## Goals

1. Create `lib/args.mjs` with a canonical `flag()` and `intFlag()` that handles edge cases once.
2. Create `lib/stateReader.mjs` with `readJson()` and `findTask()`.
3. Replace all six private arg-parser copies with imports from `lib/args.mjs`.
4. Replace `claimManager.mjs`'s private helpers with imports from `lib/stateReader.mjs`.
5. No behaviour changes — all existing tests must continue to pass.

---

## Step-by-Step Instructions

### Step 1 — Create `lib/args.mjs`

Create `lib/args.mjs`:

```js
/**
 * Parse a --name=value flag from argv.
 * Handles values that contain '=' (e.g. --key=a=b).
 * Returns the value string, or null if the flag is absent.
 */
export function flag(name, argv = process.argv.slice(2)) {
  const match = argv.find((a) => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

/**
 * Parse --name=value and coerce to a positive integer.
 * Returns defaultVal if the flag is absent or the value is not a positive integer.
 */
export function intFlag(name, defaultVal, argv = process.argv.slice(2)) {
  const raw = flag(name, argv);
  if (raw == null) return defaultVal;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}
```

### Step 2 — Create `lib/stateReader.mjs`

Create `lib/stateReader.mjs`:

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readJson(stateDir, file) {
  return JSON.parse(readFileSync(join(stateDir, file), 'utf8'));
}

export function findTask(backlog, taskRef) {
  for (const epic of (backlog?.epics ?? [])) {
    const task = epic.tasks?.find((t) => t.ref === taskRef);
    if (task) return task;
  }
  return null;
}
```

### Step 3 — Update `lib/claimManager.mjs`

Add at the top of the import block:

```js
import { readJson, findTask } from './stateReader.mjs';
```

Delete the private `readJson` function (lines 14–16) and the private `findTask` function (lines 24–30). The private `readAgentById` helper also calls `readJson` — it will automatically use the imported version after the locals are removed.

The `emit` helper and everything below line 40 are unchanged.

### Step 4 — Update `coordinator.mjs`

Add to the import block at the top:

```js
import { flag, intFlag } from './lib/args.mjs';
import { findTask } from './lib/stateReader.mjs';
```

Delete the private `arg()` function (lines 30–33) and `intArg()` function (lines 35–40).

Update every call site in the constants block:

```js
// BEFORE:
const INTERVAL_MS                = intArg('interval-ms', 30000);
const MODE                       = arg('mode', 'autonomous');
const RUN_START_TIMEOUT_MS       = intArg('run-start-timeout-ms', 300000);
// ... etc

// AFTER:
const INTERVAL_MS                = intFlag('interval-ms', 30000);
const MODE                       = flag('mode') ?? 'autonomous';
const RUN_START_TIMEOUT_MS       = intFlag('run-start-timeout-ms', 300000);
// ... etc
```

Update `readTaskContext(stateDir, taskRef)` to use `findTask` from `stateReader`:

```js
// BEFORE (inner loop):
for (const epic of backlog.epics ?? []) {
  const task = epic.tasks?.find(t => t.ref === taskRef);
  if (task) return { task, ... };
}

// AFTER:
const task = findTask(backlog, taskRef);
if (task) return { task, ... };
```

### Step 5 — Update the four CLI files

In each of `cli/doctor.mjs`, `cli/preflight.mjs`, `cli/runs-active.mjs`, `cli/register-worker.mjs`:

1. Add `import { flag } from '../lib/args.mjs';` at the top.
2. Delete the private `flag()` / `arg()` / `getFlag()` function definition.
3. Update all call sites — the logic is identical so this is purely mechanical.

### Step 6 — Do not touch these files in this task

`cli/message.mjs` and `cli/planner-loop.mjs` are deleted by Track B. `cli/progress.mjs` and `cli/delegate-task.mjs` are refactored by B2/B3. `lib/progressValidation.mjs` is rewritten by B3. Leave all four alone.

### Step 7 — Run tests

```
nvm use 22 && npm test
```

No new tests are required for this mechanical refactor. All existing orchestrator tests must pass.

---

## Acceptance Criteria

- [ ] `lib/args.mjs` exists and exports `flag(name, argv?)` and `intFlag(name, defaultVal, argv?)`.
- [ ] `lib/stateReader.mjs` exists and exports `readJson(stateDir, file)` and `findTask(backlog, ref)`.
- [ ] `coordinator.mjs` has no private `arg()` or `intArg()` function; it imports from `lib/args.mjs`.
- [ ] `cli/doctor.mjs`, `cli/preflight.mjs`, `cli/runs-active.mjs`, `cli/register-worker.mjs` each import `flag` from `../lib/args.mjs` and have no private copy.
- [ ] `lib/claimManager.mjs` imports `readJson` and `findTask` from `./stateReader.mjs` and has no private copies.
- [ ] All existing orchestrator tests pass.
