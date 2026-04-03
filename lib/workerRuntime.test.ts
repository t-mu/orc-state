import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types/agents.ts';

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

  it('carries ORC_REPO_ROOT into the launch env', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/repo/root/cli/orc.ts'),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ ORCH_STATE_DIR: '/tmp/state' }, '/repo/root');

    expect(env.ORCH_STATE_DIR).toBe('/tmp/state');
    expect(env.ORC_REPO_ROOT).toBe('/repo/root');
    expect(env.ORC_BIN).toBe('/repo/root/cli/orc.ts');
  });
});

interface TestAdapter {
  start(agentId: string, options: {
    system_prompt: string;
    model: string | null;
    working_directory: string | null | undefined;
    read_only?: boolean;
    execution_mode?: 'full-access' | 'sandbox';
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
});
