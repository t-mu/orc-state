# Task 57 — Create `adapters/pty.test.mjs`

Depends on Tasks 51 (pty.mjs) and 52 (index.mjs updated). Blocks Task 58.

---

## Scope

**In scope:**
- Create `adapters/pty.test.mjs` with full coverage of all 5 adapter methods and the factory

**Out of scope:**
- `adapters/tmux.test.mjs` — deleted in Task 58; do not modify it now
- `adapters/pty.mjs` — do not modify
- E2e tests — covered in `orchestrationLifecycle.e2e.test.mjs` (already rewritten)

---

## Context

### Mocking strategy

`pty.mjs` imports `node-pty` as an ES module default import. To mock it in vitest without touching the real binary:

```js
vi.doMock('node-pty', () => ({
  default: { spawn: spawnSpy },
}));
const { createPtyAdapter } = await import('./pty.mjs');
```

Use `vi.resetModules()` before each test and dynamic `import()` after setting up mocks — identical to the pattern used in `tmux.test.mjs`.

`node:fs` functions (`writeFileSync`, `readFileSync`, `existsSync`, `unlinkSync`, `mkdirSync`, `createWriteStream`) are **not** mocked. Use a real temp directory (`mkdtempSync`) so file system assertions are straightforward and tests remain realistic.

### Mock IPty shape

```js
function makeMockPty(pid = 12345) {
  let dataCallback = null;
  const ptyProcess = {
    pid,
    write:  vi.fn(),
    kill:   vi.fn(),
    onData: vi.fn().mockImplementation((cb) => { dataCallback = cb; }),
  };
  return { ptyProcess, triggerData: (s) => dataCallback?.(s) };
}
```

### STATE_DIR override

Set `process.env.ORCH_STATE_DIR` to the temp directory before each test. The pty adapter reads `STATE_DIR` from `../lib/paths.mjs` which reads from the env var at import time — reset modules so each test gets a fresh `STATE_DIR` value.

**Affected files:**
- `adapters/pty.test.mjs` — created by this task

---

## Goals

1. Must test all 5 adapter methods with at least the cases listed below.
2. Must mock `node-pty` via `vi.doMock` — no real PTY processes spawned.
3. Must use a real temp directory for PID files and output logs — no `node:fs` mocks.
4. Must clean up temp directories in `afterEach`.
5. Must cover the cross-process `heartbeatProbe` PID-file fallback path.
6. Must cover the factory (`createAdapter` and `assertAdapterContract`).

---

## Implementation

### Create `adapters/pty.test.mjs`

```js
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), 'pty-test-'));
  process.env.ORCH_STATE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ORCH_STATE_DIR;
});

function makeMockPty(pid = 12345) {
  let dataCallback = null;
  const ptyProcess = {
    pid,
    write:  vi.fn(),
    kill:   vi.fn(),
    onData: vi.fn().mockImplementation((cb) => { dataCallback = cb; }),
  };
  return { ptyProcess, triggerData: (s) => dataCallback?.(s) };
}

async function makeAdapter({ provider = 'claude', spawnReturn } = {}) {
  const { ptyProcess, triggerData } = spawnReturn ?? makeMockPty();
  const spawnSpy = vi.fn().mockReturnValue(ptyProcess);
  vi.doMock('node-pty', () => ({ default: { spawn: spawnSpy } }));
  const { createPtyAdapter } = await import('./pty.mjs');
  return {
    adapter: createPtyAdapter({ provider }),
    spawnSpy,
    ptyProcess,
    triggerData,
  };
}

// ─── start() ───────────────────────────────────────────────────────────────

describe('pty adapter start()', () => {
  it('spawns the CLI binary and returns pty session handle and provider_ref', async () => {
    const { adapter, spawnSpy, ptyProcess } = await makeAdapter({ provider: 'claude' });
    const result = await adapter.start('bob', {});

    expect(result).toMatchObject({
      session_handle: 'pty:bob',
      provider_ref: { pid: ptyProcess.pid, provider: 'claude', binary: 'claude' },
    });
    expect(spawnSpy).toHaveBeenCalledWith('claude', [], expect.objectContaining({
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
    }));
  });

  it('writes PID file to STATE_DIR/pty-pids/{agentId}.pid', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    const pidPath = join(dir, 'pty-pids', 'bob.pid');
    expect(existsSync(pidPath)).toBe(true);
    expect(readFileSync(pidPath, 'utf8')).toBe(String(ptyProcess.pid));
  });

  it('delivers bootstrap via ptyProcess.write() when system_prompt provided', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', { system_prompt: 'BOOTSTRAP TEXT' });

    expect(ptyProcess.write).toHaveBeenCalledWith('BOOTSTRAP TEXT\n');
  });

  it('does not call write() when system_prompt is absent', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    expect(ptyProcess.write).not.toHaveBeenCalled();
  });

  it('streams PTY output to STATE_DIR/pty-logs/{agentId}.log', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('hello from pty\n');

    // Give the write stream a moment to flush
    await new Promise((r) => setTimeout(r, 20));
    const log = readFileSync(join(dir, 'pty-logs', 'bob.log'), 'utf8');
    expect(log).toContain('hello from pty');
  });

  it('uses provider binary mapping for codex and gemini', async () => {
    const codex = await makeAdapter({ provider: 'codex' });
    await codex.adapter.start('c', {});
    expect(codex.spawnSpy).toHaveBeenCalledWith('codex', [], expect.any(Object));

    vi.resetModules();
    const gemini = await makeAdapter({ provider: 'gemini' });
    await gemini.adapter.start('g', {});
    expect(gemini.spawnSpy).toHaveBeenCalledWith('gemini', [], expect.any(Object));
  });
});

// ─── send() ────────────────────────────────────────────────────────────────

describe('pty adapter send()', () => {
  it('writes text + newline to ptyProcess and returns empty string', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    const result = await adapter.send('pty:bob', 'CHECK_WORK');

    expect(result).toBe('');
    expect(ptyProcess.write).toHaveBeenLastCalledWith('CHECK_WORK\n');
  });

  it('throws when agent is not in sessions Map', async () => {
    const { adapter } = await makeAdapter();
    // Do NOT call start() — agent not in Map.
    await expect(adapter.send('pty:bob', 'text')).rejects.toThrow(/No active pty session/);
  });

  it('throws on malformed session handles', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.send('bad-handle', 'text')).rejects.toThrow(/Invalid pty session handle/);
  });
});

// ─── attach() ──────────────────────────────────────────────────────────────

describe('pty adapter attach()', () => {
  it('prints tail of output log to stdout', async () => {
    const { adapter, triggerData } = await makeAdapter();
    await adapter.start('bob', {});
    triggerData('agent output line\n');
    await new Promise((r) => setTimeout(r, 20));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    adapter.attach('pty:bob');

    expect(logSpy).toHaveBeenCalled();
    const printed = logSpy.mock.calls.flat().join('\n');
    expect(printed).toContain('agent output line');
  });

  it('prints fallback message when no log file exists — does not throw', async () => {
    const { adapter } = await makeAdapter();
    // Do NOT call start() — no log file created.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => adapter.attach('pty:nobody')).not.toThrow();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no output log'));
  });
});

// ─── heartbeatProbe() ──────────────────────────────────────────────────────

describe('pty adapter heartbeatProbe()', () => {
  it('returns true when process is alive (in-Map path)', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    // Stub process.kill to not throw (simulates alive process)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});
    await expect(adapter.heartbeatProbe('pty:bob')).resolves.toBe(true);
    expect(killSpy).toHaveBeenCalledWith(ptyProcess.pid, 0);
  });

  it('returns false when in-Map process is dead', async () => {
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {});

    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
    await expect(adapter.heartbeatProbe('pty:bob')).resolves.toBe(false);
  });

  it('returns true via PID file fallback when agent not in Map (cross-process)', async () => {
    // Write PID file manually — simulate coordinator having created session
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {}); // writes PID file

    // Create fresh adapter (empty sessions Map)
    vi.resetModules();
    const fresh = await makeAdapter();

    vi.spyOn(process, 'kill').mockImplementation(() => {});
    await expect(fresh.adapter.heartbeatProbe('pty:bob')).resolves.toBe(true);
  });

  it('returns false when PID file absent and not in Map', async () => {
    const { adapter } = await makeAdapter();
    // No start() call — no PID file
    await expect(adapter.heartbeatProbe('pty:nobody')).resolves.toBe(false);
  });

  it('never throws — returns false on malformed handle', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.heartbeatProbe('invalid')).resolves.toBe(false);
  });
});

// ─── stop() ────────────────────────────────────────────────────────────────

describe('pty adapter stop()', () => {
  it('kills the PTY process and removes PID file', async () => {
    const { adapter, ptyProcess } = await makeAdapter();
    await adapter.start('bob', {});

    const pidPath = join(dir, 'pty-pids', 'bob.pid');
    expect(existsSync(pidPath)).toBe(true);

    await adapter.stop('pty:bob');

    expect(ptyProcess.kill).toHaveBeenCalled();
    expect(existsSync(pidPath)).toBe(false);
  });

  it('is a no-op when agent not found — does not throw', async () => {
    const { adapter } = await makeAdapter();
    await expect(adapter.stop('pty:nobody')).resolves.toBeUndefined();
  });

  it('is safe to call twice (double-stop)', async () => {
    const { adapter } = await makeAdapter();
    await adapter.start('bob', {});
    await adapter.stop('pty:bob');
    await expect(adapter.stop('pty:bob')).resolves.toBeUndefined();
  });
});

// ─── Factory and contract ───────────────────────────────────────────────────

describe('adapter factory and contract', () => {
  it('createAdapter returns valid adapters for known providers', async () => {
    vi.doMock('node-pty', () => ({ default: { spawn: vi.fn().mockReturnValue(makeMockPty().ptyProcess) } }));
    const { createAdapter, assertAdapterContract } = await import('./index.mjs');

    expect(() => assertAdapterContract(createAdapter('claude'))).not.toThrow();
    expect(() => assertAdapterContract(createAdapter('codex'))).not.toThrow();
    expect(() => assertAdapterContract(createAdapter('gemini'))).not.toThrow();
  });

  it('createAdapter throws for unknown providers', async () => {
    vi.doMock('node-pty', () => ({ default: { spawn: vi.fn() } }));
    const { createAdapter } = await import('./index.mjs');
    expect(() => createAdapter('unknown')).toThrow(/Unknown provider/);
  });

  it('assertAdapterContract accepts a pty adapter instance', async () => {
    vi.doMock('node-pty', () => ({ default: { spawn: vi.fn().mockReturnValue(makeMockPty().ptyProcess) } }));
    const { createPtyAdapter } = await import('./pty.mjs');
    const { assertAdapterContract } = await import('./interface.mjs');
    const adapter = createPtyAdapter({ provider: 'claude' });
    expect(() => assertAdapterContract(adapter)).not.toThrow();
  });
});
```

---

## Acceptance criteria

- [ ] All tests pass: `npm run test:orc:unit`.
- [ ] `start()` tests: spawn args verified, PID file written, bootstrap delivered, output streamed to log.
- [ ] `send()` tests: write called with `text + '\n'`, returns `''`, throws when not in Map.
- [ ] `attach()` tests: reads log file, fallback on missing file, no throw.
- [ ] `heartbeatProbe()` tests: in-Map alive, in-Map dead, PID file fallback, no PID file → false.
- [ ] `stop()` tests: kills process, deletes PID file, no-op on double-stop.
- [ ] Factory tests: contract check, binary mapping, unknown provider throws.
- [ ] No real PTY processes are spawned during the test run.

---

## Tests

This task IS the tests.

---

## Verification

```bash
nvm use 24 && npm run test:orc:unit -- --reporter=verbose
# Expected: all tests in pty.test.mjs pass
```
