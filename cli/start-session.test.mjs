import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir }        from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync }     from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const coordinatorScriptPath = resolve(import.meta.dirname, '..', 'coordinator.mjs');
let dir;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../lib/prompts.mjs');
  vi.doUnmock('../lib/binaryCheck.mjs');
  vi.doUnmock('../lib/templateRender.mjs');
  vi.doUnmock('node:child_process');
  vi.doUnmock('node-pty');
  dir = mkdtempSync(join(tmpdir(), 'orch-start-session-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('node-pty');
  vi.doUnmock('node:child_process');
  delete process.env.ORCH_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function seedState(agents = []) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1', epics: [{ ref: 'project', title: 'Project', tasks: [] }],
  }));
  writeFileSync(join(dir, 'agents.json'),  JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'),  JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function masterAgent(overrides = {}) {
  return {
    agent_id:             'master',
    provider:             'claude',
    role:                 'master',
    status:               'idle',
    session_handle:       null,
    provider_ref:         null,
    capabilities:         [],
    model:                null,
    dispatch_mode:        null,
    registered_at:        '2026-01-01T00:00:00Z',
    last_heartbeat_at:    null,
    last_status_change_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

function setEnv(stateDir) {
  process.env.ORCH_STATE_DIR = stateDir;
}

function mockBinaryCheck(ok = true) {
  vi.doMock('../lib/binaryCheck.mjs', () => ({
    checkAndInstallBinary: vi.fn().mockResolvedValue(ok),
    PROVIDER_BINARIES: { claude: 'claude', codex: 'codex', gemini: 'gemini' },
    PROVIDER_PROMPT_PATTERNS: { claude: />\s*$/, codex: />\s*$/, gemini: />\s*$/ },
    PROVIDER_SUBMIT_SEQUENCES: { claude: '\r', codex: '\r', gemini: '\r' },
  }));
}

function makeSpawnMock({ writeCoordinatorPid = false, providerSpawnError = null, providerCloseCode = 0 } = {}) {
  return vi.fn().mockImplementation((execPath, args) => {
    const target = Array.isArray(args) ? String(args[0] ?? '') : '';
    if (target.endsWith('coordinator.mjs')) {
      if (writeCoordinatorPid) {
        writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 99999, started_at: '2026-01-01T00:00:00.000Z' }));
      }
      return { unref: vi.fn(), on: vi.fn() };
    }

    // Master foreground provider spawn via mocked node-pty
    if (providerSpawnError) throw providerSpawnError;

    let dataCallback = null;
    return {
      pid: 12345,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn().mockImplementation((cb) => { dataCallback = cb; }),
      onExit: vi.fn().mockImplementation((cb) => {
        cb({ exitCode: providerCloseCode, signal: 0 });
      }),
      _emitData: (chunk) => dataCallback?.(chunk),
      on: vi.fn(),
      unref: vi.fn(),
    };
  });
}

function mockProcessExit() {
  return vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${String(code)}`);
  });
}

function mockSpawn(spawnMock = makeSpawnMock(), spawnSyncMock = null) {
  const resolvedSpawnSyncMock = spawnSyncMock
    ?? vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual('node:child_process');
    return {
      ...actual,
      spawn: spawnMock,
      spawnSync: resolvedSpawnSyncMock,
    };
  });
  vi.doMock('node-pty', () => ({ default: { spawn: spawnMock } }));
  return spawnMock;
}

// Writes a coordinator.pid whose stored PID is the current process — guaranteed alive.
function seedCoordinatorRunning() {
  writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: process.pid, started_at: '2026-01-01T00:00:00.000Z' }));
}

// ── spawnSync tests (no adapter needed) ────────────────────────────────────

describe('cli/start-session.mjs', () => {
  describe('state auto-init', () => {
    it('creates all four state files when the state dir is absent', () => {
      const freshDir = join(dir, 'fresh-state');
      // freshDir does not exist yet
      spawnSync('node', ['cli/start-session.mjs'], {
        cwd:      repoRoot,
        env:      { ...process.env, ORCH_STATE_DIR: freshDir },
        encoding: 'utf8',
      });
      expect(existsSync(join(freshDir, 'backlog.json'))).toBe(true);
      expect(existsSync(join(freshDir, 'agents.json'))).toBe(true);
      expect(existsSync(join(freshDir, 'claims.json'))).toBe(true);
      expect(existsSync(join(freshDir, 'events.jsonl'))).toBe(true);
    });

    it('does not overwrite existing state files', () => {
      seedState();
      // Write a sentinel value into backlog to detect overwrites
      const sentinel = { version: '1', epics: [{ ref: 'sentinel', title: 'Sentinel', tasks: [] }] };
      writeFileSync(join(dir, 'backlog.json'), JSON.stringify(sentinel));

      spawnSync('node', ['cli/start-session.mjs'], {
        cwd:      repoRoot,
        env:      { ...process.env, ORCH_STATE_DIR: dir },
        encoding: 'utf8',
      });

      const backlog = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
      expect(backlog.epics[0].ref).toBe('sentinel');
    });
  });

  describe('non-interactive error handling', () => {
    it('exits 1 with an error when no master exists and no --provider flag', () => {
      seedState(); // no agents
      const result = spawnSync('node', ['cli/start-session.mjs'], {
        cwd:      repoRoot,
        env:      { ...process.env, ORCH_STATE_DIR: dir },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('provider');
    });

    it('rejects deprecated worker startup flags with migration guidance', () => {
      seedState([masterAgent()]);
      const result = spawnSync('node', ['cli/start-session.mjs', '--worker-id=orc-9', '--worker-provider=codex'], {
        cwd: repoRoot,
        env: { ...process.env, ORCH_STATE_DIR: dir },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--worker-id');
      expect(result.stderr).toContain('master-only');
      expect(result.stderr).toContain('ORC_MAX_WORKERS');
    });

    it('reuses existing master when already registered (non-interactive)', async () => {
      seedState([masterAgent()]);
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      const promptCreateWorkerAction = vi.fn().mockResolvedValue('skip');
      vi.doMock('../lib/prompts.mjs', () => ({
        promptAgentId: vi.fn().mockResolvedValue('master'),
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(false),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue('clear_all'),
        promptCreateWorkerAction,
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(spawnMock).toHaveBeenCalled();
      expect(readAgents()).toHaveLength(1);
      expect(readAgents()[0].agent_id).toBe('master');
      expect(promptCreateWorkerAction).not.toHaveBeenCalled();
    });
  });

  // ── vi.doMock + dynamic import tests ──────────────────────────────────────

  describe('master registration', () => {
    it('registers a master agent when none is found', async () => {
      seedState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning(); // skip coordinator step
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      const agents = readAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].role).toBe('master');
      expect(agents[0].provider).toBe('claude');
      expect(spawnMock).toHaveBeenCalled();
    });

    it('registers missing master with fixed id without prompting master agent id', async () => {
      seedState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptAgentId: vi.fn().mockRejectedValue(new Error('master-id prompt should not be called')),
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
        promptMasterAction: vi.fn().mockResolvedValue('register'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      const agents = readAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agent_id).toBe('master');
      expect(agents[0].role).toBe('master');
    });

    it('does not register a second master when one already exists (conflict gate cancels)', async () => {
      seedState([masterAgent({ status: 'running' })]);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptAgentId:               vi.fn().mockResolvedValue('master'),
        promptProvider:              vi.fn().mockResolvedValue('claude'),
        isInteractive:               vi.fn().mockReturnValue(true), // interactive so cancel → exit 0
        promptCoordinatorAction:      vi.fn().mockResolvedValue('reuse'),
        promptMasterAction:           vi.fn().mockResolvedValue('cancel'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue('clear_all'),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
        promptRole:                  vi.fn().mockResolvedValue('worker'),
        promptCapabilities:          vi.fn().mockResolvedValue(''),
      }));
      mockSpawn();
      mockBinaryCheck(true);
      mockProcessExit();

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await expect(import('./start-session.mjs')).rejects.toThrow('process.exit:0');

      // Agents unchanged — conflict gate fired and exited (no second registration)
      expect(readAgents()).toHaveLength(1);
    });
  });

  describe('conflict gate', () => {
    it('replace removes old master and continues to fresh registration', async () => {
      seedState([masterAgent()]);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptAgentId:               vi.fn().mockResolvedValue('master2'),
        promptProvider:              vi.fn().mockResolvedValue('codex'),
        isInteractive:               vi.fn().mockReturnValue(true),
        promptCoordinatorAction:      vi.fn().mockResolvedValue('reuse'),
        promptMasterAction:           vi.fn().mockResolvedValue('replace'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue('clear_all'),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
        promptRole:                  vi.fn().mockResolvedValue('worker'),
        promptCapabilities:          vi.fn().mockResolvedValue(''),
      }));
      mockSpawn();
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs', '--provider=codex', '--agent-id=master2'];
      await import('./start-session.mjs');

      const agents = readAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agent_id).toBe('master2');
      expect(agents[0].provider).toBe('codex');
    });

    it('reuse exits without state change and starts coordinator if needed', async () => {
      seedState([masterAgent()]);
      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptAgentId:               vi.fn().mockResolvedValue('master'),
        promptProvider:              vi.fn().mockResolvedValue('claude'),
        isInteractive:               vi.fn().mockReturnValue(true),
        promptCoordinatorAction:      vi.fn().mockResolvedValue('reuse'),
        promptMasterAction:           vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue(''),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
        promptRole:                  vi.fn().mockResolvedValue('worker'),
        promptCapabilities:          vi.fn().mockResolvedValue(''),
      }));
      mockBinaryCheck(true);
      setEnv(dir);
      // No coordinator.pid → coordinator not running
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(true);
      expect(readAgents()).toHaveLength(1);       // no state change
    });

    it('does not modify existing worker registrations during normal startup', async () => {
      seedState([
        masterAgent({ agent_id: 'master' }),
        masterAgent({ agent_id: 'worker-01', role: 'worker', provider: 'codex' }),
      ]);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptAgentId: vi.fn().mockResolvedValue('master'),
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));
      mockSpawn();
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      const agents = readAgents();
      expect(agents).toHaveLength(2);
      expect(agents.some((a) => a.agent_id === 'worker-01' && a.role === 'worker')).toBe(true);
    });

    it('terminates running coordinator when chosen, then restarts it', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 999999, started_at: '2026-01-01T00:00:00.000Z' }));

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptAgentId:               vi.fn().mockResolvedValue('master'),
        promptProvider:              vi.fn().mockResolvedValue('claude'),
        isInteractive:               vi.fn().mockReturnValue(true),
        promptCoordinatorAction:      vi.fn().mockResolvedValue('terminate'),
        promptMasterAction:           vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue(''),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
        promptRole:                  vi.fn().mockResolvedValue('worker'),
        promptCapabilities:          vi.fn().mockResolvedValue(''),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(true);
      const { pid } = JSON.parse(readFileSync(join(dir, 'coordinator.pid'), 'utf8'));
      expect(pid).toBe(99999);
    });
  });

  describe('coordinator', () => {
    it('spawns coordinator when coordinator.pid is absent', async () => {
      seedState(); // no existing master
      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      // No coordinator.pid seeded
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      const coordinatorCall = spawnMock.mock.calls.find(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'));
      expect(coordinatorCall).toBeTruthy();
      const [execPath, args] = coordinatorCall;
      expect(args[0]).toMatch(/coordinator\.mjs$/);
      expect(execPath).toBe(process.execPath);
    });

    it('skips spawning coordinator when it is already running', async () => {
      seedState(); // no existing master

      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning(); // PID is current process → alive
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      // Coordinator path should not spawn when already running; master foreground spawn still happens.
      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(false);
    });

    it('treats invalid pid-file pid as not running and spawns coordinator', async () => {
      seedState();
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: -1 }));

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(true);
    });

    it('treats malformed coordinator.pid json as not running and spawns coordinator', async () => {
      seedState();
      writeFileSync(join(dir, 'coordinator.pid'), '{bad-json');

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(true);
    });

    it('treats pid as not running when ps probe fails and spawns coordinator', async () => {
      seedState();
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: process.pid, started_at: '2026-01-01T00:00:00.000Z' }));

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 1, stdout: '' });
      mockSpawn(spawnMock, spawnSyncMock);
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(true);
    });
  });

  describe('coordinator terminate safety', () => {
    it('does not remove coordinator.pid when terminate does not stop the process', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345, started_at: '2026-01-01T00:00:00.000Z' }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && (signal === 0 || signal === 'SIGTERM')) return true;
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(false);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    });

    it('keeps coordinator pid file when status probe returns EPERM', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345, started_at: '2026-01-01T00:00:00.000Z' }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && signal === 0) {
          const err = new Error('EPERM');
          err.code = 'EPERM';
          throw err;
        }
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
      expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(spawnMock.mock.calls.some(([, args]) => String(args?.[0] ?? '').endsWith('coordinator.mjs'))).toBe(false);
    });

    it('refuses terminate when coordinator.pid is missing started_at', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345 }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && signal === 0) return true;
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
    });

    it('refuses terminate when pid command is not coordinator', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345, started_at: '2026-01-01T00:00:00.000Z' }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && signal === 0) return true;
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: 'node unrelated-worker.mjs' });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.mjs', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
    });
  });

  describe('next-step hints', () => {
    it('prints next-step hints to stdout', async () => {
      seedState(); // no existing master
      mockSpawn();
      mockBinaryCheck(true);

      const lines = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      const out = lines.join('\n');
      expect(out).toContain('This terminal is the MASTER session.');
      expect(out).toContain('MASTER:  foreground planner/delegator in this terminal');
      expect(out).toContain('MANAGED WORKERS');
      expect(out).toContain('WORKERS: coordinator-managed background capacity launched per task');
      expect(out).toContain('orc-delegate');
      expect(out).toContain('Debug worker tools');
      expect(out).toContain('orc-status');
    });
  });

  describe('prompt order', () => {
    it('runs prompts in coordinator -> master order', async () => {
      seedState([masterAgent({ agent_id: 'master', provider: 'claude' })]);
      const order = [];
      vi.doMock('../lib/prompts.mjs', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockImplementation(async () => {
          order.push('coordinator');
          return 'reuse';
        }),
        promptMasterAction: vi.fn().mockImplementation(async () => {
          order.push('master');
          return 'reuse';
        }),
        printManagedWorkerNotice: vi.fn(),
        promptRole: vi.fn().mockResolvedValue('worker'),
        promptCapabilities: vi.fn().mockResolvedValue(''),
      }));
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(order).toEqual(['coordinator', 'master']);
    });
  });

  describe('master foreground session', () => {
    it('spawns claude provider with --mcp-config and stdio inherit', async () => {
      seedState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      const providerCall = spawnMock.mock.calls.find(([cmd]) => cmd === 'claude');
      expect(providerCall).toBeTruthy();
      expect(providerCall[1]).toContain('--mcp-config');
      expect(providerCall[1]).toContain('--system-prompt');
      const promptIndex = providerCall[1].indexOf('--system-prompt');
      const bootstrapText = providerCall[1][promptIndex + 1];
      expect(bootstrapText).toContain('MASTER_BOOTSTRAP v2');
      expect(bootstrapText).toContain('agent_id: master');
      expect(bootstrapText).toContain('provider: claude');
      expect(bootstrapText).not.toContain('{{agent_id}}');
      expect(providerCall[1].some((arg) => String(arg).includes('mcp-config.json'))).toBe(true);
      expect(providerCall[2]).toEqual(expect.objectContaining({
        name: 'xterm-256color',
      }));
    });

    it('marks master offline after foreground session exits', async () => {
      seedState();
      mockSpawn();
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await import('./start-session.mjs');

      const master = readAgents().find((a) => a.agent_id === 'master');
      expect(master.status).toBe('offline');
      expect(master.session_handle).toBeNull();
    });

    it('exits 1 when binary check fails', async () => {
      seedState();
      mockSpawn();
      mockBinaryCheck(false);
      const exitSpy = mockProcessExit();

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.mjs')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits 1 when master provider CLI spawn fails', async () => {
      seedState();
      mockSpawn(makeSpawnMock({ providerSpawnError: new Error('ENOENT: spawn claude') }));
      mockBinaryCheck(true);
      const exitSpy = mockProcessExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.mjs')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to start master provider CLI'));
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).not.toContain('Master session ended.');
    });

    it('exits 1 when master provider CLI exits non-zero', async () => {
      seedState();
      mockSpawn(makeSpawnMock({ providerCloseCode: 2 }));
      mockBinaryCheck(true);
      const exitSpy = mockProcessExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.mjs')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('exited with code 2'));
    });

    it('exits 1 when master session preparation fails before provider spawn', async () => {
      seedState([masterAgent()]);
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);
      vi.doMock('../lib/templateRender.mjs', () => ({
        renderTemplate: vi.fn(() => {
          throw new Error('template render failed');
        }),
      }));
      const exitSpy = mockProcessExit();

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await expect(import('./start-session.mjs')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      const master = readAgents().find((a) => a.agent_id === 'master');
      expect(master.status).toBe('offline');
    });
  });

  describe('MCP config integration', () => {
    it('writes mcp-config.json when provider is claude', async () => {
      seedState([masterAgent({ provider: 'claude' })]);
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      const configPath = join(dir, 'mcp-config.json');
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config.mcpServers?.orchestrator).toBeTruthy();
      expect(config.mcpServers.orchestrator.command).toBe(process.execPath);
      expect(config.mcpServers.orchestrator.args[0].endsWith(join('mcp', 'server.mjs'))).toBe(true);
      expect(config.mcpServers.orchestrator.env.ORCH_STATE_DIR).toBe(dir);
    });

    it('does not write mcp-config.json and spawns codex without mcp flag', async () => {
      seedState([masterAgent({ provider: 'codex' })]);
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(existsSync(join(dir, 'mcp-config.json'))).toBe(false);
      const providerCall = spawnMock.mock.calls.find(([cmd]) => cmd === 'codex');
      expect(providerCall).toBeTruthy();
      expect(providerCall[1]).not.toContain('--mcp-config');
    });

    it('writes mcp-config.json and spawns gemini with mcp and system-instruction flags', async () => {
      seedState([masterAgent({ provider: 'gemini' })]);
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');

      expect(existsSync(join(dir, 'mcp-config.json'))).toBe(true);
      const providerCall = spawnMock.mock.calls.find(([cmd]) => cmd === 'gemini');
      expect(providerCall).toBeTruthy();
      expect(providerCall[1]).toContain('--mcp-config');
      expect(providerCall[1]).toContain('--system-instruction');
    });

    it('writes mcp-config before claude spawn', async () => {
      seedState([masterAgent({ provider: 'claude' })]);
      const spawnMock = vi.fn().mockImplementation((cmd, args) => {
        if (String(args?.[0] ?? '').endsWith('coordinator.mjs')) {
          return { unref: vi.fn(), on: vi.fn() };
        }
        if (cmd === 'claude') {
          const idx = args.indexOf('--mcp-config');
          const configPath = args[idx + 1];
          expect(existsSync(configPath)).toBe(true);
        }
        return {
          pid: 12345,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          onData: vi.fn(),
          onExit: vi.fn().mockImplementation((cb) => cb({ exitCode: 0, signal: 0 })),
          on: vi.fn(),
          unref: vi.fn(),
        };
      });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      const lines = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');
      expect(spawnMock).toHaveBeenCalled();
    });

    it('prints mcp hint for claude and not for codex', async () => {
      seedState([masterAgent({ provider: 'claude' })]);
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);
      const lines = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => lines.push(args.join(' ')));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');
      expect(lines.join('\n')).toContain('MCP server: orchestrator tools available');
      expect(lines.join('\n')).toContain('Master bootstrap loaded via --system-prompt.');
      expect(lines.join('\n')).toContain('MASTER_BOOTSTRAP v2');

      // fresh state for codex branch
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), 'orch-start-session-test-'));
      seedState([masterAgent({ provider: 'codex' })]);
      const spawnMockCodex = makeSpawnMock();
      vi.resetModules();
      mockSpawn(spawnMockCodex);
      mockBinaryCheck(true);
      const codexLines = [];
      vi.spyOn(console, 'log').mockImplementation((...args) => codexLines.push(args.join(' ')));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.mjs'];
      await import('./start-session.mjs');
      expect(codexLines.join('\n')).not.toContain('MCP server: orchestrator tools available');
    });
  });
});
