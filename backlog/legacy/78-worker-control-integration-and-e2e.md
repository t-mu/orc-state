# Task 78 — Add Integration/E2E Coverage for Headless Worker Control Flow

Depends on Tasks 75–77.

## Scope

**In scope:**
- `cli/control-worker.test.mjs` — ensure comprehensive unit coverage (may be done in Task 75; augment if gaps remain)
- `e2e/worker-control-flow.e2e.test.mjs` (new) — file-state e2e for worker control path
- `e2e/orchestrationLifecycle.e2e.test.mjs` — extend if needed for headless worker assertions

**Out of scope:**
- New provider binaries
- Changes to gameplay tests
- Refactoring unrelated orchestrator unit tests
- Live PTY spawning in CI (all pty.spawn calls are mocked)

---

## Current State (read before implementing)

### Test infrastructure

**Unit tests:** `cd orchestrator && npm test` runs vitest against all `*.test.mjs` files.
Config: `orchestrator/vitest.config.mjs` (or inline vitest config).

**E2E tests:** `cd orchestrator && npm run test:e2e` runs vitest with `vitest.e2e.config.mjs`.
Existing e2e: `e2e/orchestrationLifecycle.e2e.test.mjs` — uses direct imports
with `vi.doMock` (no spawnSync), real temp dirs, mocked adapters.

**Pattern for e2e tests (from `orchestrationLifecycle.e2e.test.mjs`):**
- Create temp dir, write `agents.json` / `backlog.json` / `claims.json`
- `vi.doMock('../adapters/index.mjs', () => ({ createAdapter: () => mockAdapter }))`
- `vi.resetModules()` + dynamic import of coordinator/cli modules
- Assert state file changes (agents.json, events.jsonl, claims.json)

**Pattern for CLI unit tests (from `start-worker-session.test.mjs`):**
- `spawnSync('node', ['cli/<name>.mjs', ...], { cwd: repoRoot })` for no-TTY exit tests
- `vi.doMock` + dynamic import for logic tests
- `readFileSync(join(dir, 'agents.json'))` to assert state changes

**No `ORCH_PTY_STRICT` env var** — PTY gating is not a current mechanism. All pty.spawn
calls in tests are mocked via `vi.doMock('node-pty', () => ...)`.

### Session handle format
All handles use `pty:{agentId}` format. PID files at `STATE_DIR/pty-pids/{agentId}.pid`.
Log files at `STATE_DIR/pty-logs/{agentId}.log`.

### Existing e2e test handles
`orchestrationLifecycle.e2e.test.mjs` uses `session_handle: 'pty:worker-01'` already.

---

## Goals

1. E2E validates: worker registers headless → coordinator picks it up → worker gets session handle → `orc-control-worker` attaches.
2. Integration covers the control-worker failure branches with realistic file-state fixtures.
3. All new tests run under existing `npm test` and `npm run test:e2e` scripts.
4. All pty.spawn calls mocked — tests pass in CI without PTY support.

---

## Implementation

### Step 1 — Audit `control-worker.test.mjs` (Task 75 deliverable)

**File:** `cli/control-worker.test.mjs`

Verify it already covers:
- [ ] exit 1 + usage when no args and no TTY
- [ ] exit 1 when worker not found
- [ ] exit 1 when agent has role=master
- [ ] exit 1 when session_handle is null
- [ ] exit 1 when heartbeat returns false
- [ ] adapter.attach() called and exits 0 when session alive

If any of the above are missing, add them here.

### Step 2 — Add E2E worker control scenario

**File:** `e2e/worker-control-flow.e2e.test.mjs` (new)

This test simulates the full headless worker lifecycle from the operator's perspective:

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..');
let dir;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'orc-worker-control-e2e-'));
  process.env.ORCH_STATE_DIR = dir;

  // Seed empty state
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', epics: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
});
```

**Scenario 1: Worker registers headless → session_handle null**
```js
it('worker registers with null session_handle via orc-worker-start-session', async () => {
  vi.doMock('../../adapters/index.mjs', () => ({
    createAdapter: () => ({ heartbeatProbe: vi.fn().mockResolvedValue(false), stop: vi.fn() }),
  }));
  vi.doMock('../../lib/binaryCheck.mjs', () => ({
    checkAndInstallBinary: vi.fn().mockResolvedValue(true),
  }));

  process.argv = ['node', 'start-worker-session.mjs', 'orc-1', '--provider=claude'];
  await import('../../cli/start-worker-session.mjs');

  const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
  const worker = agents.find((a) => a.agent_id === 'orc-1');
  expect(worker).toBeTruthy();
  expect(worker.session_handle).toBeNull();
  expect(worker.provider).toBe('claude');
});
```

**Scenario 2: Coordinator assigns session_handle → control-worker can attach**
```js
it('control-worker attaches after coordinator sets session_handle', async () => {
  // Seed worker with live session_handle (as coordinator would set)
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{
      agent_id: 'orc-1', provider: 'claude', role: 'worker',
      status: 'running', session_handle: 'pty:orc-1',
      provider_ref: { pid: 99999, provider: 'claude', binary: 'claude' },
      registered_at: new Date().toISOString(),
    }],
  }));
  // Write a log file with content (as pty adapter would)
  const logsDir = join(dir, 'pty-logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(logsDir, 'orc-1.log'), 'agent started\ntask assigned\n');

  const attachSpy = vi.fn();
  vi.doMock('../../adapters/index.mjs', () => ({
    createAdapter: () => ({
      heartbeatProbe: vi.fn().mockResolvedValue(true),
      attach: attachSpy,
    }),
  }));

  process.argv = ['node', 'control-worker.mjs', 'orc-1'];
  await import('../../cli/control-worker.mjs');

  expect(attachSpy).toHaveBeenCalledWith('pty:orc-1');
});
```

**Scenario 3: Master foreground — start-session does not block on workers**
```js
it('start-session spawns master and leaves workers headless', async () => {
  // Use spawnSync (no TTY) with flags to avoid prompts
  const result = spawnSync('node', [
    'cli/start-session.mjs',
    '--provider=claude',
    '--agent-id=master',
  ], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
    timeout: 5000,
  });

  // master registered with status running or offline (foreground spawn exits quickly in test)
  const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
  const master = agents.find((a) => a.role === 'master');
  expect(master).toBeTruthy();
  // Workers are not touched by start-session
  expect(agents.filter((a) => a.role !== 'master')).toHaveLength(0);
});
```

Note: `start-session.mjs` spawns `claude` binary with `stdio: 'inherit'`; in CI the binary
won't exist, so the test will see a spawn error. Either mock `child_process.spawn` or skip
this scenario for `npm run test:e2e` and cover it as a unit test instead.

### Step 3 — Verify test scripts

**File:** `orchestrator/package.json`

Ensure `"test:e2e": "vitest run --config vitest.e2e.config.mjs"` is present.
Confirm new e2e test is picked up by the config (pattern match `e2e/**/*.e2e.test.mjs`).

---

## Acceptance criteria

- [ ] `npm test` passes all unit tests including new control-worker coverage.
- [ ] `npm run test:e2e` passes all e2e scenarios.
- [ ] E2E scenario 1: `orc-worker-start-session` sets `session_handle: null`.
- [ ] E2E scenario 2: `orc-control-worker` calls `adapter.attach()` when session is live.
- [ ] E2E scenario 3: `start-session` does not block waiting for worker provisioning.
- [ ] No test spawns a real PTY; all `pty.spawn` / `spawn` calls are mocked.
- [ ] All new tests are deterministic in CI (no timing dependencies beyond vitest fakeTimers if needed).

---

## Tests

See implementation above — this task IS the tests. No additional test files beyond those listed.

---

## Verification

```bash
cd orchestrator && npm test
cd orchestrator && npm run test:e2e
```
