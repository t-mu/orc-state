---
ref: general/11-tmux-adapter-tests
feature: general
priority: high
status: blocked
---

# Task 11 — Write tmux Adapter Unit Tests

Depends on Task 6. Blocks Task 13.

## Scope

**In scope:**
- New file `adapters/tmux.test.ts` — full unit test suite for `createTmuxAdapter`
- Mock `node:child_process` (`execFileSync`, `spawnSync`) via `vi.doMock`; no real tmux process spawned
- Cover all seven adapter methods: `start`, `send`, `attach`, `heartbeatProbe`, `stop`, `ownsSession`, `detectInputBlock`
- Cover factory and contract validation (`createAdapter`, `assertAdapterContract`)

**Out of scope:**
- Deleting `adapters/pty.test.ts` (Task 13 — keep both until full cleanup)
- Integration tests against a real tmux server (out of scope for unit test layer)
- Any changes to `adapters/tmux.ts` (Task 6)

---

## Context

`adapters/pty.test.ts` (391 lines) is the reference: it mocks `node-pty`, tests every adapter method, and verifies the factory contract. `adapters/tmux.test.ts` mirrors that structure exactly, replacing `vi.doMock('node-pty', ...)` with `vi.doMock('node:child_process', ...)`. Each test group maps 1:1 to its `pty.test.ts` counterpart.

### Current state

`adapters/pty.test.ts` covers the node-pty adapter. There are no tests for `adapters/tmux.ts`.

### Desired state

`adapters/tmux.test.ts` provides the same coverage depth for the tmux adapter. Both test files coexist until Task 13 removes the pty adapter and its tests.

### Start here

- `adapters/pty.test.ts` — reference structure; mirror group names and test descriptions
- `adapters/tmux.ts` — implementation to test; read the method signatures and constants
- `adapters/interface.ts` — `assertAdapterContract` used in factory tests

**Affected files:**
- `adapters/tmux.test.ts` — new file (created by this task)

---

## Goals

1. Must mock `execFileSync` and `spawnSync` from `node:child_process` via `vi.doMock`; no real tmux calls.
2. Must test `start()`: session name, env propagation, `remain-on-exit`, codex vs. non-codex bootstrap delivery, pre-existing session kill, spawn failure.
3. Must test `send()`: chunked send-keys calls, ESC + 600ms wait + Enter + SIGWINCH resize, return value `''`, malformed handle throws.
4. Must test `heartbeatProbe()`: true when `has-session` + `pane_dead='0'`; false when `has-session` throws; false when `pane_dead='1'`; never throws on malformed handle.
5. Must test `stop()`: calls `kill-session`; no-op when throws; safe to call twice.
6. Must test `attach()`: calls `spawnSync` with `stdio:'inherit'`; prints error when not TTY.
7. Must test `detectInputBlock()`: calls `capture-pane -S -50`; returns match or null.
8. Must test factory: `createAdapter` returns valid adapter for claude/codex/gemini; throws for unknown provider.

---

## Implementation

### Step 1 — Test setup: mock node:child_process

**File:** `adapters/tmux.test.ts`

```ts
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'tmux-test-'));
  process.env.ORCH_STATE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
});

function makeChildProcessMock(overrides: {
  execFileSync?: (...args: unknown[]) => string;
  spawnSync?: (...args: unknown[]) => { status: number };
} = {}) {
  const execFileSync = vi.fn().mockReturnValue('');   // default: success, empty output
  const spawnSync    = vi.fn().mockReturnValue({ status: 0 });
  return {
    execFileSync: overrides.execFileSync ? vi.fn().mockImplementation(overrides.execFileSync) : execFileSync,
    spawnSync:    overrides.spawnSync    ? vi.fn().mockImplementation(overrides.spawnSync) : spawnSync,
  };
}

async function makeAdapter(provider = 'claude', mocks = makeChildProcessMock()) {
  vi.doMock('node:child_process', () => mocks);
  const { createTmuxAdapter } = await import('./tmux.ts');
  return { adapter: createTmuxAdapter({ provider }), mocks };
}
```

### Step 2 — `start()` tests

**File:** `adapters/tmux.test.ts`

```ts
describe('tmux adapter start()', () => {
  it('calls tmux new-session with correct session name and returns handle', async () => { ... });
  it('sets remain-on-exit on after new-session', async () => { ... });
  it('merges explicit env vars into new-session -e args', async () => { ... });
  it('kills pre-existing session before spawning', async () => { ... });
  it('delivers bootstrap via send-keys for claude provider', async () => { ... });
  it('passes codex bootstrap as CLI arg, not via send-keys', async () => { ... });
  it('does not send bootstrap when system_prompt absent', async () => { ... });
  it('throws when tmux new-session fails', async () => { ... });
  it('returns session_handle tmux:{agentId} and provider_ref with session_name', async () => { ... });
});
```

Key assertion patterns:
- `expect(mocks.execFileSync).toHaveBeenCalledWith('tmux', expect.arrayContaining(['new-session', '-d', '-s', 'orc-bob']), ...)`
- `expect(mocks.execFileSync).toHaveBeenCalledWith('tmux', ['set-option', '-t', 'orc-bob', 'remain-on-exit', 'on'], ...)`
- For send-keys: `expect(mocks.execFileSync).toHaveBeenCalledWith('tmux', expect.arrayContaining(['send-keys', '-t', 'orc-bob', 'Enter']), ...)`

### Step 3 — `send()`, `heartbeatProbe()`, `ownsSession()` tests

**File:** `adapters/tmux.test.ts`

```ts
describe('tmux adapter send()', () => {
  it('calls send-keys, Escape, Enter, and resize for SIGWINCH', async () => { ... });
  it('returns empty string', async () => { ... });
  it('throws on malformed session handle', async () => { ... });
});

describe('tmux adapter heartbeatProbe()', () => {
  it('returns true when has-session succeeds and pane_dead is 0', async () => {
    // mock: execFileSync returns '' for has-session, '0' for display-message
  });
  it('returns false when has-session throws', async () => { ... });
  it('returns false when pane_dead is 1', async () => { ... });
  it('never throws — returns false on malformed handle', async () => { ... });
});
```

### Step 4 — `stop()`, `attach()`, `detectInputBlock()` tests

**File:** `adapters/tmux.test.ts`

```ts
describe('tmux adapter stop()', () => {
  it('calls tmux kill-session', async () => { ... });
  it('is a no-op when kill-session throws (session absent)', async () => { ... });
  it('is safe to call twice', async () => { ... });
});

describe('tmux adapter attach()', () => {
  it('calls spawnSync tmux attach-session with stdio inherit when TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    // ...
  });
  it('prints error and does not call spawnSync when not TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    // ...
  });
});

describe('tmux adapter detectInputBlock()', () => {
  it('calls capture-pane -p -S -50 and returns matching prompt', async () => {
    // mock execFileSync to return 'Would you like to apply these changes? [y/n]' for capture-pane
  });
  it('returns null when capture-pane output has no blocking prompt', async () => { ... });
  it('returns null when capture-pane throws', async () => { ... });
});
```

### Step 5 — Factory and contract tests

**File:** `adapters/tmux.test.ts`

```ts
describe('adapter factory and contract', () => {
  it('createAdapter returns valid adapters for claude, codex, gemini', async () => { ... });
  it('createAdapter throws for unknown providers', async () => { ... });
  it('assertAdapterContract accepts a tmux adapter instance', async () => { ... });
});
```

---

## Acceptance criteria

- [ ] `adapters/tmux.test.ts` exists and all tests pass via `npx vitest run adapters/tmux`.
- [ ] No real tmux process is spawned during any test run.
- [ ] `start()` tests verify session name, env propagation, bootstrap path (codex vs. non-codex), pre-existing kill, and failure.
- [ ] `send()` tests verify chunked send-keys, ESC, Enter, SIGWINCH resize calls.
- [ ] `heartbeatProbe()` tests verify all three branches (alive, dead session, dead pane) and no-throw on malformed handle.
- [ ] `stop()` tests verify kill-session call, no-op on throw, double-stop safety.
- [ ] `attach()` tests verify both TTY and non-TTY branches.
- [ ] `detectInputBlock()` tests verify capture-pane call and pattern matching.
- [ ] Factory tests verify valid providers accepted and unknown provider throws.
- [ ] `npm test` passes with no regressions in other test files.
- [ ] No changes to files outside `adapters/tmux.test.ts`.

---

## Tests

This task IS the tests. All test descriptions are specified above.

---

## Verification

```bash
# Run only the new tmux adapter tests
npx vitest run adapters/tmux

# Full suite — must not regress
nvm use 24 && npm test
```
