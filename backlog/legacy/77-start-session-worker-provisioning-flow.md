# Task 77 — Refine `start-session` Worker Provisioning Flow for Minimal Operator Friction

Depends on Tasks 74 and 76. Blocks Tasks 78–79.

## Scope

**In scope:**
- `cli/start-session.mjs` — next-step output and worker flow micro-polish
- `lib/prompts.mjs` — tighten prompt choice labels for worker pool and create-worker steps
- `cli/start-session.test.mjs` — add/update assertions for flow order and output

**Out of scope:**
- New long-lived worker orchestration features in coordinator
- Changes to task delegation logic
- Provider-specific behavior

---

## Current State (read before implementing)

### Wizard flow order in `start-session.mjs` (already correct — verify, don't change)

```
1. coordinatorAction (line 137) — promptCoordinatorAction(coordinatorPid)
2. masterAction (line 149)      — promptMasterAction(master)
3. workerAction (line 160)      — promptWorkerPoolAction(workers())
4. createWorkerAction (line 175) — promptCreateWorkerAction(workers())
```

This order is correct and must not change.

### Current prompt choice labels (candidates for tightening)

`promptWorkerPoolAction` (lib/prompts.mjs, lines 219–238):
- `'Reuse existing workers'` → shorten to `'Reuse workers'`
- `'Clear all workers'` → keep
- `'Cancel'` → keep

`promptCreateWorkerAction` (lib/prompts.mjs, lines 241–263):
- `'Skip worker creation'` → shorten to `'Skip'`
- `'Create worker'` → keep
- `'Cancel'` → keep

### Next-step output (start-session.mjs lines 257–261)

Current:
```
Register workers:   orc-worker-register <id> --provider=<claude|codex|gemini>
Start workers:      orc-worker-start-session <id>
Create tasks:       orc-task-create --epic=project --ref=<ref> --title="..."
Monitor:            orc-watch
```

After Task 75 (`orc-control-worker`) is done, the output should reference `orc-control-worker`
instead of `orc-worker-start-session` as the primary operator action. Update the next-step output:
```
Start workers:      orc-worker-start-session <id>
Control workers:    orc-control-worker [<id>]
Create tasks:       orc-task-create --epic=project --ref=<ref> --title="..."
Monitor:            orc-watch
```

Remove the `orc-worker-register` line — `orc-start-session` now auto-registers workers in the
create flow (it uses `registerAgent` internally), so `orc-worker-register` is a lower-level
command that need not be in the wizard's next-step hints.

### Non-interactive behavior

In non-interactive mode (no TTY): all prompt functions return defaults directly without blocking:
- `promptCoordinatorAction(pid)`: if running → `'reuse'`; if not → `'start'`
- `promptMasterAction(existing)`: if absent → `'register'`; if present → `'reuse'`
- `promptWorkerPoolAction(workers)`: if empty → `'reuse'` (no prompt); if non-empty → `'reuse'`
- `promptCreateWorkerAction(workers)`: non-interactive → `'skip'`

This behavior is already correct. The task is to verify it with a test.

---

## Goals

1. Prompt order unchanged: coordinator → master → worker pool → create worker.
2. Compact choice labels reduce cognitive load in interactive sessions.
3. Next-step output references `orc-control-worker` after Task 75 is merged.
4. Non-interactive runs verified by test to skip worker creation without blocking.

---

## Implementation

### Step 1 — Tighten `promptWorkerPoolAction` labels

**File:** `lib/prompts.mjs` (lines 219–238)

```js
choices: [
  {
    value: 'reuse',
    name: 'Reuse workers',
    description: 'Keep worker registrations as-is',
  },
  {
    value: 'clear_all',
    name: 'Clear all workers',
    description: 'Remove all non-master workers before continuing',
  },
  {
    value: 'cancel',
    name: 'Cancel',
    description: 'Exit without changes',
  },
],
```

### Step 2 — Tighten `promptCreateWorkerAction` labels

**File:** `lib/prompts.mjs` (lines 241–263)

```js
choices: [
  {
    value: 'skip',
    name: 'Skip',
    description: 'Continue without creating a worker now',
  },
  {
    value: 'create',
    name: 'Create worker',
    description: 'Auto-assigns next orc-<N> ID; prompts for provider. Override with --worker-id.',
  },
  {
    value: 'cancel',
    name: 'Cancel',
    description: 'Exit without changes',
  },
],
```

Note: `message` line also update if Task 76 changes the auto-id description:
```js
message: workerCount > 0 ? 'Add another worker?' : 'No workers yet. Add a worker now?',
```

### Step 3 — Update next-step output

**File:** `cli/start-session.mjs` (lines 257–261)

Replace the `console.log` block:
```js
console.log('\nNext steps:');
console.log('  Start workers:      orc-worker-start-session <id>');
console.log('  Control workers:    orc-control-worker [<id>]');
console.log('  Create tasks:       orc-task-create --epic=project --ref=<ref> --title="..."');
console.log('  Monitor:            orc-watch');
```

---

## Acceptance criteria

- [ ] `promptWorkerPoolAction` shows "Reuse workers" (not "Reuse existing workers").
- [ ] `promptCreateWorkerAction` shows "Skip" (not "Skip worker creation").
- [ ] Next-step output includes `orc-control-worker` and `orc-watch`.
- [ ] Next-step output does NOT include `orc-worker-register`.
- [ ] Prompt call order: `promptCoordinatorAction` before `promptMasterAction` before
  `promptWorkerPoolAction` before `promptCreateWorkerAction`.
- [ ] Non-interactive run with empty state exits without prompting for worker creation.

---

## Tests

**File:** `cli/start-session.test.mjs`

### Verify prompt call order
In the interactive mock path, spy on all four prompt functions and assert call order:
```js
it('calls prompts in coordinator -> master -> workers -> create-worker order', async () => {
  // Use vi.doMock to stub all four prompt functions
  // Drive each to return the 'proceed' value (start/register/reuse/skip)
  // Assert call order: coordinatorAction called before masterAction, etc.
  const order = [];
  coordinatorActionMock.mockImplementation(async () => { order.push('coordinator'); return 'start'; });
  masterActionMock.mockImplementation(async () => { order.push('master'); return 'register'; });
  workerPoolActionMock.mockImplementation(async () => { order.push('workers'); return 'reuse'; });
  createWorkerActionMock.mockImplementation(async () => { order.push('create'); return 'skip'; });
  // ... import and run
  expect(order).toEqual(['coordinator', 'master', 'workers', 'create']);
});
```

### Non-interactive skips worker creation
```js
it('non-interactive: does not prompt for worker creation', async () => {
  // Set up: coordinator not running, no master, no workers
  // Run with --provider=claude --agent-id=master flags (no TTY)
  // Assert promptCreateWorkerAction was NOT called
  // (non-interactive path short-circuits with 'skip')
});
```

### Next-step output
```js
it('prints orc-control-worker in next steps output', async () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  // ... run session
  const output = logSpy.mock.calls.flat().join('\n');
  expect(output).toContain('orc-control-worker');
  expect(output).not.toContain('orc-worker-register');
});
```

---

## Verification

```bash
cd orchestrator && npm test -- start-session
npm test
```
