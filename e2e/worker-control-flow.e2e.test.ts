import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeProjectEnv, createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';

// vi.unmock is hoisted, so it runs once when the module loads; mocks are set per test with vi.doMock.
vi.unmock('../lib/prompts.ts');
vi.unmock('../lib/binaryCheck.ts');
vi.unmock('../adapters/tmux.ts');
vi.unmock('node:child_process');
vi.unmock('../adapters/index.ts');

function readAgents(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8')).agents;
}

function seedState(stateDir: string) {
  seedProjectTasks(stateDir, []);
  writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(stateDir, 'events.jsonl'), '');
  writeFileSync(join(stateDir, 'coordinator.pid'), JSON.stringify({ pid: process.pid }));
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [
      {
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        model: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
      {
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'tmux:orc-1',
        provider_ref: null,
        model: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
    ],
  }));
}

function writeAgents(stateDir: string, agents: unknown[]) {
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents,
  }));
}

let dir: string;

describe('worker control flow e2e', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dir = createTempStateDir('orch-worker-control-e2e-');
    seedState(dir);
    Object.assign(process.env, bridgeProjectEnv(dir));
  });

  afterEach(() => {
    cleanupTempStateDir(dir);
    delete process.env.ORC_STATE_DIR;
    delete process.env.ORC_PROJECT_ID;
  });

  it('keeps workers headless in start-session', async () => {
    writeAgents(dir, [
      {
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        model: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
    ]);

    // The master runs in orc's tmux server; no real tmux is touched here.
    const startTmuxSession = vi.fn().mockImplementation((agentId: string, launch: { binary: string }, provider: string) => ({
      session_handle: `tmux:${agentId}`,
      provider_ref: { pid: 1234, provider, binary: launch.binary, transport: 'tmux', process_start: 'proc:1234', tmux_socket: 'orc-test', tmux_session: agentId },
    }));
    vi.doMock('../adapters/tmux.ts', () => ({
      checkTmux: vi.fn().mockReturnValue({ ok: true, version: 'tmux 3.4', problem: null }),
      inspectTmuxSession: vi.fn().mockReturnValue({ alive: true }),
      tmuxAttachCommand: vi.fn().mockReturnValue({ command: 'tmux', args: [] }),
      startTmuxSession,
      createTmuxAdapter: vi.fn().mockReturnValue({ stop: vi.fn().mockResolvedValue(undefined) }),
    }));
    const spawnMock = vi.fn().mockImplementation((cmd, args) => {
      const target = Array.isArray(args) ? String(args[0] ?? '') : '';
      if (target.endsWith('coordinator.ts')) return { unref: vi.fn(), on: vi.fn() };
      return {
        on: (event: string, cb: (code: number) => void) => {
          if (event === 'close') cb(0);
        },
        unref: vi.fn(),
      };
    });
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, spawn: spawnMock };
    });
    vi.doMock('../lib/prompts.ts', () => ({
      promptProvider: vi.fn().mockResolvedValue('claude'),
      isInteractive: vi.fn().mockReturnValue(false),
      promptCoordinatorAction: vi.fn().mockResolvedValue('reuse'),
      promptMasterAction: vi.fn().mockResolvedValue('reuse'),
      printManagedWorkerNotice: vi.fn(),
    }));
    vi.doMock('../lib/binaryCheck.ts', () => ({
      checkAndInstallBinary: vi.fn().mockResolvedValue(true),
      probeProviderAuth: vi.fn().mockReturnValue({ ok: true }),
      PROVIDER_BINARIES: { claude: 'claude', codex: 'codex', gemini: 'gemini' },
      PROVIDER_PROMPT_PATTERNS: { claude: />\s*$/, codex: /›\s*$/, gemini: />\s*$/ },
      PROVIDER_SUBMIT_SEQUENCES: { claude: '\r', codex: '\r', gemini: '\r' },
    }));

    const oldArgv = process.argv;
    process.argv = ['node', 'cli/start-session.ts'];
    await import('../cli/start-session.ts');
    process.argv = oldArgv;

    const workerAfterStartSession = readAgents(dir).find((a: Record<string, unknown>) => a.agent_id === 'orc-1');
    expect(workerAfterStartSession).toBeUndefined();
    expect(spawnMock.mock.calls.some(([cmd]) => cmd === 'codex')).toBe(false);
    expect(startTmuxSession).toHaveBeenCalledWith('master', expect.any(Object), 'claude');
  });
});
