import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  bridgeProjectEnv, createTempStateDir, cleanupTempStateDir, readBacklog, seedProjectTasks, seedState as seedProjectState,
} from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { readProcessStart } from '../lib/processIdentity.ts';
import { startFakeCoordinator, type FakeCoordinator } from '../test-fixtures/fakeCoordinator.ts';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const coordinatorScriptPath = resolve(import.meta.dirname, '..', 'coordinator.ts');
const originalCwd = process.cwd();
const originalPwd = process.env.PWD;
let dir: string;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../lib/agentRegistry.ts');
  vi.doUnmock('../lib/prompts.ts');
  vi.doUnmock('../lib/binaryCheck.ts');
  vi.doUnmock('../lib/templateRender.ts');
  vi.doUnmock('node:child_process');
  vi.doUnmock('../adapters/tmux.ts');
  dir = createTempStateDir('orch-start-session-test-');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('../lib/agentRegistry.ts');
  vi.doUnmock('../adapters/tmux.ts');
  vi.doUnmock('node:child_process');
  ttyRestore?.();
  ttyRestore = null;
  delete process.env.TMUX;
  process.chdir(originalCwd);
  if (originalPwd === undefined) {
    delete process.env.PWD;
  } else {
    process.env.PWD = originalPwd;
  }
  delete process.env.ORC_STATE_DIR;
  delete process.env.ORC_PROJECT_ID;
  cleanupTempStateDir(dir);
});

// ── Helpers ────────────────────────────────────────────────────────────────

function seedState(agents: unknown[] = []) {
  seedProjectState(dir, { agents });
}

function masterAgent(overrides = {}) {
  return {
    agent_id:             'master',
    provider:             'claude',
    role:                 'master',
    status:               'idle',
    session_handle:       null,
    provider_ref:         null,
    model:                null,
    registered_at:        '2026-01-01T00:00:00Z',
    last_heartbeat_at:    null,
    last_status_change_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

function readClaims() {
  return JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')).claims;
}

function seedActiveRuntimeState() {
  const claims = [{
    run_id: 'run-1',
    task_ref: 'project/task-1',
    agent_id: 'orc-1',
    state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00Z',
    lease_expires_at: '2099-01-01T00:00:00Z',
  }];
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(dir, [{ ref: 'project/task-1', title: 'Task 1', status: 'in_progress' }], claims);
}

function setEnv(stateDir: string) {
  Object.assign(process.env, bridgeProjectEnv(stateDir));
}

function mockBinaryCheck(ok = true, authOk = true) {
  vi.doMock('../lib/binaryCheck.ts', () => ({
    checkAndInstallBinary: vi.fn().mockResolvedValue(ok),
    probeProviderAuth: vi.fn().mockReturnValue(
      authOk
        ? { ok: true }
        : { ok: false, message: "Provider 'claude' is installed but not authenticated or not working. Run `claude` to verify setup." },
    ),
    PROVIDER_BINARIES: { claude: 'claude', codex: 'codex', gemini: 'gemini' },
    PROVIDER_PROMPT_PATTERNS: { claude: />\s*$/, codex: />\s*$/, gemini: />\s*$/ },
    PROVIDER_SUBMIT_SEQUENCES: { claude: '\r', codex: '\r', gemini: '\r' },
  }));
}

function makeSpawnMock({ writeCoordinatorPid = false, providerSpawnError = null as Error | null, providerCloseCode = 0 } = {}) {
  return vi.fn().mockImplementation((execPath: string, args: string[]) => {
    const target = Array.isArray(args) ? (args.find((a: string) => String(a).endsWith('coordinator.ts')) ?? '') : '';
    if (target.endsWith('coordinator.ts')) {
      if (writeCoordinatorPid) {
        writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 99999, started_at: '2026-01-01T00:00:00.000Z' }));
      }
      return { unref: vi.fn(), on: vi.fn() };
    }

    // Master provider launch via the faked startTmuxSession
    if (providerSpawnError) throw providerSpawnError;

    let dataCallback: ((chunk: string) => void) | null = null;
    return {
      pid: 12345,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn().mockImplementation((cb: (chunk: string) => void) => { dataCallback = cb; }),
      onExit: vi.fn().mockImplementation((cb: (e: { exitCode: number; signal: number }) => void) => {
        cb({ exitCode: providerCloseCode, signal: 0 });
      }),
      _emitData: (chunk: string) => dataCallback?.(chunk),
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

/**
 * orc's tmux server, faked: startTmuxSession hands the launch to the provider
 * spawn mock (so its calls read like a spawn), sessions it starts are alive
 * until an attach ends them, and attaches are recorded.
 */
const tmuxFake = {
  alive: new Set<string>(),
  attaches: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }>,
  exitOnAttach: false,
  /** A `--resume` launch dies at once, as Claude does for a conversation it cannot find. */
  failResume: false,
  /** The pane process a live session reports. */
  pid: 12345,
  stop: vi.fn(),
  reset() {
    this.alive.clear();
    this.attaches = [];
    this.exitOnAttach = false;
    this.failResume = false;
    this.pid = 12345;
    this.stop = vi.fn().mockImplementation((handle: string) => { this.alive.delete(handle.slice('tmux:'.length)); return Promise.resolve(); });
  },
  onAttach(args: string[], env: NodeJS.ProcessEnv | undefined) {
    this.attaches.push({ args, env });
    if (this.exitOnAttach) this.alive.delete(args[args.length - 1].replace(/^=/, ''));
    return { status: 0, stdout: '' };
  },
};

function mockTmux(spawnMock: ReturnType<typeof vi.fn>, { available = true } = {}) {
  tmuxFake.reset();
  vi.doMock('../adapters/tmux.ts', () => ({
    checkTmux: vi.fn().mockReturnValue(available
      ? { ok: true, version: 'tmux 3.4', problem: null }
      : { ok: false, version: null, problem: 'tmux is not installed (orc needs tmux >= 3.2 on PATH, or ORC_TMUX_BIN)' }),
    inspectTmuxSession: vi.fn().mockImplementation((name: string) => (tmuxFake.alive.has(name)
      ? { alive: true, pid: tmuxFake.pid, processStart: `proc:${tmuxFake.pid}` }
      : { alive: false, pid: null, processStart: null, reason: 'tmux session not found' })),
    tmuxAttachCommand: vi.fn().mockImplementation((name: string) => ({ command: 'tmux', args: ['attach-session', '-t', `=${name}`] })),
    startTmuxSession: vi.fn().mockImplementation((agentId: string, launch: { binary: string; args: string[] }, provider: string) => {
      const proc = (spawnMock as unknown as (...args: unknown[]) => { pid: number })(launch.binary, launch.args, launch);
      if (tmuxFake.failResume && launch.args.includes('--resume')) tmuxFake.alive.delete(agentId);
      else tmuxFake.alive.add(agentId);
      return {
        session_handle: `tmux:${agentId}`,
        provider_ref: {
          pid: proc.pid, provider, binary: launch.binary, transport: 'tmux', process_start: `proc:${proc.pid}`,
          tmux_socket: 'orc-test', tmux_session: agentId,
        },
      };
    }),
    createTmuxAdapter: vi.fn().mockImplementation(() => ({ stop: tmuxFake.stop })),
  }));
}

/** Runs start-session as if from a real terminal, so it attaches to the master. */
function withTty() {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  // A TTY would make the wizard prompt for real; answer as the non-interactive defaults do.
  vi.doMock('../lib/prompts.ts', async () => ({
    ...await vi.importActual<typeof import('../lib/prompts.ts')>('../lib/prompts.ts'),
    isInteractive: vi.fn().mockReturnValue(false),
    promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
    promptMasterAction: vi.fn().mockImplementation((existing: unknown) => Promise.resolve(existing ? 'reuse' : 'register')),
    promptProvider: vi.fn().mockImplementation((value: string | undefined) => Promise.resolve(value ?? 'claude')),
  }));
  ttyRestore = () => {
    for (const [stream, desc] of [[process.stdin, stdin], [process.stdout, stdout]] as const) {
      if (desc) Object.defineProperty(stream, 'isTTY', desc);
      else delete (stream as { isTTY?: boolean }).isTTY;
    }
  };
}
let ttyRestore: (() => void) | null = null;

function mockSpawn(spawnMock = makeSpawnMock(), spawnSyncMock: ReturnType<typeof vi.fn> | null = null, { tmuxAvailable = true } = {}) {
  const resolvedSpawnSyncMock = spawnSyncMock
    ?? vi.fn().mockImplementation((command: string, args: string[] = [], options?: { cwd?: string }) => {
      if (command === 'git' && args.includes('--show-toplevel')) {
        return { status: 0, stdout: `${options?.cwd ?? process.cwd()}\n` };
      }
      if (command === 'ps') {
        return { status: 0, stdout: `node ${coordinatorScriptPath}` };
      }
      if (command === 'tmux' && args[0] === 'attach-session') {
        return tmuxFake.onAttach(args, (options as { env?: NodeJS.ProcessEnv } | undefined)?.env);
      }
      return { status: 0, stdout: `node ${coordinatorScriptPath}` };
    });
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual('node:child_process');
    return {
      ...actual,
      spawn: spawnMock,
      spawnSync: resolvedSpawnSyncMock,
    };
  });
  mockTmux(spawnMock, { available: tmuxAvailable });
  return spawnMock;
}

// A live process running a coordinator script, shared by the tests that need a running coordinator.
let fakeCoordinator: FakeCoordinator;
beforeAll(async () => { fakeCoordinator = await startFakeCoordinator(); });
afterAll(async () => { await fakeCoordinator.stop(); });

// Writes a coordinator.pid naming the live fake coordinator.
function seedCoordinatorRunning() {
  writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: fakeCoordinator.pid, started_at: '2026-01-01T00:00:00.000Z' }));
}

function writeEndpoint(pid: number, processStart: string | null) {
  writeFileSync(join(dir, 'control.json'), JSON.stringify({
    protocol_version: 1, transport: 'unix', path: join(dir, 'control.sock'),
    pid, started_at: '2026-11-01T00:00:00.000Z', process_start: processStart,
  }));
}

// ── spawnSync tests (no adapter needed) ────────────────────────────────────

describe('cli/start-session.ts', () => {
  describe('state auto-init', () => {
    it('creates all four state files when the state dir is absent', () => {
      const freshDir = join(dir, 'fresh-state');
      // freshDir holds only the project descriptor
      mkdirSync(freshDir);
      spawnSync('node', ['cli/start-session.ts'], {
        cwd:      repoRoot,
        env:      { ...process.env, ...bridgeProjectEnv(freshDir) },
        encoding: 'utf8',
      });
      expect(existsSync(join(freshDir, 'backlog.json'))).toBe(true);
      expect(existsSync(join(freshDir, 'agents.json'))).toBe(true);
      expect(existsSync(join(freshDir, 'claims.json'))).toBe(true);
      expect(existsSync(join(freshDir, 'events.db'))).toBe(true);
    });

    it('does not overwrite existing state files', () => {
      seedState();
      // Seed a sentinel task: auto-init must neither reset the store nor overwrite its projection
      seedProjectTasks(dir, [{ ref: 'sentinel/task-1', title: 'Sentinel', status: 'todo' }]);

      spawnSync('node', ['cli/start-session.ts'], {
        cwd:      repoRoot,
        env:      { ...process.env, ...bridgeProjectEnv(dir) },
        encoding: 'utf8',
      });

      expect(readBacklog(dir).features[0].ref).toBe('sentinel');
      const projection = JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
      expect(projection.features.flatMap((feature: { tasks: Array<{ ref: string }> }) => feature.tasks.map((task) => task.ref)))
        .toEqual(['sentinel/task-1']);
    });

    it('keeps runtime state by default when no coordinator runs, so live sessions can be adopted', async () => {
      seedState([
        masterAgent(),
        masterAgent({ agent_id: 'orc-1', role: 'worker', status: 'running', session_handle: 'tmux:orc-1' }),
      ]);
      seedActiveRuntimeState();

      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);
      setEnv(dir);
      // No coordinator running, non-interactive: the default keeps state for the new coordinator to adopt.
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(readBacklog(dir).features[0].tasks[0].status).toBe('in_progress');
      expect(readClaims()[0].state).toBe('in_progress');
      expect(readAgents().find((agent: { agent_id: string }) => agent.agent_id === 'orc-1'))
        .toMatchObject({ status: 'running', session_handle: 'tmux:orc-1' });
      expect(tmuxFake.stop).not.toHaveBeenCalledWith('tmux:orc-1');
      const events = queryEvents(dir, {});
      expect(events.find((event) => event.event === 'session_started')?.payload).toMatchObject({ reset_claims: 0 });
    });

    it('--reset stops every worker session, fails its runs and appends session_started', async () => {
      seedState([
        masterAgent({
          status: 'running',
          session_handle: 'tmux:master',
          provider_ref: { pid: 111 },
          last_heartbeat_at: '2026-01-01T00:00:00Z',
        }),
        masterAgent({ agent_id: 'orc-1', role: 'worker', status: 'running', session_handle: 'tmux:orc-1' }),
      ]);
      seedActiveRuntimeState();

      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);
      setEnv(dir);
      process.argv = ['node', 'start-session.ts', '--reset'];
      await import('./start-session.ts');

      expect(tmuxFake.stop).toHaveBeenCalledWith('tmux:orc-1');
      expect(tmuxFake.stop).not.toHaveBeenCalledWith('tmux:master');
      expect(readBacklog(dir).features[0].tasks[0].status).toBe('todo');
      expect(readClaims()[0]).toMatchObject({ state: 'failed', failure_reason: 'session_reset' });
      expect(readAgents().find((agent: { agent_id: string }) => agent.agent_id === 'orc-1'))
        .toMatchObject({ status: 'idle', session_handle: null });
      const events = queryEvents(dir, {});
      expect(events.some((event) => event.event === 'session_started')).toBe(true);
    });
  });

  describe('non-interactive error handling', () => {
    it('exits 1 with an error when no master exists and no --provider flag', () => {
      seedState(); // no agents
      const result = spawnSync('node', ['cli/start-session.ts'], {
        cwd:      repoRoot,
        env:      { ...process.env, ...bridgeProjectEnv(dir) },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('provider');
    });

    it('reuses existing master when already registered (non-interactive)', async () => {
      seedState([masterAgent()]);
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      const promptCreateWorkerAction = vi.fn().mockResolvedValue('skip');
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(false),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue('clear_all'),
        promptCreateWorkerAction,
      }));
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

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
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const agents = readAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].role).toBe('master');
      expect(agents[0].provider).toBe('claude');
      expect(spawnMock).toHaveBeenCalled();
    });

    it('closes the master\'s session when the master exits, so its id stops authenticating (task 232)', async () => {
      seedState();
      mockSpawn(makeSpawnMock());
      tmuxFake.exitOnAttach = true;
      withTty();
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      const masterSessions = listSupervisedSessions(dir).filter((row) => row.agent_id === 'master');
      expect(masterSessions.length).toBeGreaterThan(0);
      expect(masterSessions.every((row) => row.state === 'offline')).toBe(true);
    });

    it('registers missing master with fixed id without prompting master agent id', async () => {
      seedState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
        promptMasterAction: vi.fn().mockResolvedValue('register'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
      }));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      const agents = readAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agent_id).toBe('master');
      expect(agents[0].role).toBe('master');
    });

    it('does not register a second master when one already exists (conflict gate cancels)', async () => {
      seedState([masterAgent({ status: 'running' })]);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider:              vi.fn().mockResolvedValue('claude'),
        isInteractive:               vi.fn().mockReturnValue(true), // interactive so cancel → exit 0
        promptCoordinatorAction:      vi.fn().mockResolvedValue('reuse'),
        promptMasterAction:           vi.fn().mockResolvedValue('cancel'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue('clear_all'),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
      }));
      mockSpawn();
      mockBinaryCheck(true);
      mockProcessExit();

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:0');

      // Agents unchanged — conflict gate fired and exited (no second registration)
      expect(readAgents()).toHaveLength(1);
    });
  });

  describe('conflict gate', () => {
    it('replace removes old master and continues to fresh registration', async () => {
      seedState([masterAgent()]);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider:              vi.fn().mockResolvedValue('codex'),
        isInteractive:               vi.fn().mockReturnValue(true),
        promptCoordinatorAction:      vi.fn().mockResolvedValue('reuse'),
        promptMasterAction:           vi.fn().mockResolvedValue('replace'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue('clear_all'),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
      }));
      mockSpawn();
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=codex', '--agent-id=master2'];
      await import('./start-session.ts');

      const agents = readAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].agent_id).toBe('master2');
      expect(agents[0].provider).toBe('codex');
    });

    it('reuse exits without state change and starts coordinator if needed', async () => {
      seedState([masterAgent()]);
      seedActiveRuntimeState();
      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider:              vi.fn().mockResolvedValue('claude'),
        isInteractive:               vi.fn().mockReturnValue(true),
        promptCoordinatorAction:      vi.fn().mockResolvedValue('reuse'),
        promptMasterAction:           vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue(''),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
      }));
      mockBinaryCheck(true);
      setEnv(dir);
      // No coordinator.pid → coordinator not running
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(true);
      expect(readAgents()).toHaveLength(1);       // agents unchanged
      // tasks and claims must NOT be reset — that is the whole point of 'reuse'
      expect(readBacklog(dir).features[0].tasks[0].status).toBe('in_progress');
      expect(readClaims()[0].state).toBe('in_progress');
    });

    it('does not modify existing worker registrations during normal startup', async () => {
      seedState([
        masterAgent({ agent_id: 'master' }),
        masterAgent({ agent_id: 'worker-01', role: 'worker', provider: 'codex' }),
      ]);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
      }));
      mockSpawn();
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      const agents = readAgents();
      expect(agents).toHaveLength(2);
      expect(agents.some((a: Record<string, unknown>) => a.agent_id === 'worker-01' && a.role === 'worker')).toBe(true);
    });

    it('terminates running coordinator when chosen, then restarts it', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 999999, started_at: '2026-01-01T00:00:00.000Z' }));

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider:              vi.fn().mockResolvedValue('claude'),
        isInteractive:               vi.fn().mockReturnValue(true),
        promptCoordinatorAction:      vi.fn().mockResolvedValue('terminate'),
        promptMasterAction:           vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice:     vi.fn(),
        promptWorkerPoolAction:       vi.fn().mockResolvedValue(''),
        promptCreateWorkerAction:     vi.fn().mockResolvedValue('skip'),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(true);
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
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const coordinatorCall = spawnMock.mock.calls.find((c: unknown[]) => (c[1] as string[] ?? []).some((a: string) => String(a).endsWith('coordinator.ts'))) as [string, string[]] | undefined;
      expect(coordinatorCall).toBeTruthy();
      const [execPath, args] = coordinatorCall!;
      expect(args[0]).toMatch(/coordinator\.ts$/);
      expect(execPath).toBe(process.execPath);
    });

    it('skips spawning coordinator when it is already running', async () => {
      seedState(); // no existing master

      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning(); // a live fake coordinator
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      // Coordinator path should not spawn when already running; master foreground spawn still happens.
      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(false);
    });

    it('reports a live coordinator recorded only in control.json as running and does not spawn another', async () => {
      seedState();
      writeEndpoint(fakeCoordinator.pid, readProcessStart(fakeCoordinator.pid));
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      const logSpy = vi.spyOn(console, 'log');

      setEnv(dir);
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(false);
      expect(logSpy.mock.calls.some(([line]) => String(line).includes(`Coordinator already running  (PID ${fakeCoordinator.pid})`))).toBe(true);
    });

    it('spawns a coordinator when control.json names a PID reused by a non-coordinator', async () => {
      seedState();
      // This test's own (live) process is not a coordinator.
      writeEndpoint(process.pid, readProcessStart(process.pid));
      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(true);
    });

    it('treats invalid pid-file pid as not running and spawns coordinator', async () => {
      seedState();
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: -1 }));

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(true);
    });

    it('treats malformed coordinator.pid json as not running and spawns coordinator', async () => {
      seedState();
      writeFileSync(join(dir, 'coordinator.pid'), '{bad-json');

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(true);
    });

    it('treats pid as not running when ps probe fails and spawns coordinator', async () => {
      seedState();
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: process.pid, started_at: '2026-01-01T00:00:00.000Z' }));

      const spawnMock = makeSpawnMock({ writeCoordinatorPid: true });
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 1, stdout: '' });
      mockSpawn(spawnMock, spawnSyncMock);
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(true);
    });
  });

  describe('coordinator terminate safety', () => {
    it('refuses to reset while the coordinator it tried to stop still runs', async () => {
      seedState([masterAgent()]);
      seedActiveRuntimeState();
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345, started_at: '2026-01-01T00:00:00.000Z' }));
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && (signal === 0 || signal === 'SIGTERM')) return true;
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      });
      mockSpawn(makeSpawnMock(), vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` }));
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(false),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reset'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
      }));
      mockBinaryCheck(true);
      const exitSpy = mockProcessExit();

      setEnv(dir);
      process.argv = ['node', 'start-session.ts', '--reset'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(readClaims()[0].state).toBe('in_progress');
    });

    it('does not remove coordinator.pid when terminate does not stop the process', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345, started_at: '2026-01-01T00:00:00.000Z' }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && (signal === 0 || signal === 'SIGTERM')) return true;
        const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(false);
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    });

    it('keeps coordinator pid file when status probe returns EPERM', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345, started_at: '2026-01-01T00:00:00.000Z' }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && signal === 0) {
          const err = Object.assign(new Error('EPERM'), { code: 'EPERM' });
          throw err;
        }
        const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
      expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(spawnMock.mock.calls.some(([, args]) => (args ?? []).some((a: string) => String(a).endsWith('coordinator.ts')))).toBe(false);
    });

    it('refuses terminate when coordinator.pid is missing started_at', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345 }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && signal === 0) return true;
        const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: `node ${coordinatorScriptPath}` });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
    });

    it('refuses terminate when pid command is not coordinator', async () => {
      seedState([masterAgent()]);
      writeFileSync(join(dir, 'coordinator.pid'), JSON.stringify({ pid: 12345, started_at: '2026-01-01T00:00:00.000Z' }));

      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (pid === 12345 && signal === 0) return true;
        const err = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        throw err;
      });

      const spawnMock = makeSpawnMock();
      const spawnSyncMock = vi.fn().mockReturnValue({ status: 0, stdout: 'node unrelated-worker.mjs' });
      mockSpawn(spawnMock, spawnSyncMock);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('terminate'),
        promptMasterAction: vi.fn().mockResolvedValue('reuse'),
        printManagedWorkerNotice: vi.fn(),
        promptWorkerPoolAction: vi.fn().mockResolvedValue('reuse'),
        promptCreateWorkerAction: vi.fn().mockResolvedValue('skip'),
      }));
      mockBinaryCheck(true);

      setEnv(dir);
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(killSpy).not.toHaveBeenCalledWith(12345, 'SIGTERM');
      expect(existsSync(join(dir, 'coordinator.pid'))).toBe(true);
    });
  });

  describe('next-step hints', () => {
    it('prints next-step hints to stdout', async () => {
      seedState(); // no existing master
      mockSpawn();
      mockBinaryCheck(true);

      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => lines.push(args.join(' ')));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const out = lines.join('\n');
      expect(out).toContain('detach with Ctrl-b d or close this terminal, and it keeps running');
      expect(out).toContain('MASTER:  planner/delegator; orc start-session attaches to it (or starts it)');
      expect(out).toContain('MANAGED WORKERS');
      expect(out).toContain('WORKERS: coordinator-managed background capacity launched per task');
      expect(out).toContain('orc delegate');
      expect(out).toContain('Recovery/debug');
      expect(out).toContain('orc status');
    });
  });

  describe('prompt order', () => {
    it('runs prompts in coordinator -> master order', async () => {
      seedState([masterAgent({ agent_id: 'master', provider: 'claude' })]);
      const order: string[] = [];
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockImplementation(() => {
          order.push('coordinator');
          return Promise.resolve('reuse');
        }),
        promptMasterAction: vi.fn().mockImplementation(() => {
          order.push('master');
          return Promise.resolve('reuse');
        }),
        printManagedWorkerNotice: vi.fn(),
      }));
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(order).toEqual(['coordinator', 'master']);
    });
  });

  describe('master session', () => {
    it('launches claude with --mcp-config and the secret only in the launcher env', async () => {
      seedState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const providerCall = spawnMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('claude')) as [string, string[], unknown] | undefined;
      expect(providerCall).toBeTruthy();
      expect(providerCall![1]).toContain('--mcp-config');
      expect(providerCall![1]).toContain('--system-prompt');
      const promptIndex = providerCall![1].indexOf('--system-prompt');
      const bootstrapText = providerCall![1][promptIndex + 1];
      expect(bootstrapText).toContain('MASTER_BOOTSTRAP v2');
      expect(bootstrapText).toContain('agent_id: master');
      expect(bootstrapText).toContain('provider: claude');
      expect(bootstrapText).not.toContain('{{agent_id}}');
      expect(providerCall![1].some((arg: string) => String(arg).includes('mcp-config.json'))).toBe(true);
      // The secret travels in the launcher env only, never on the command line.
      const launch = providerCall![2] as { env: Record<string, string>; cwd: string };
      expect(launch.env.ORC_MASTER_SECRET).toMatch(/.+/);
      expect(providerCall![1].join(' ')).not.toContain(launch.env.ORC_MASTER_SECRET);
      expect(launch.cwd).toBeTruthy();
    });

    it('runs the master as a supervised tmux session that outlives start-session', async () => {
      seedState();
      mockSpawn();
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(readAgents()[0]).toMatchObject({ status: 'running', session_handle: 'tmux:master' });
      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      const [session] = listSupervisedSessions(dir).filter((row) => row.agent_id === 'master');
      expect(session).toMatchObject({ state: 'running', transport: 'tmux', process_pid: 12345, process_start: 'proc:12345' });
      // A fresh Claude master gets a conversation id it can be resumed from.
      expect(session.provider_conversation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(tmuxFake.alive.has('master')).toBe(true);
    });

    it('starts a fresh Claude conversation with a recorded --session-id', async () => {
      seedState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const args = (spawnMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('claude')) as [string, string[]])[1];
      expect(args).not.toContain('--resume');
      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      expect(args[args.indexOf('--session-id') + 1]).toBe(listSupervisedSessions(dir)[0].provider_conversation_id);
    });

    it('leaves the master running and its session valid after the terminal detaches', async () => {
      seedState();
      mockSpawn();
      withTty();
      mockBinaryCheck(true);
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => lines.push(args.join(' ')));
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(tmuxFake.attaches).toHaveLength(1);
      expect(tmuxFake.attaches[0].args).toEqual(['attach-session', '-t', '=master']);
      expect(lines.join('\n')).toContain('Detached. The master keeps running');
      expect(readAgents()[0]).toMatchObject({ status: 'running', session_handle: 'tmux:master' });
      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      expect(listSupervisedSessions(dir).find((row) => row.agent_id === 'master')?.state).toBe('running');
    });

    it('attaches from inside an existing tmux session by clearing TMUX', async () => {
      seedState();
      mockSpawn();
      withTty();
      process.env.TMUX = '/tmp/tmux-1000/default,1,0';
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      expect(tmuxFake.attaches).toHaveLength(1);
      expect(tmuxFake.attaches[0].env).toBeDefined();
      expect(tmuxFake.attaches[0].env).not.toHaveProperty('TMUX');
    });

    it('reattaches to a live master instead of starting another, leaving state untouched', async () => {
      seedState([masterAgent({ status: 'running', session_handle: 'tmux:master', provider_ref: { pid: 4242, transport: 'tmux' } })]);
      seedActiveRuntimeState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      tmuxFake.alive.add('master');
      withTty();
      const promptCoordinatorAction = vi.fn().mockResolvedValue('terminate');
      const promptMasterAction = vi.fn().mockResolvedValue('replace');
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction,
        promptMasterAction,
        printManagedWorkerNotice: vi.fn(),
      }));
      mockBinaryCheck(true);
      const exitSpy = mockProcessExit();
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:0');

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(promptCoordinatorAction).not.toHaveBeenCalled();
      expect(promptMasterAction).not.toHaveBeenCalled();
      expect(spawnMock.mock.calls.some((c: unknown[]) => String(c[0]).endsWith('claude'))).toBe(false);
      expect(tmuxFake.attaches).toHaveLength(1);
      expect(readClaims()[0].state).toBe('in_progress');
      expect(readAgents()[0]).toMatchObject({ status: 'running', session_handle: 'tmux:master' });
    });

    it('resumes the recorded Claude conversation under the same session when the master process is dead', async () => {
      seedState([masterAgent({ status: 'offline' })]);
      const { recordProviderSession, closeProviderSessionsForAgent } = await import('../lib/runStore.ts');
      recordProviderSession(dir, {
        sessionId: 'session-old', runId: null, agentId: 'master', provider: 'claude', providerRef: null,
        startedAt: '2026-01-01T00:00:00Z', transport: 'tmux', credentialHash: 'old-hash', providerConversationId: 'conv-1234',
      });
      closeProviderSessionsForAgent(dir, 'master', '2026-01-01T01:00:00Z');
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      const args = (spawnMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('claude')) as [string, string[]])[1];
      expect(args[args.indexOf('--resume') + 1]).toBe('conv-1234');
      expect(args).not.toContain('--session-id');
      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      const sessions = listSupervisedSessions(dir).filter((row) => row.agent_id === 'master');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        session_id: 'session-old', state: 'running', provider_conversation_id: 'conv-1234', generation: 1, resume_count: 1, process_pid: 12345,
      });
      expect(readAgents()[0]).toMatchObject({ status: 'running', session_handle: 'tmux:master', session_token: 'session-old' });
      const resumed = queryEvents(dir, { event_type: 'session_resumed' });
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ agent_id: 'master', payload: { session_id: 'session-old', generation: 1, provider_conversation_id: 'conv-1234' } });
      expect(queryEvents(dir, { event_type: 'session_started' }).at(-1)).toMatchObject({ payload: { session_id: 'session-old' } });
    }, 15_000);

    it('falls back to a fresh conversation when the resume fails', async () => {
      seedState([masterAgent({ status: 'offline' })]);
      const { recordProviderSession, closeProviderSessionsForAgent } = await import('../lib/runStore.ts');
      recordProviderSession(dir, {
        sessionId: 'session-old', runId: null, agentId: 'master', provider: 'claude', providerRef: null,
        startedAt: '2026-01-01T00:00:00Z', providerConversationId: 'conv-gone',
      });
      closeProviderSessionsForAgent(dir, 'master', '2026-01-01T01:00:00Z');
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      tmuxFake.failResume = true;
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      const launches = spawnMock.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith('claude')).map((c: unknown[]) => c[1] as string[]);
      expect(launches).toHaveLength(2);
      expect(launches[0]).toContain('--resume');
      const freshId = launches[1][launches[1].indexOf('--session-id') + 1];
      expect(freshId).not.toBe('conv-gone');
      const failed = queryEvents(dir, { event_type: 'session_resume_failed' });
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ agent_id: 'master', payload: { session_id: 'session-old', provider_conversation_id: 'conv-gone' } });
      expect(queryEvents(dir, { event_type: 'session_resumed' })).toHaveLength(0);
      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      const running = listSupervisedSessions(dir).filter((row) => row.agent_id === 'master' && row.state === 'running');
      expect(running).toHaveLength(1);
      expect(running[0]).toMatchObject({ provider_conversation_id: freshId });
      expect(running[0].session_id).not.toBe('session-old');
    });

    it('starts fresh instead of resuming when the master was just replaced', async () => {
      seedState([masterAgent()]);
      const { recordProviderSession } = await import('../lib/runStore.ts');
      recordProviderSession(dir, {
        sessionId: 'session-old', runId: null, agentId: 'master', provider: 'claude', providerRef: null,
        startedAt: '2026-01-01T00:00:00Z', providerConversationId: 'conv-1234',
      });
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      vi.doMock('../lib/prompts.ts', () => ({
        promptProvider: vi.fn().mockResolvedValue('claude'),
        isInteractive: vi.fn().mockReturnValue(true),
        promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
        promptMasterAction: vi.fn().mockResolvedValue('replace'),
        printManagedWorkerNotice: vi.fn(),
      }));
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude'];
      await import('./start-session.ts');

      const args = (spawnMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('claude')) as [string, string[]])[1];
      expect(args).not.toContain('--resume');
      expect(args[args.indexOf('--session-id') + 1]).not.toBe('conv-1234');
    });

    it('marks master offline when the master exits while attached', async () => {
      seedState();
      mockSpawn();
      tmuxFake.exitOnAttach = true;
      withTty();
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const master = readAgents().find((a: Record<string, unknown>) => a.agent_id === 'master');
      expect(master.status).toBe('offline');
      expect(master.session_handle).toBeNull();
      // The retirement says why (general/master-liveness-race).
      expect(queryEvents(dir, { event_type: 'master_retired' })).toMatchObject([{
        agent_id: 'master', actor_type: 'human',
        payload: { session_handle: 'tmux:master', probe: { alive: false, reason: 'tmux session not found', pid: null }, consecutive_failures: 2 },
      }]);
    });

    it('restores a master marked offline while its tmux pane runs, so its secret authenticates again', async () => {
      seedState([masterAgent({ status: 'offline', session_handle: null, provider_ref: null })]);
      const { recordProviderSession, closeProviderSessionsForAgent } = await import('../lib/runStore.ts');
      const { credentialHash } = await import('../lib/sessionCredentials.ts');
      const providerRef = { pid: 4242, transport: 'tmux', process_start: 'proc:4242', tmux_session: 'master' };
      recordProviderSession(dir, {
        sessionId: 'session-live', runId: null, agentId: 'master', provider: 'claude', providerRef,
        startedAt: '2026-01-01T00:00:00Z', transport: 'tmux', processPid: 4242, processStart: 'proc:4242',
        credentialHash: credentialHash('live-secret'), providerConversationId: 'conv-live',
      });
      closeProviderSessionsForAgent(dir, 'master', '2026-01-01T00:00:08Z');
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      tmuxFake.alive.add('master');
      tmuxFake.pid = 4242;
      withTty();
      mockBinaryCheck(true);
      const exitSpy = mockProcessExit();
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:0');

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(spawnMock.mock.calls.some((c: unknown[]) => String(c[0]).endsWith('claude'))).toBe(false);
      expect(tmuxFake.attaches).toHaveLength(1);
      expect(readAgents()[0]).toMatchObject({
        status: 'running', session_handle: 'tmux:master', session_token: 'session-live', provider_ref: providerRef,
      });
      const { listSupervisedSessions } = await import('../lib/sessionSupervisor.ts');
      expect(listSupervisedSessions(dir).filter((row) => row.agent_id === 'master')).toMatchObject([{ session_id: 'session-live', state: 'running' }]);
      // The live master's secret proves a running session again.
      const { sessionForCredential } = await import('../lib/sessionCredentials.ts');
      expect(sessionForCredential(dir, 'live-secret')).toMatchObject({ session_id: 'session-live', agent_id: 'master', state: 'running' });
      expect(queryEvents(dir, { event_type: 'session_reconciled' })).toMatchObject([{
        agent_id: 'master', payload: { session_id: 'session-live', state: 'running', previous_state: 'offline', outcome: 'restored' },
      }]);
    });

    it('does not restore a closed master session that belongs to another process', async () => {
      seedState([masterAgent({ status: 'offline', session_handle: null, provider_ref: null })]);
      const { recordProviderSession, closeProviderSessionsForAgent } = await import('../lib/runStore.ts');
      recordProviderSession(dir, {
        sessionId: 'session-old', runId: null, agentId: 'master', provider: 'claude', providerRef: null,
        startedAt: '2026-01-01T00:00:00Z', transport: 'tmux', processPid: 1111, processStart: 'proc:1111',
      });
      closeProviderSessionsForAgent(dir, 'master', '2026-01-01T00:00:08Z');
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      tmuxFake.alive.add('master');
      tmuxFake.pid = 4242;
      mockBinaryCheck(true);
      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      // No session to restore: start-session launches a master as it did before.
      expect(spawnMock.mock.calls.some((c: unknown[]) => String(c[0]).endsWith('claude'))).toBe(true);
      expect(queryEvents(dir, { event_type: 'session_reconciled' })).toHaveLength(0);
    });

    it('exits 1 when binary check fails', async () => {
      seedState([masterAgent({
        status: 'running',
        session_handle: 'tmux:master',
        provider_ref: { pid: 111 },
        last_heartbeat_at: '2026-01-01T00:00:00Z',
      })]);
      seedActiveRuntimeState();
      mockSpawn();
      mockBinaryCheck(false);
      const exitSpy = mockProcessExit();

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      const events = queryEvents(dir, {});
      expect(events.some((event) => event.event === 'session_started')).toBe(false);
      expect(readBacklog(dir).features[0].tasks[0].status).toBe('in_progress');
      expect(readClaims()[0].state).toBe('in_progress');
      expect(readAgents()[0]).toMatchObject({
        status: 'running',
        session_handle: 'tmux:master',
      });
    });

    it('exits 1 when master provider CLI spawn fails', async () => {
      seedState([masterAgent({
        status: 'running',
        session_handle: 'tmux:master',
        provider_ref: { pid: 111 },
        last_heartbeat_at: '2026-01-01T00:00:00Z',
      })]);
      seedActiveRuntimeState();
      mockSpawn(makeSpawnMock({ providerSpawnError: new Error('ENOENT: spawn claude') }));
      mockBinaryCheck(true);
      const exitSpy = mockProcessExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to start master provider CLI'));
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).not.toContain('Master session ended.');
      const events = queryEvents(dir, {});
      expect(events.some((event) => event.event === 'session_started')).toBe(false);
      expect(readBacklog(dir).features[0].tasks[0].status).toBe('in_progress');
      expect(readClaims()[0].state).toBe('in_progress');
      expect(readAgents()[0]).toMatchObject({
        status: 'running',
        session_handle: 'tmux:master',
      });
    });

    it('does not spawn coordinator when pty.spawn fails', async () => {
      seedState();
      const spawnMock = makeSpawnMock({ providerSpawnError: new Error('ENOENT: spawn claude') });
      mockSpawn(spawnMock);
      mockBinaryCheck(true);
      mockProcessExit();
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      setEnv(dir);
      // Do NOT seed coordinator — we want to verify it's never spawned
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      // Coordinator spawn (child_process.spawn with coordinator.ts arg) should not have been called
      const coordinatorCalls = spawnMock.mock.calls.filter(
        (c: unknown[]) => (c[1] as string[] ?? []).some((a: string) => String(a).endsWith('coordinator.ts')),
      );
      expect(coordinatorCalls).toHaveLength(0);
    });

    it('exits 1 before touching state when tmux is not installed', async () => {
      seedState([masterAgent()]);
      seedActiveRuntimeState();
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock, null, { tmuxAvailable: false });
      mockBinaryCheck(true);
      const exitSpy = mockProcessExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('tmux is not installed'));
      expect(readClaims()[0].state).toBe('in_progress');
    });

    it('rolls back reset and suppresses session_started when master runtime update fails after spawn', async () => {
      seedState([masterAgent({
        status: 'running',
        session_handle: 'tmux:master',
        provider_ref: { pid: 111 },
        last_heartbeat_at: '2026-01-01T00:00:00Z',
      })]);
      seedActiveRuntimeState();
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);
      vi.doMock('../lib/agentRegistry.ts', async () => {
        const actual = await vi.importActual<typeof import('../lib/agentRegistry.ts')>('../lib/agentRegistry.ts');
        return {
          ...actual,
          updateAgentRuntime: vi.fn().mockImplementation((stateDir: string, agentId: string, patch: Record<string, unknown>) => {
            if (patch.status === 'running') {
              throw new Error('update failed');
            }
            return actual.updateAgentRuntime(stateDir, agentId, patch);
          }),
        };
      });
      const exitSpy = mockProcessExit();

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      // The started master does not outlive the failed start.
      expect(tmuxFake.stop).toHaveBeenCalledWith('tmux:master');
      const events = queryEvents(dir, {});
      expect(events.some((event) => event.event === 'session_started')).toBe(false);
      expect(readBacklog(dir).features[0].tasks[0].status).toBe('in_progress');
      expect(readClaims()[0].state).toBe('in_progress');
      expect(readAgents()[0]).toMatchObject({
        status: 'running',
        session_handle: 'tmux:master',
      });
    });

    it('exits 1 when master session preparation fails before provider spawn', async () => {
      seedState([masterAgent()]);
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);
      vi.doMock('../lib/templateRender.ts', () => ({
        renderTemplate: vi.fn(() => {
          throw new Error('template render failed');
        }),
      }));
      const exitSpy = mockProcessExit();

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      const master = readAgents().find((a: Record<string, unknown>) => a.agent_id === 'master');
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
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      const configPath = join(dir, 'mcp-config.json');
      expect(existsSync(configPath)).toBe(true);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config.mcpServers?.orchestrator).toBeTruthy();
      expect(config.mcpServers.orchestrator.command).toBe(process.execPath);
      expect(config.mcpServers.orchestrator.args[0].endsWith(join('mcp', 'server.ts'))).toBe(true);
      expect(config.mcpServers.orchestrator.env.ORC_STATE_DIR).toBe(dir);
    });

    it('passes the Codex MCP server as -c overrides, writes no config file, and sends the bootstrap as the initial prompt', async () => {
      seedState([masterAgent({ provider: 'codex' })]);
      const checkoutRoot = join(dir, 'checkout');
      mkdirSync(checkoutRoot, { recursive: true });
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.chdir(checkoutRoot);
      process.env.PWD = checkoutRoot;
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(existsSync(join(dir, 'mcp-config.json'))).toBe(false);
      expect(existsSync(join(checkoutRoot, '.codex', 'config.toml'))).toBe(false);
      const providerCall = spawnMock.mock.calls.find((args: unknown[]) => String(args[0]).endsWith('codex')) as [string, string[], Record<string, unknown>] | undefined;
      expect(providerCall).toBeTruthy();
      const args = providerCall![1];
      expect(args[0]).toBe('--dangerously-bypass-approvals-and-sandbox');
      expect(args).toContain(`mcp_servers.orchestrator.env={ORC_PROJECT_ID="test-project", ORC_STATE_DIR=${JSON.stringify(dir)}}`);
      expect(args).toContain('mcp_servers.orchestrator.env_vars=["ORC_MASTER_SECRET"]');
      expect(args.join(' ')).not.toMatch(/ORC_MASTER_SECRET=/);
      expect(args.at(-1)).toContain('MASTER_BOOTSTRAP v2');
      expect(providerCall![2]).toEqual(expect.objectContaining({ cwd: checkoutRoot }));
    });

    it('writes mcp-config.json and spawns gemini with mcp and system-instruction flags', async () => {
      seedState([masterAgent({ provider: 'gemini' })]);
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true);

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');

      expect(existsSync(join(dir, 'mcp-config.json'))).toBe(true);
      const providerCall = spawnMock.mock.calls.find((args: unknown[]) => String(args[0]).endsWith('gemini')) as [string, string[]] | undefined;
      expect(providerCall).toBeTruthy();
      expect(providerCall![1]).toContain('--mcp-config');
      expect(providerCall![1]).toContain('--system-instruction');
    });

    it('writes mcp-config before claude spawn', async () => {
      seedState([masterAgent({ provider: 'claude' })]);
      const spawnMock = vi.fn().mockImplementation((cmd, args) => {
        if ((args ?? []).some((a: string) => String(a).endsWith('coordinator.ts'))) {
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
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');
      expect(spawnMock).toHaveBeenCalled();
    });

    it('prints mcp hint for claude and codex', async () => {
      seedState([masterAgent({ provider: 'claude' })]);
      mockSpawn(makeSpawnMock());
      mockBinaryCheck(true);
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => lines.push(args.join(' ')));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');
      expect(lines.join('\n')).toContain('MCP server: orchestrator tools available');
      expect(lines.join('\n')).toContain('Master bootstrap loaded via --system-prompt.');
      // The bootstrap goes to the master as its system prompt; the terminal gets one line naming it.
      expect(lines.join('\n')).not.toContain('MASTER_BOOTSTRAP v2');
      expect(lines.join('\n')).toContain('Bootstrap template: master-bootstrap-v1.txt');

      // fresh state for codex branch
      cleanupTempStateDir(dir);
      dir = createTempStateDir('orch-start-session-test-');
      seedState([masterAgent({ provider: 'codex' })]);
      const spawnMockCodex = makeSpawnMock();
      vi.resetModules();
      mockSpawn(spawnMockCodex);
      mockBinaryCheck(true);
      const codexLines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => codexLines.push(args.join(' ')));

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts'];
      await import('./start-session.ts');
      expect(codexLines.join('\n')).toContain('MCP server: orchestrator tools available');
      expect(codexLines.join('\n')).toContain('Master bootstrap loaded via initial prompt.');
    });
  });

  describe('provider auth probe', () => {
    it('exits 1 with actionable error when auth probe fails before spawning PTY session', async () => {
      seedState([masterAgent({ provider: 'claude' })]);
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true, false); // binary ok, auth fails
      const exitSpy = mockProcessExit();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await expect(import('./start-session.ts')).rejects.toThrow('process.exit:1');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('claude'));
      // PTY session must NOT have been spawned
      const providerCall = spawnMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('claude'));
      expect(providerCall).toBeUndefined();
    });

    it('proceeds normally when auth probe succeeds', async () => {
      seedState([masterAgent({ provider: 'claude' })]);
      const spawnMock = makeSpawnMock();
      mockSpawn(spawnMock);
      mockBinaryCheck(true, true); // binary ok, auth ok

      setEnv(dir);
      seedCoordinatorRunning();
      process.argv = ['node', 'start-session.ts', '--provider=claude', '--agent-id=master'];
      await import('./start-session.ts');

      const providerCall = spawnMock.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('claude'));
      expect(providerCall).toBeTruthy();
    });
  });
});
