import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mergeMcpConfig } from './mcpConfig.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('mergeMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .mcp.json from scratch when missing', () => {
    const result = mergeMcpConfig(tmpDir, '/path/to/server.ts', '/state', false);

    expect(result.created).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.path).toBe(join(tmpDir, '.mcp.json'));

    const written = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(written.mcpServers.orchestrator).toMatchObject({
      command: process.execPath,
      args: ['/path/to/server.ts'],
      env: { ORCH_STATE_DIR: '/state' },
    });
  });

  it('merges orchestrator into existing .mcp.json preserving other servers', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          myServer: { command: 'npx', args: ['my-mcp-server'] },
        },
      }),
    );

    const result = mergeMcpConfig(tmpDir, '/path/to/server.ts', '/state', false);

    expect(result.created).toBe(false);
    const written = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(written.mcpServers.myServer).toEqual({ command: 'npx', args: ['my-mcp-server'] });
    expect(written.mcpServers.orchestrator).toMatchObject({
      command: process.execPath,
      args: ['/path/to/server.ts'],
      env: { ORCH_STATE_DIR: '/state' },
    });
  });

  it('updates existing orchestrator entry', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          orchestrator: { command: 'old-node', args: ['/old/server.ts'], env: { ORCH_STATE_DIR: '/old' } },
        },
      }),
    );

    const result = mergeMcpConfig(tmpDir, '/new/server.ts', '/new-state', false);

    expect(result.updated).toBe(true);
    const written = JSON.parse(readFileSync(result.path, 'utf8'));
    expect(written.mcpServers.orchestrator).toMatchObject({
      command: process.execPath,
      args: ['/new/server.ts'],
      env: { ORCH_STATE_DIR: '/new-state' },
    });
  });

  it('preserves root-level keys beyond mcpServers', () => {
    const configPath = join(tmpDir, '.mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: '1.0',
        mcpServers: {},
        someOtherKey: { nested: true },
      }),
    );

    mergeMcpConfig(tmpDir, '/path/to/server.ts', '/state', false);

    const written = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(written.version).toBe('1.0');
    expect(written.someOtherKey).toEqual({ nested: true });
  });

  it('dry-run makes no file changes', () => {
    const configPath = join(tmpDir, '.mcp.json');

    const result = mergeMcpConfig(tmpDir, '/path/to/server.ts', '/state', true);

    expect(result.created).toBe(true);
    expect(result.updated).toBe(true);
    expect(existsSync(configPath)).toBe(false);
  });
});
