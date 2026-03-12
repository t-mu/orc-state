import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function readAgents(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, 'agents.json'), 'utf8')).agents;
}

function seedState(stateDir) {
  writeFileSync(join(stateDir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'project', title: 'Project', tasks: [] }],
  }));
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
        capabilities: [],
        model: null,
        dispatch_mode: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
      {
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        capabilities: [],
        model: null,
        dispatch_mode: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
    ],
  }));
}

function writeAgents(stateDir, agents) {
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents,
  }));
}

let dir;

describe('worker control flow e2e', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'orch-worker-control-e2e-'));
    seedState(dir);
    process.env.ORCH_STATE_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ORCH_STATE_DIR;
    vi.unmock('../lib/prompts.ts');
    vi.unmock('../lib/binaryCheck.ts');
    vi.unmock('node-pty');
    vi.unmock('node:child_process');
    vi.unmock('../adapters/index.ts');
  });

  it('keeps workers headless in start-session and controls them via control-worker', async () => {
    writeAgents(dir, [
      {
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        capabilities: [],
        model: null,
        dispatch_mode: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
    ]);

    const ptySpawnMock = vi.fn().mockReturnValue({
      pid: 1234,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn((cb) => {
        cb({ exitCode: 0, signal: 0 });
        return { dispose: vi.fn() };
      }),
      on: vi.fn(),
      unref: vi.fn(),
    });
    vi.doMock('node-pty', () => ({
      default: { spawn: ptySpawnMock },
    }));
    const spawnMock = vi.fn().mockImplementation((cmd, args) => {
      const target = Array.isArray(args) ? String(args[0] ?? '') : '';
      if (target.endsWith('coordinator.mjs')) return { unref: vi.fn(), on: vi.fn() };
      return {
        on: (event, cb) => {
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
      promptRole: vi.fn().mockResolvedValue('worker'),
      promptCapabilities: vi.fn().mockResolvedValue(''),
    }));
    vi.doMock('../lib/binaryCheck.ts', () => ({
      checkAndInstallBinary: vi.fn().mockResolvedValue(true),
      PROVIDER_BINARIES: { claude: 'claude', codex: 'codex', gemini: 'gemini' },
      PROVIDER_PROMPT_PATTERNS: { claude: />\s*$/, codex: /›\s*$/, gemini: />\s*$/ },
      PROVIDER_SUBMIT_SEQUENCES: { claude: '\r', codex: '\r', gemini: '\r' },
    }));

    const oldArgv = process.argv;
    process.argv = ['node', 'cli/start-session.mjs'];
    await import('../cli/start-session.ts');
    process.argv = oldArgv;

    const workerAfterStartSession = readAgents(dir).find((a) => a.agent_id === 'orc-1');
    expect(workerAfterStartSession).toBeUndefined();
    expect(spawnMock.mock.calls.some(([cmd]) => cmd === 'codex')).toBe(false);
    expect(ptySpawnMock).toHaveBeenCalled();

    writeAgents(dir, [
      {
        agent_id: 'master',
        provider: 'claude',
        role: 'master',
        status: 'idle',
        session_handle: null,
        provider_ref: null,
        capabilities: [],
        model: null,
        dispatch_mode: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
      {
        agent_id: 'orc-1',
        provider: 'codex',
        role: 'worker',
        status: 'running',
        session_handle: 'pty:orc-1',
        provider_ref: null,
        capabilities: [],
        model: null,
        dispatch_mode: null,
        registered_at: '2026-01-01T00:00:00.000Z',
        last_heartbeat_at: null,
      },
    ]);

    vi.resetModules();
    const attach = vi.fn();
    const heartbeatProbe = vi.fn().mockResolvedValue(true);
    vi.doMock('@inquirer/prompts', () => ({
      select: vi.fn(),
    }));
    vi.doMock('../adapters/index.ts', () => ({
      createAdapter: () => ({ attach, heartbeatProbe }),
    }));

    const oldArgv2 = process.argv;
    process.argv = ['node', 'cli/control-worker.mjs', 'orc-1'];
    await import('../cli/control-worker.ts');
    process.argv = oldArgv2;

    expect(heartbeatProbe).toHaveBeenCalledWith('pty:orc-1');
    expect(attach).toHaveBeenCalledWith('pty:orc-1');
  });
});
