import { afterEach, describe, expect, it, vi } from 'vitest';

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
        existsSync: vi.fn((path: string) => path === '/home/tester/.npm-global/bin'),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ PATH: '/usr/local/bin:/usr/bin' });

    expect(env.PATH).toBe('/home/tester/.npm-global/bin:/usr/local/bin:/usr/bin');
  });

  it('does not duplicate ~/.npm-global/bin when already present', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/home/tester/.npm-global/bin'),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ PATH: '/home/tester/.npm-global/bin:/usr/bin' });

    expect(env.PATH).toBe('/home/tester/.npm-global/bin:/usr/bin');
  });

  it('carries ORC_REPO_ROOT into the launch env', async () => {
    vi.stubEnv('HOME', '/home/tester');
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn(() => false),
      };
    });

    const { normalizeWorkerEnv } = await import('./workerRuntime.ts');
    const env = normalizeWorkerEnv({ ORCH_STATE_DIR: '/tmp/state' }, '/repo/root');

    expect(env.ORCH_STATE_DIR).toBe('/tmp/state');
    expect(env.ORC_REPO_ROOT).toBe('/repo/root');
  });
});
