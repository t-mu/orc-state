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

// Run init in a fresh orchestration cwd with the ambient ORC_* path overrides
// cleared, so state/backlog/plans/config resolve under that cwd (as they would
// for a real `orc init` in a new directory).
function runSibling(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.ORC_STATE_DIR;
  delete env.ORC_BACKLOG_DIR;
  delete env.ORC_PLANS_DIR;
  delete env.ORC_REPO_ROOT;
  delete env.ORC_HOME;
  return spawnSync('node', [resolve(repoRoot, 'cli/init.ts'), ...args], { cwd, env, encoding: 'utf8' });
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

  it('respects --worker-provider flag to override default worker provider', () => {
    const result = run(['--provider=claude,codex', '--worker-provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(0);
    const config = JSON.parse(readFileSync(orcConfigPath, 'utf8'));
    expect(config.default_provider).toBe('claude');
    expect(config.worker_pool).toEqual({ provider: 'claude', max_workers: 1 });
  });

  it('rejects --worker-provider not in selected providers', () => {
    const result = run(['--provider=claude', '--worker-provider=codex', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not in the selected providers');
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

describe('cli/init.ts --sibling', () => {
  it('is retired and points at project registration, writing nothing', () => {
    const orch = join(dir, 'orch');
    mkdirSync(orch, { recursive: true });
    const result = runSibling(orch, ['--sibling=../target', '--provider=claude', '--skip-skills', '--skip-agents', '--skip-mcp']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('orc init --sibling is retired');
    expect(result.stderr).toContain('orc project add');
    expect(existsSync(join(orch, 'orc-state.config.json'))).toBe(false);
    expect(existsSync(join(orch, '.orc-state'))).toBe(false);
  });
});

describe('cli/init.ts in a registered project', () => {
  it('records settings in the registry, completes the external state and writes nothing into the target', () => {
    const target = join(dir, 'product');
    mkdirSync(target, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: target });
    const env: NodeJS.ProcessEnv = { ...process.env, ORC_DATA_HOME: join(dir, 'data') };
    for (const key of ['ORC_STATE_DIR', 'ORC_BACKLOG_DIR', 'ORC_PLANS_DIR', 'ORC_REPO_ROOT', 'ORC_HOME', 'ORC_CONFIG_FILE', 'ORC_PROJECT_ID']) delete env[key];
    const added = spawnSync('node', [resolve(repoRoot, 'cli/orc.ts'), 'project', 'add', target, '--name=demo'], { cwd: dir, env, encoding: 'utf8' });
    expect(added.status, added.stderr).toBe(0);
    const project = JSON.parse(added.stdout) as { id: string; stateDir: string };

    const result = spawnSync('node', [resolve(repoRoot, 'cli/init.ts'), '--provider=claude,codex'], { cwd: target, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Nothing was written into the target repository');
    expect(spawnSync('ls', ['-A', target], { encoding: 'utf8' }).stdout.trim()).toBe('.git');
    const settings = spawnSync('node', [resolve(repoRoot, 'cli/orc.ts'), 'project', 'config', 'list'], { cwd: target, env, encoding: 'utf8' });
    expect(JSON.parse(settings.stdout)).toMatchObject({ default_provider: 'claude', 'worker_pool.provider': 'codex', 'worker_pool.max_workers': 1 });
    expect(existsSync(join(project.stateDir, 'runtime.db'))).toBe(true);

    const forced = spawnSync('node', [resolve(repoRoot, 'cli/init.ts'), '--provider=claude', '--force'], { cwd: target, env, encoding: 'utf8' });
    expect(forced.status).toBe(1);
    expect(forced.stderr).toContain('would reset the live state of project demo');
  });
});
