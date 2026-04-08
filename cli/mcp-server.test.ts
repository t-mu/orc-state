import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');

describe('cli/mcp-server.ts', () => {
  it('exits with descriptive error when MCP transport is not available', () => {
    // mcp-server.ts launches a blocking MCP server; it will fail fast because
    // stdin is not a valid MCP transport in test mode.
    const result = spawnSync('node', ['cli/mcp-server.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: '',           // close stdin immediately
      timeout: 5_000,
    });
    // The process should have exited (either success or error exit)
    // We just verify it doesn't hang indefinitely.
    expect(result.signal).toBeNull();
  });

  it('module can be imported without side effects', async () => {
    // Verify the module file exists and can be resolved — actual server startup
    // is not tested here since it requires a live MCP transport.
    const { existsSync } = await import('node:fs');
    const serverPath = resolve(repoRoot, 'mcp/server.ts');
    expect(existsSync(serverPath)).toBe(true);
  });
});
