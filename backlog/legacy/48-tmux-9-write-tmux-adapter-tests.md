# Task 48 — Write tmux Adapter Tests (`adapters/tmux.test.mjs`)

Depends on Tasks 40, 41, 42. Final task in the series.

---

## Scope

**In scope:**
- Create `adapters/tmux.test.mjs`
- Test all 5 adapter methods: `start`, `send`, `heartbeatProbe`, `attach`, `stop`
- Test `createAdapter()` factory wires through to tmux adapter
- Test `assertAdapterContract()` accepts the tmux adapter

**Out of scope:**
- Integration tests (no real tmux process spawned)
- Tests for run-reporting commands (covered in Task 43's test file)
- No changes to the adapter implementation itself

---

## Context

### Mock strategy

All tmux calls go through `execFileSync` from `node:child_process`. Mock this module with
`vi.doMock('node:child_process', ...)` before importing the adapter. Use
`vi.resetModules()` + `vi.doMock()` + dynamic `import()` pattern (same as
`start-session.test.mjs` and `start-worker-session.test.mjs`).

```js
// Pattern from existing tests:
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

it('...', async () => {
  const execSpy = vi.fn().mockReturnValue('');
  vi.doMock('node:child_process', () => ({ execFileSync: execSpy }));
  const { createTmuxAdapter } = await import('../adapters/tmux.mjs');
  const adapter = createTmuxAdapter({ provider: 'claude', tmuxSession: 'test' });
  // ... test
});
```

### Key behaviours to test

**`start(agentId, config)`:**
- Calls `tmux new-window -t {session} -n {agentId}`
- Calls `tmux send-keys -t {session}:{agentId} {binary} Enter`
- Calls `tmux send-keys -t {target} {system_prompt} Enter` when system_prompt is provided
- Returns `{ session_handle: 'tmux:test:bob', provider_ref: { tmux_session, window_name, provider, binary } }`
- Session handle format: `tmux:{session}:{agentId}`

**`send(sessionHandle, text)`:**
- Calls `tmux send-keys -t {session}:{agentId} {text} Enter`
- Returns `''`
- Throws when sessionHandle is malformed

**`heartbeatProbe(sessionHandle)`:**
- Returns `true` when `tmux list-panes` succeeds (exit 0)
- Returns `false` (does NOT throw) when `tmux list-panes` throws (pane dead)
- Returns `false` when sessionHandle is malformed

**`attach(sessionHandle)`:**
- Calls `tmux capture-pane -p -t {target}`
- Prints captured output to stdout via `console.log`
- Prints `'(could not capture pane output)'` when tmux throws (does NOT throw itself)

**`stop(sessionHandle)`:**
- Calls `tmux kill-window -t {target}`
- Does NOT throw when `kill-window` fails (window already gone)

**`createAdapter()` factory:**
- `createAdapter('claude')` → passes `provider: 'claude'` to tmux adapter
- `createAdapter('codex')` → passes `provider: 'codex'`
- `createAdapter('unknown')` → throws "Unknown provider"

**`assertAdapterContract()`:**
- Passes for the tmux adapter instance

**`ORCH_TMUX_SESSION` env var:**
- When set, the adapter uses it as the session name
- When unset, defaults to `'orc'`

**Affected files:**
- `adapters/tmux.test.mjs` — created by this task

---

## Goals

1. Must cover all 5 adapter methods with at least 2 tests each
2. Must verify `heartbeatProbe` returns `false` and does not throw when tmux fails
3. Must verify `stop` is a no-op (does not throw) when window not found
4. Must verify `send` returns `''`
5. Must verify session handle format `tmux:{session}:{agentId}`
6. Must verify `ORCH_TMUX_SESSION` env var is respected
7. `nvm use 22 && npm run test:orc:unit` must pass with all new tests included

---

## Implementation

### Step 1 — Create `adapters/tmux.test.mjs`

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function makeAdapter({ provider = 'claude', tmuxSession = 'test', execSpy } = {}) {
  const spy = execSpy ?? vi.fn().mockReturnValue('');
  vi.doMock('node:child_process', () => ({ execFileSync: spy }));
  const { createTmuxAdapter } = await import('./tmux.mjs');
  const adapter = createTmuxAdapter({ provider, tmuxSession });
  return { adapter, spy };
}

// ── start() ────────────────────────────────────────────────────────────────

describe('start()', () => {
  it('creates a new tmux window and returns correct session handle', async () => {
    const { adapter, spy } = await makeAdapter();
    const result = await adapter.start('bob', {});

    expect(result.session_handle).toBe('tmux:test:bob');
    expect(result.provider_ref.tmux_session).toBe('test');
    expect(result.provider_ref.window_name).toBe('bob');
    expect(spy).toHaveBeenCalledWith('tmux', ['new-window', '-t', 'test', '-n', 'bob'], expect.anything());
  });

  it('launches the correct CLI binary for the provider', async () => {
    const { adapter, spy } = await makeAdapter({ provider: 'codex' });
    await adapter.start('worker', {});

    const sendKeysCalls = spy.mock.calls.filter(([, args]) => args[0] === 'send-keys');
    expect(sendKeysCalls.some(([, args]) => args.includes('codex'))).toBe(true);
  });

  it('sends system_prompt into the pane when provided', async () => {
    const { adapter, spy } = await makeAdapter();
    await adapter.start('bob', { system_prompt: 'BOOTSTRAP TEXT' });

    const sendKeysCalls = spy.mock.calls.filter(([, args]) => args[0] === 'send-keys');
    expect(sendKeysCalls.some(([, args]) => args.includes('BOOTSTRAP TEXT'))).toBe(true);
  });

  it('skips sending system_prompt when not provided', async () => {
    const { adapter, spy } = await makeAdapter();
    await adapter.start('bob', {});
    // Only binary send-keys call, no bootstrap call
    const sendKeysCalls = spy.mock.calls.filter(([, args]) => args[0] === 'send-keys');
    expect(sendKeysCalls).toHaveLength(1); // just the binary launch
  });
});

// ── send() ─────────────────────────────────────────────────────────────────

describe('send()', () => {
  it('sends text to the correct tmux target and returns empty string', async () => {
    const { adapter, spy } = await makeAdapter();
    const result = await adapter.send('tmux:test:bob', 'CHECK_WORK');

    expect(result).toBe('');
    expect(spy).toHaveBeenCalledWith(
      'tmux',
      ['send-keys', '-t', 'test:bob', 'CHECK_WORK', 'Enter'],
      expect.anything(),
    );
  });

  it('throws when session handle is malformed', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.send('invalid-handle', 'text')).rejects.toThrow('Invalid tmux session handle');
  });
});

// ── heartbeatProbe() ───────────────────────────────────────────────────────

describe('heartbeatProbe()', () => {
  it('returns true when tmux list-panes succeeds', async () => {
    const { adapter, spy } = await makeAdapter();
    spy.mockReturnValue('');
    const result = await adapter.heartbeatProbe('tmux:test:bob');
    expect(result).toBe(true);
  });

  it('returns false (does not throw) when tmux list-panes fails', async () => {
    const spy = vi.fn().mockImplementation(() => { throw new Error('tmux: no such window'); });
    const { adapter } = await makeAdapter({ execSpy: spy });
    const result = await adapter.heartbeatProbe('tmux:test:bob');
    expect(result).toBe(false);
  });

  it('returns false for a malformed session handle', async () => {
    const { adapter } = await makeAdapter();
    const result = await adapter.heartbeatProbe('not-a-tmux-handle');
    expect(result).toBe(false);
  });
});

// ── attach() ───────────────────────────────────────────────────────────────

describe('attach()', () => {
  it('captures pane output and prints it to stdout', async () => {
    const spy = vi.fn().mockReturnValue('some terminal output');
    const { adapter } = await makeAdapter({ execSpy: spy });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    adapter.attach('tmux:test:bob');

    expect(spy).toHaveBeenCalledWith('tmux', ['capture-pane', '-p', '-t', 'test:bob'], expect.anything());
    expect(logSpy).toHaveBeenCalledWith('some terminal output');
  });

  it('prints fallback message and does not throw when capture fails', async () => {
    const spy = vi.fn().mockImplementation(() => { throw new Error('no pane'); });
    const { adapter } = await makeAdapter({ execSpy: spy });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => adapter.attach('tmux:test:bob')).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith('(could not capture pane output)');
  });
});

// ── stop() ─────────────────────────────────────────────────────────────────

describe('stop()', () => {
  it('kills the tmux window', async () => {
    const { adapter, spy } = await makeAdapter();
    await adapter.stop('tmux:test:bob');
    expect(spy).toHaveBeenCalledWith('tmux', ['kill-window', '-t', 'test:bob'], expect.anything());
  });

  it('does not throw when window does not exist', async () => {
    const spy = vi.fn().mockImplementation(() => { throw new Error('no window'); });
    const { adapter } = await makeAdapter({ execSpy: spy });
    await expect(adapter.stop('tmux:test:bob')).resolves.not.toThrow();
  });
});

// ── ORCH_TMUX_SESSION env var ──────────────────────────────────────────────

describe('ORCH_TMUX_SESSION', () => {
  it('uses env var as session name when tmuxSession option is not set', async () => {
    process.env.ORCH_TMUX_SESSION = 'my-session';
    const spy = vi.fn().mockReturnValue('');
    vi.doMock('node:child_process', () => ({ execFileSync: spy }));
    const { createTmuxAdapter } = await import('./tmux.mjs');
    const adapter = createTmuxAdapter({ provider: 'claude' }); // no tmuxSession override
    const result = await adapter.start('bob', {});
    expect(result.session_handle).toBe('tmux:my-session:bob');
    delete process.env.ORCH_TMUX_SESSION;
  });

  it('defaults to "orc" when ORCH_TMUX_SESSION is unset', async () => {
    delete process.env.ORCH_TMUX_SESSION;
    const spy = vi.fn().mockReturnValue('');
    vi.doMock('node:child_process', () => ({ execFileSync: spy }));
    const { createTmuxAdapter } = await import('./tmux.mjs');
    const adapter = createTmuxAdapter({ provider: 'claude' });
    const result = await adapter.start('bob', {});
    expect(result.session_handle).toBe('tmux:orc:bob');
  });
});

// ── createAdapter factory ──────────────────────────────────────────────────

describe('createAdapter()', () => {
  it('returns a valid adapter for claude', async () => {
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn().mockReturnValue('') }));
    const { createAdapter, assertAdapterContract } = await import('./index.mjs');
    const adapter = createAdapter('claude');
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('returns a valid adapter for codex', async () => {
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn().mockReturnValue('') }));
    const { createAdapter, assertAdapterContract } = await import('./index.mjs');
    const adapter = createAdapter('codex');
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });

  it('throws for unknown provider', async () => {
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn().mockReturnValue('') }));
    const { createAdapter } = await import('./index.mjs');
    expect(() => createAdapter('unknown')).toThrow('Unknown provider');
  });
});
```

---

## Acceptance criteria

- [ ] All tests in `tmux.test.mjs` pass
- [ ] `heartbeatProbe` returns `false` and does not throw when tmux fails — verified by test
- [ ] `stop` does not throw when window not found — verified by test
- [ ] `send` returns `''` — verified by test
- [ ] `attach` prints fallback and does not throw when capture fails — verified by test
- [ ] `createAdapter('unknown')` throws — verified by test
- [ ] `assertAdapterContract` accepts the tmux adapter — verified by test
- [ ] `nvm use 22 && npm run test:orc:unit` passes (all 9+ new tests + all existing tests)

---

## Verification

```bash
cd orchestrator && nvm use 22 && npm run test:orc:unit -- --reporter=verbose 2>&1 | grep -E 'tmux|PASS|FAIL'
# Expected: all tmux.test.mjs tests show ✓
```
