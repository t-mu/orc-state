import { describe, it, expect } from 'vitest';

describe('codexMcpOverrideArgs (task 231)', () => {
  it('forwards a secret from Codex\'s own environment by name, never by value', async () => {
    const { codexMcpOverrideArgs } = await import('./mcpConfig.ts');
    const args = codexMcpOverrideArgs('/srv/mcp.js', { ORC_PROJECT_ID: 'p1' }, '/usr/bin/node', ['ORC_MASTER_SECRET']);
    expect(args).toEqual([
      '-c', 'mcp_servers.orchestrator.command="/usr/bin/node"',
      '-c', 'mcp_servers.orchestrator.args=["/srv/mcp.js"]',
      '-c', 'mcp_servers.orchestrator.env={ORC_PROJECT_ID="p1"}',
      '-c', 'mcp_servers.orchestrator.env_vars=["ORC_MASTER_SECRET"]',
    ]);
    expect(codexMcpOverrideArgs('/srv/mcp.js', {}, '/usr/bin/node')).toHaveLength(6);
  });
});
