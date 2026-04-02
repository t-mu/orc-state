import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('./install-skills.ts', () => ({
  installSkills: vi.fn().mockReturnValue({ copied: ['/a/b'], count: 1 }),
}));

vi.mock('./install-agents.ts', () => ({
  installAgents: vi.fn().mockReturnValue({ copied: ['/a/c'], count: 1 }),
}));

vi.mock('../lib/mcpConfig.ts', () => ({
  mergeMcpConfig: vi.fn().mockReturnValue({ created: true, updated: true, path: '/base/.mcp.json' }),
  defaultServerPath: vi.fn().mockReturnValue('/mock/server.ts'),
}));

import { runInstall, detectProviders } from './install.ts';
import { installSkills } from './install-skills.ts';
import { installAgents } from './install-agents.ts';
import { mergeMcpConfig } from '../lib/mcpConfig.ts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runInstall', () => {
  it('installs skills, agents, and MCP config for a provider', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: false, skipSkills: false, skipAgents: false, skipMcp: false });
    expect(installSkills).toHaveBeenCalledWith(['claude'], base, false);
    expect(installAgents).toHaveBeenCalledWith(['claude'], base, false);
    expect(mergeMcpConfig).toHaveBeenCalled();
  });

  it('skips MCP when --skip-mcp is passed', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: false, skipSkills: false, skipAgents: false, skipMcp: true });
    expect(mergeMcpConfig).not.toHaveBeenCalled();
    expect(installSkills).toHaveBeenCalled();
    expect(installAgents).toHaveBeenCalled();
  });

  it('skips skills when --skip-skills is passed', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: false, skipSkills: true, skipAgents: false, skipMcp: false });
    expect(installSkills).not.toHaveBeenCalled();
    expect(installAgents).toHaveBeenCalled();
    expect(mergeMcpConfig).toHaveBeenCalled();
  });

  it('skips agents when --skip-agents is passed', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: false, skipSkills: false, skipAgents: true, skipMcp: false });
    expect(installSkills).toHaveBeenCalled();
    expect(installAgents).not.toHaveBeenCalled();
    expect(mergeMcpConfig).toHaveBeenCalled();
  });

  it('dry-run passes dryRun=true to all installers', () => {
    const base = mkdtempSync(join(tmpdir(), 'install-test-'));
    runInstall({ providers: ['claude'], base, dryRun: true, skipSkills: false, skipAgents: false, skipMcp: false });
    expect(installSkills).toHaveBeenCalledWith(['claude'], base, true);
    expect(installAgents).toHaveBeenCalledWith(['claude'], base, true);
    expect(mergeMcpConfig).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), true);
  });
});

describe('detectProviders', () => {
  it('autodetects provider from orchestrator.config.json', () => {
    const base = mkdtempSync(join(tmpdir(), 'detect-test-'));
    writeFileSync(
      join(base, 'orchestrator.config.json'),
      JSON.stringify({ default_provider: 'claude' }),
    );
    expect(detectProviders(base)).toEqual(['claude']);
  });

  it('returns deduplicated providers from all config fields', () => {
    const base = mkdtempSync(join(tmpdir(), 'detect-test-'));
    writeFileSync(
      join(base, 'orchestrator.config.json'),
      JSON.stringify({ default_provider: 'claude', master: { provider: 'claude' }, worker_pool: { provider: 'codex' } }),
    );
    const providers = detectProviders(base);
    expect(providers).toContain('claude');
    expect(providers).toContain('codex');
    expect(providers.length).toBe(2);
  });

  it('returns empty array when no config file exists', () => {
    const base = mkdtempSync(join(tmpdir(), 'detect-test-'));
    expect(detectProviders(base)).toEqual([]);
  });

  it('returns empty array when config has no provider fields', () => {
    const base = mkdtempSync(join(tmpdir(), 'detect-test-'));
    writeFileSync(join(base, 'orchestrator.config.json'), JSON.stringify({ other: 'field' }));
    expect(detectProviders(base)).toEqual([]);
  });
});
