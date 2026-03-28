import { afterEach, describe, expect, it, vi } from 'vitest';

describe('resolveOrcBin', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('prefers explicit ORC_BIN override', async () => {
    const { resolveOrcBin } = await import('./orcBin.ts');
    expect(resolveOrcBin('/repo/root', { ORC_BIN: '/custom/orc', PATH: '/usr/bin' })).toBe('/custom/orc');
  });

  it('prefers consumer-local node_modules/.bin/orc over PATH', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/repo/root/node_modules/.bin/orc'),
      };
    });

    const { resolveOrcBin } = await import('./orcBin.ts');
    expect(resolveOrcBin('/repo/root', { PATH: '/usr/local/bin:/usr/bin' })).toBe('/repo/root/node_modules/.bin/orc');
  });

  it('falls back to PATH for global installs', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/usr/local/bin/orc'),
      };
    });

    const { resolveOrcBin } = await import('./orcBin.ts');
    expect(resolveOrcBin('/repo/root', { PATH: '/usr/local/bin:/usr/bin' })).toBe('/usr/local/bin/orc');
  });

  it('falls back to repo source cli when no install is available', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: vi.fn((path: string) => path === '/repo/root/cli/orc.ts'),
      };
    });

    const { resolveOrcBin } = await import('./orcBin.ts');
    expect(resolveOrcBin('/repo/root', { PATH: '/usr/local/bin:/usr/bin' })).toBe('/repo/root/cli/orc.ts');
  });
});

describe('resolveOrcBinSh', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('shell-escapes resolved paths for template rendering', async () => {
    const { resolveOrcBinSh } = await import('./orcBin.ts');
    expect(resolveOrcBinSh(null, { ORC_BIN: "/tmp/it's/orc" })).toBe("'/tmp/it'\\''s/orc'");
  });
});
