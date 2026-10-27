import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent } from '../types/agents.ts';
import { stripNestedProviderEnv } from './providerChildEnv.ts';

describe('normalizeWorkerEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prepends ~/.npm-global/bin when present', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/home/tester/.npm-global/bin' || path === '/repo/root/cli/orc.ts'),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ PATH: '/usr/local/bin:/usr/bin' }, '/repo/root');

    expect(env.PATH).toBe('/home/tester/.npm-global/bin:/usr/local/bin:/usr/bin');
    expect(env.ORC_BIN).toBe('/repo/root/cli/orc.ts');
  });

  it('does not duplicate ~/.npm-global/bin when already present', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/home/tester/.npm-global/bin' || path === '/repo/root/cli/orc.ts'),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ PATH: '/home/tester/.npm-global/bin:/usr/bin' }, '/repo/root');

    expect(env.PATH).toBe('/home/tester/.npm-global/bin:/usr/bin');
  });

  it('prepends consumer-local node_modules/.bin when present', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/repo/root/node_modules/.bin' || path === '/repo/root/node_modules/.bin/orc'),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ PATH: '/usr/local/bin:/usr/bin' }, '/repo/root');

    expect(env.PATH).toBe('/repo/root/node_modules/.bin:/usr/local/bin:/usr/bin');
    expect(env.ORC_BIN).toBe('/repo/root/node_modules/.bin/orc');
  });

  it('sets EDITOR, GIT_EDITOR, and PAGER to prevent interactive blocking', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => false) };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({});

    expect(env.EDITOR).toBe('true');
    expect(env.GIT_EDITOR).toBe('true');
    expect(env.PAGER).toBe('cat');
  });

  it('carries ORC_REPO_ROOT and ORC_HOME into the launch env', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/repo/root/cli/orc.ts'),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ ORC_STATE_DIR: '/tmp/state' }, '/repo/root');

    expect(env.ORC_STATE_DIR).toBe('/tmp/state');
    expect(env.ORC_REPO_ROOT).toBe('/repo/root');
    // ORC_HOME is the orchestration-root signal for worker orc resolution.
    expect(env.ORC_HOME).toBe('/repo/root');
    expect(env.ORC_BIN).toBe('/repo/root/cli/orc.ts');
  });

  it('sets neither ORC_HOME nor ORC_REPO_ROOT when no repo root is given', async () => {
    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({});
    expect(env.ORC_HOME).toBeUndefined();
    expect(env.ORC_REPO_ROOT).toBeUndefined();
  });
});

// Integration: a worker cds into its target-repo worktree, from which git-based
// discovery resolves to the TARGET repo. The propagated ORC_HOME (and, as a
// fallback, walk-up discovery since worktrees live under the orchestration root)
// must make orc resolution land on the ORCHESTRATION home instead.
describe('worker ORC_HOME resolution from inside a target-repo worktree', () => {
  let tmp: string;
  let orch: string;
  let target: string;
  let worktree: string;

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    // The normalizeWorkerEnv tests vi.doMock('node:fs') to stub existsSync;
    // doMock registrations survive resetModules, so clear them here or the real
    // filesystem walk-up in findConfigDirUpwards would use the stub.
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    // realpathSync: macOS tmpdir is a symlink; git reports resolved paths.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'orc-home-test-')));
    orch = join(tmp, 'orch');
    target = join(tmp, 'target');
    mkdirSync(orch, { recursive: true });
    mkdirSync(target, { recursive: true });
    // Orchestration home: a git repo carrying the config (its presence is what
    // walk-up keys off) and the state dir.
    git(orch, 'init', '-b', 'main');
    writeFileSync(join(orch, 'orc-state.config.json'), '{}');
    mkdirSync(join(orch, '.orc-state'), { recursive: true });
    // Target (product) repo with one commit.
    git(target, 'init', '-b', 'main');
    git(target, 'config', 'user.email', 'test@example.com');
    git(target, 'config', 'user.name', 'Test');
    writeFileSync(join(target, 'product.txt'), 'code\n');
    git(target, 'add', 'product.txt');
    git(target, 'commit', '-m', 'init');
    // A worktree OF the target repo, placed under the orchestration root.
    worktree = join(orch, '.worktrees', 'run-1');
    mkdirSync(join(orch, '.worktrees'), { recursive: true });
    git(target, 'worktree', 'add', worktree, '-b', 'task/run-1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('ORC_HOME from the worker env drives resolution, overriding walk-up', async () => {
    // Distinct orchestration home NOT on the worktree's ancestry, so walk-up
    // (which would find `orch`) and ORC_HOME (which points at `orch2`) give
    // different answers — proving the ORC_HOME branch, not walk-up, decides.
    const orch2 = join(tmp, 'orch2');
    mkdirSync(join(orch2, '.orc-state'), { recursive: true });
    writeFileSync(join(orch2, 'orc-state.config.json'), '{}');

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    // Source ORC_HOME from the real coordinator seam (repoRoot = orch2).
    const workerEnv = normalizeWorkerEnv({ ORC_STATE_DIR: join(orch2, '.orc-state') }, orch2);
    expect(workerEnv.ORC_HOME).toBe(orch2);

    vi.stubEnv('ORC_HOME', workerEnv.ORC_HOME);
    vi.stubEnv('ORC_REPO_ROOT', undefined as unknown as string);
    const { resolveOrchestrationRoot } = await import('./repoRoot.ts');
    // From the worktree cwd, walk-up would resolve to `orch`; ORC_HOME wins → orch2.
    expect(resolveOrchestrationRoot(worktree)).toBe(orch2);
  });

  it('resolves the orchestration root via walk-up when ORC_HOME is unset', async () => {
    vi.stubEnv('ORC_HOME', undefined as unknown as string);
    vi.stubEnv('ORC_REPO_ROOT', undefined as unknown as string);
    const { resolveOrchestrationRoot, resolveRepoRoot } = await import('./repoRoot.ts');
    // Sanity: bare git discovery from the worktree resolves to the TARGET repo…
    expect(resolveRepoRoot(worktree)).toBe(target);
    // …but orchestration resolution walks up to the config-bearing orch home.
    expect(resolveOrchestrationRoot(worktree)).toBe(orch);
  });
});

describe('stripNestedProviderEnv', () => {
  it('removes nested Claude and Codex session-control variables', () => {
    const env = stripNestedProviderEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: '/tmp/claude',
      CLAUDE_CODE_EXECPATH: '/tmp/claude-exec',
      CODEX_CI: '1',
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_SANDBOX: 'seatbelt',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
      CODEX_THREAD_ID: 'thread-1',
      HOME: '/tmp/home',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/tmp/home');
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(env.CODEX_CI).toBeUndefined();
    expect(env.CODEX_MANAGED_BY_NPM).toBeUndefined();
    expect(env.CODEX_SANDBOX).toBeUndefined();
    expect(env.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
    expect(env.CODEX_THREAD_ID).toBeUndefined();
  });
});

interface TestAdapter {
  start(agentId: string, options: {
    system_prompt: string;
    model: string | null;
    working_directory: string | null | undefined;
    read_only?: boolean;
    require_git_checkout?: boolean;
    execution_mode?: 'full-access' | 'sandbox';
    startup_profile?: 'default' | 'real-provider-smoke';
    env: Record<string, string>;
  }): Promise<{ session_handle: string; provider_ref: unknown }>;
}

describe('launchWorkerSession execution mode', () => {
  const makeAgent = (overrides: Partial<Agent> = {}): Agent => ({
    agent_id: 'test-worker',
    provider: 'claude',
    role: 'worker',
    status: 'idle',
    model: null,
    session_handle: null,
    session_token: null,
    provider_ref: null,
    session_started_at: null,
    session_ready_at: null,
    last_heartbeat_at: null,
    last_status_change_at: null,
    registered_at: new Date().toISOString(),
    ...overrides,
  });

  let adapterStartSpy: ReturnType<typeof vi.fn>;
  let adapter: TestAdapter;

  beforeEach(() => {
    adapterStartSpy = vi.fn().mockResolvedValue({ session_handle: 'handle-1', provider_ref: null });
    adapter = { start: adapterStartSpy as unknown as TestAdapter['start'] };
    vi.doMock('./agentRegistry.ts', () => ({ updateAgentRuntime: vi.fn() }));
    vi.doMock('./orcBin.ts', () => ({ resolveOrcBin: vi.fn(() => 'orc') }));
    vi.doMock('./sessionBootstrap.ts', () => ({ buildSessionBootstrap: vi.fn(() => 'BOOTSTRAP') }));
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => false) };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('passes execution_mode to adapter.start', async () => {
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    const agent = makeAgent();
    await launchWorkerSession('/tmp/state', agent, {
      adapter,
      workingDirectory: '/tmp/work',
      executionMode: 'sandbox',
      emit: vi.fn(),
    });
    expect(adapterStartSpy).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({ execution_mode: 'sandbox' }),
    );
  });

  it('requires a git checkout for workers but not scouts (task 204)', async () => {
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    await launchWorkerSession('/tmp/state', makeAgent(), { adapter, workingDirectory: '/tmp/work', emit: vi.fn() });
    await launchWorkerSession('/tmp/state', makeAgent({ role: 'scout' }), { adapter, workingDirectory: '/tmp/work', emit: vi.fn() });
    expect(adapterStartSpy.mock.calls[0][1]).toMatchObject({ require_git_checkout: true });
    expect(adapterStartSpy.mock.calls[1][1]).toMatchObject({ require_git_checkout: false });
  });

  it('passes the structured runtime to workers only and trusts protocol readiness (task 203)', async () => {
    const registry = await import('./agentRegistry.ts');
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    adapterStartSpy.mockResolvedValue({ session_handle: 'app:test-worker', provider_ref: { protocol_ready: true } });
    const agent = makeAgent();
    await launchWorkerSession('/tmp/state', agent, { adapter, workingDirectory: '/tmp/work', runtime: 'structured', emit: vi.fn() });
    await launchWorkerSession('/tmp/state', makeAgent({ role: 'scout' }), { adapter, workingDirectory: '/tmp/work', runtime: 'structured', emit: vi.fn() });

    expect(adapterStartSpy.mock.calls[0][1]).toMatchObject({ runtime: 'structured' });
    expect(adapterStartSpy.mock.calls[1][1]).not.toHaveProperty('runtime');
    // No report-for-duty turn can happen before input, so the handshake marks the session ready.
    const updates = vi.mocked(registry.updateAgentRuntime).mock.calls[0][2];
    expect(updates.session_ready_at).toBe(updates.session_started_at);
  });

  it('passes the sandbox network opt-in to the adapter (task 230)', async () => {
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    await launchWorkerSession('/tmp/state', makeAgent(), { adapter, workingDirectory: '/tmp/work', sandboxNetwork: 'open', emit: vi.fn() });
    await launchWorkerSession('/tmp/state', makeAgent(), { adapter, workingDirectory: '/tmp/work', emit: vi.fn() });
    // A project scout reports for duty over the socket too, so it follows the same opt-in.
    await launchWorkerSession('/tmp/state', makeAgent({ role: 'scout' }), { adapter, workingDirectory: '/tmp/work', sandboxNetwork: 'open', emit: vi.fn() });
    expect(adapterStartSpy.mock.calls[0][1]).toMatchObject({ sandbox_network: 'open' });
    expect(adapterStartSpy.mock.calls[1][1]).not.toHaveProperty('sandbox_network');
    expect(adapterStartSpy.mock.calls[2][1]).toMatchObject({ read_only: true, sandbox_network: 'open' });
  });

  it('leaves CLI sessions waiting for report-for-duty', async () => {
    const registry = await import('./agentRegistry.ts');
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    await launchWorkerSession('/tmp/state', makeAgent(), { adapter, workingDirectory: '/tmp/work', emit: vi.fn() });
    expect(adapterStartSpy.mock.calls[0][1]).not.toHaveProperty('runtime');
    expect(vi.mocked(registry.updateAgentRuntime).mock.calls[0][2].session_ready_at).toBeNull();
  });

  it('scout override: always sandbox regardless of input', async () => {
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    const agent = makeAgent({ role: 'scout' });
    await launchWorkerSession('/tmp/state', agent, {
      adapter,
      workingDirectory: '/tmp/work',
      executionMode: 'full-access',
      emit: vi.fn(),
    });
    expect(adapterStartSpy).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({ execution_mode: 'sandbox' }),
    );
  });

  it('defaults to full-access when executionMode omitted', async () => {
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    const agent = makeAgent();
    await launchWorkerSession('/tmp/state', agent, {
      adapter,
      workingDirectory: '/tmp/work',
      emit: vi.fn(),
    });
    expect(adapterStartSpy).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({ execution_mode: 'full-access' }),
    );
  });

  it('non-scout workers receive configured mode', async () => {
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    const agent = makeAgent({ role: 'worker' });
    await launchWorkerSession('/tmp/state', agent, {
      adapter,
      workingDirectory: '/tmp/work',
      executionMode: 'full-access',
      emit: vi.fn(),
    });
    expect(adapterStartSpy).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({ execution_mode: 'full-access' }),
    );
  });

  it('defaults worker startup/bootstrap profiles to default', async () => {
    vi.doMock('./orcBin.ts', () => ({ resolveOrcBin: vi.fn(() => 'orc') }));
    const buildSessionBootstrapSpy = vi.fn(() => 'BOOTSTRAP');
    vi.doMock('./sessionBootstrap.ts', () => ({ buildSessionBootstrap: buildSessionBootstrapSpy }));
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    const agent = makeAgent({ provider: 'codex' });
    await launchWorkerSession('/tmp/state', agent, {
      adapter,
      workingDirectory: '/tmp/work',
      emit: vi.fn(),
      repoRoot: null,
    });
    expect(adapterStartSpy).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({ startup_profile: 'default' }),
    );
    expect(buildSessionBootstrapSpy).toHaveBeenCalledWith(
      'test-worker',
      'codex',
      'worker',
      'orc',
      expect.any(String),
      expect.objectContaining({ workerBootstrapProfile: 'default' }),
    );
  });

  it('passes smoke worker startup/bootstrap profiles explicitly from coordinator env', async () => {
    vi.stubEnv('ORC_WORKER_BOOTSTRAP_PROFILE', 'smoke');
    vi.stubEnv('ORC_WORKER_STARTUP_PROFILE', 'real-provider-smoke');
    vi.doMock('./orcBin.ts', () => ({ resolveOrcBin: vi.fn(() => 'orc') }));
    const buildSessionBootstrapSpy = vi.fn(() => 'BOOTSTRAP');
    vi.doMock('./sessionBootstrap.ts', () => ({ buildSessionBootstrap: buildSessionBootstrapSpy }));
    vi.resetModules();
    const { launchWorkerSession } = await import('./workerRuntime.ts');
    const agent = makeAgent({ provider: 'codex' });
    await launchWorkerSession('/tmp/state', agent, {
      adapter,
      workingDirectory: '/tmp/work',
      emit: vi.fn(),
      repoRoot: null,
    });
    expect(adapterStartSpy).toHaveBeenCalledWith(
      'test-worker',
      expect.objectContaining({
        startup_profile: 'real-provider-smoke',
        env: expect.not.objectContaining({
          ORC_WORKER_BOOTSTRAP_PROFILE: expect.any(String),
          ORC_WORKER_STARTUP_PROFILE: expect.any(String),
        }),
      }),
    );
    expect(buildSessionBootstrapSpy).toHaveBeenCalledWith(
      'test-worker',
      'codex',
      'worker',
      'orc',
      expect.any(String),
      expect.objectContaining({ workerBootstrapProfile: 'smoke' }),
    );
  });
});

describe('spawnEphemeralWorker', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orc-worker-test-'));
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
    // Override the agentRegistry mock from the outer describe block so that
    // registerAgent and removeAgent remain real (using vi.importActual).
    vi.doMock('./agentRegistry.ts', async () => {
      const actual = await vi.importActual<typeof import('./agentRegistry.ts')>('./agentRegistry.ts');
      return { ...actual, updateAgentRuntime: vi.fn() };
    });
    vi.doMock('./orcBin.ts', () => ({ resolveOrcBin: vi.fn(() => 'orc') }));
    vi.doMock('./sessionBootstrap.ts', () => ({ buildSessionBootstrap: vi.fn(() => 'BOOTSTRAP') }));
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: vi.fn(() => false) };
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('launches a worker session using the provider resolved at dispatch time', async () => {
    const mockStart = vi.fn().mockResolvedValue({ session_handle: 'pty:amber-anchor', provider_ref: null });
    const adapter = {
      start: mockStart,
      send: vi.fn(),
      stop: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
    };
    const { spawnEphemeralWorker } = await import('./workerRuntime.ts');
    const result = await spawnEphemeralWorker(dir, {
      agentId: 'amber-anchor',
      provider: 'claude',
      adapter,
      workingDirectory: '/tmp/work',
      emit: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(result.agent?.provider).toBe('claude');
    expect(result.agent?.ephemeral).toBe(true);
    expect(mockStart).toHaveBeenCalledOnce();
  });

  it('treats dead worker cleanup as terminal session cleanup rather than slot repair', async () => {
    const mockStart = vi.fn().mockRejectedValue(new Error('launch failed'));
    const adapter = {
      start: mockStart,
      send: vi.fn(),
      stop: vi.fn(),
      heartbeatProbe: vi.fn().mockResolvedValue(true),
    };
    const { spawnEphemeralWorker } = await import('./workerRuntime.ts');
    const result = await spawnEphemeralWorker(dir, {
      agentId: 'amber-anchor',
      provider: 'claude',
      adapter,
      workingDirectory: '/tmp/work',
      emit: vi.fn(),
    });
    expect(result.ok).toBe(false);
    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents as unknown[];
    expect(agents).toHaveLength(0);
  });
});
