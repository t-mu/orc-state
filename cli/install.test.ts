import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('./install-skills.ts', () => ({
  installSkills: vi.fn().mockReturnValue({ copied: ['/a/b'], count: 1 }),
}));

vi.mock('./install-agents.ts', () => ({
  installAgents: vi.fn().mockReturnValue({ copied: ['/a/c'], count: 1 }),
}));

import { runInstall, detectProviders } from './install.ts';
import { installSkills } from './install-skills.ts';
import { installAgents } from './install-agents.ts';
import { ProjectRegistry } from '../lib/projectRegistry.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runInstall', () => {
  it('installs skills and agents for a provider and writes no MCP config', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: false, skipSkills: false, skipAgents: false });
    expect(installSkills).toHaveBeenCalledWith(['claude'], base, false);
    expect(installAgents).toHaveBeenCalledWith(['claude'], base, false);
  });

  it('skips skills when --skip-skills is passed', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: false, skipSkills: true, skipAgents: false });
    expect(installSkills).not.toHaveBeenCalled();
    expect(installAgents).toHaveBeenCalled();
  });

  it('skips agents when --skip-agents is passed', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: false, skipSkills: false, skipAgents: true });
    expect(installSkills).toHaveBeenCalled();
    expect(installAgents).not.toHaveBeenCalled();
  });

  it('dry-run passes dryRun=true to all installers', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: true, skipSkills: false, skipAgents: false });
    expect(installSkills).toHaveBeenCalledWith(['claude'], base, true);
    expect(installAgents).toHaveBeenCalledWith(['claude'], base, true);
  });
});

describe('detectProviders', () => {
  const close = vi.fn();
  function registryWith(settings: Record<string, unknown>) {
    return { effectiveSettings: vi.fn().mockReturnValue(settings), close } as unknown as ProjectRegistry;
  }

  it('returns the deduplicated providers named by the project settings', () => {
    const registry = registryWith({ default_provider: 'claude', 'master.provider': 'claude', 'worker_pool.provider': 'codex', 'worker_pool.max_workers': 1 });
    expect(detectProviders('p1', registry)).toEqual(['claude', 'codex']);
    expect(close).toHaveBeenCalled();
  });

  it('returns an empty array when the project names no provider', () => {
    expect(detectProviders('p1', registryWith({ 'worker_pool.max_workers': 1 }))).toEqual([]);
  });
});
