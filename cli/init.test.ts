import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const orcConfigPath = join(repoRoot, 'orc-state.config.json');
const mcpJsonPath = join(repoRoot, '.mcp.json');
let dir: string;
let savedOrcConfig: string | null;
let savedMcpJson: string | null;

beforeEach(() => {
  dir = createTempStateDir('orch-init-test-');
  savedOrcConfig = existsSync(orcConfigPath) ? readFileSync(orcConfigPath, 'utf8') : null;
  savedMcpJson = existsSync(mcpJsonPath) ? readFileSync(mcpJsonPath, 'utf8') : null;
});

afterEach(() => {
  cleanupTempStateDir(dir);
  if (savedOrcConfig !== null) {
    writeFileSync(orcConfigPath, savedOrcConfig, 'utf8');
  } else if (existsSync(orcConfigPath)) {
    rmSync(orcConfigPath);
  }
  if (savedMcpJson !== null) {
    writeFileSync(mcpJsonPath, savedMcpJson, 'utf8');
  } else if (existsSync(mcpJsonPath)) {
    rmSync(mcpJsonPath);
  }
});

function run(args: string[] = []) {
  return spawnSync('node', ['cli/init.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: join(dir, 'state'), ORC_BACKLOG_DIR: join(dir, 'backlog') },
    encoding: 'utf8',
  });
}

function runInCwd(cwd: string, args: string[] = []) {
  return spawnSync('node', [resolve(repoRoot, 'cli/init.ts'), ...args], {
    cwd,
    env: { ...process.env, ORC_STATE_DIR: join(dir, 'state') },
    encoding: 'utf8',
  });
}

describe('cli/init.ts', () => {
  it('creates all four state files', () => {
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    expect(existsSync(join(stateDir, 'backlog.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.db'))).toBe(true);
  });

  it('creates default feature when not provided', () => {
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.features).toHaveLength(1);
    expect(backlog.features[0].ref).toBe('project');
  });

  it('creates custom feature ref and title', () => {
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp', '--feature=my-app', '--feature-title=My App']);
    expect(result.status).toBe(0);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.features[0].ref).toBe('my-app');
    expect(backlog.features[0].title).toBe('My App');
  });

  it('skips state creation when .orc-state already exists', () => {
    // First run creates state
    expect(run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']).status).toBe(0);
    const backlog = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlog.features[0].ref).toBe('project');

    // Second run should not error and should not clobber existing backlog
    const second = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp', '--feature=other']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already exists, skipping');
    const backlogAfter = JSON.parse(readFileSync(join(dir, 'state', 'backlog.json'), 'utf8'));
    expect(backlogAfter.features[0].ref).toBe('project'); // unchanged
  });

  it('backs up files and overwrites when --force is used', () => {
    expect(run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']).status).toBe(0);

    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp', '--force']);
    expect(result.status).toBe(0);
    const stateDir = join(dir, 'state');
    expect(existsSync(join(stateDir, 'backlog.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'agents.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'claims.json.bak'))).toBe(true);
    expect(existsSync(join(stateDir, 'events.db.bak'))).toBe(true);
  });

  it('creates orc-state.config.json with selected provider', () => {
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    expect(existsSync(orcConfigPath)).toBe(true);
    const config = JSON.parse(readFileSync(orcConfigPath, 'utf8'));
    expect(config.default_provider).toBe('claude');
    expect(config.worker_pool).toEqual({ max_workers: 1 });
  });

  it('creates orc-state.config.json with two providers', () => {
    const result = run(['--provider=claude,codex', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(orcConfigPath, 'utf8'));
    expect(config.default_provider).toBe('claude');
    expect(config.worker_pool).toEqual({ provider: 'codex', max_workers: 1 });
  });

  it('works non-interactively with --provider flag', () => {
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Setup complete');
    expect(result.stdout).toContain('Skipping skill installation');
    expect(result.stdout).toContain('Skipping agent installation');
    expect(result.stdout).toContain('Skipping MCP config merge');
  });

  it('fails in non-TTY without --provider', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--provider is required');
  });

  it('calls install with selected options', () => {
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Install complete');
  });

  it('is idempotent: re-running updates install artifacts without errors', () => {
    expect(run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']).status).toBe(0);
    const second = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already exists, skipping');
  });

  it('exits 1 with clear message when not in a git repository', () => {
    const nonGitDir = join(tmpdir(), `orc-init-nogit-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });
    try {
      const result = runInCwd(nonGitDir, ['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('git repository');
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('warns when selected provider binary is not on PATH but still succeeds', () => {
    const result = run(['--provider=nonexistent-provider-xyzzy', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('nonexistent-provider-xyzzy');
    expect(result.stderr).toContain('not found on PATH');
  });

  it('succeeds without binary warning when provider binary is available', () => {
    // Create a temp dir with a fake 'claude' binary and prepend it to PATH
    const fakeBinDir = join(tmpdir(), `orc-init-fakebin-${Date.now()}`);
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(join(fakeBinDir, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const result = spawnSync('node', ['cli/init.ts', '--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp'], {
        cwd: repoRoot,
        env: { ...process.env, ORC_STATE_DIR: join(dir, 'state'), ORC_BACKLOG_DIR: join(dir, 'backlog'), PATH: `${fakeBinDir}:${process.env.PATH}` },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('not found on PATH');
    } finally {
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('creates the backlog directory during init', () => {
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'backlog'))).toBe(true);
  });

  it('does not fail if backlog directory already exists', () => {
    mkdirSync(join(dir, 'backlog'), { recursive: true });
    const result = run(['--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, 'backlog'))).toBe(true);
  });
});
