import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-register-worker-test-'));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/register-worker.ts', () => {
  it('registers worker with explicit role and capabilities', () => {
    const result = runCli([
      'worker-01',
      '--provider=claude',
      '--role=reviewer',
      '--capabilities=refactor,review',
    ]);
    expect(result.status).toBe(0);
    const agents = readAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].agent_id).toBe('worker-01');
    expect(agents[0].provider).toBe('claude');
    expect(agents[0].role).toBe('reviewer');
    expect(agents[0].capabilities).toEqual(['refactor', 'review']);
  });

  it('fails when provider flag is missing', () => {
    const result = runCli(['worker-01']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required flag');
  });

  it('fails when provider is unsupported', () => {
    const result = runCli(['worker-01', '--provider=openai']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported provider');
  });

  it('fails when role is unsupported', () => {
    const result = runCli(['worker-01', '--provider=claude', '--role=manager']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported role');
  });

  it('rejects role=master and points to orc-start-session', () => {
    const result = runCli(['worker-01', '--provider=claude', '--role=master']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot use role=master');
    expect(result.stderr).toContain('orc-start-session');
  });

  it('rejects agent id master and points to orc-start-session', () => {
    const result = runCli(['master', '--provider=claude']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot use agent id 'master'");
    expect(result.stderr).toContain('orc-start-session');
  });

  // ── prompt-related behaviour ───────────────────────────────────────────

  it('fails when no agent id is provided and stdin is not a TTY', () => {
    // spawnSync has no TTY → promptAgentId returns null → exit 1
    const result = runCli(['--provider=claude']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing agent ID');
  });

  it('defaults role to worker when --role is omitted', () => {
    const result = runCli(['worker-01', '--provider=claude']);
    expect(result.status).toBe(0);
    expect(readAgents()[0].role).toBe('worker');
  });

  it('defaults capabilities to empty array when --capabilities is omitted', () => {
    const result = runCli(['worker-01', '--provider=claude']);
    expect(result.status).toBe(0);
    expect(readAgents()[0].capabilities).toEqual([]);
  });

  it('prints the registered agent id and provider to stdout', () => {
    const result = runCli(['worker-01', '--provider=claude']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Registered worker-01');
    expect(result.stdout).toContain('claude');
    expect(result.stdout).toContain('debug/recovery workflows');
  });

  it('fails when --dispatch-mode is invalid', () => {
    const result = runCli(['worker-01', '--provider=claude', '--dispatch-mode=auto']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid dispatch-mode');
    expect(result.stderr).toContain('autonomous');
    expect(result.stderr).toContain('supervised');
    expect(result.stderr).toContain('human-commanded');
  });

  it('accepts --dispatch-mode=autonomous and stores it', () => {
    const result = runCli(['worker-01', '--provider=claude', '--dispatch-mode=autonomous']);
    expect(result.status).toBe(0);
    expect(readAgents()[0].dispatch_mode).toBe('autonomous');
  });

  it('accepts --dispatch-mode=supervised and stores it', () => {
    const result = runCli(['worker-01', '--provider=claude', '--dispatch-mode=supervised']);
    expect(result.status).toBe(0);
    expect(readAgents()[0].dispatch_mode).toBe('supervised');
  });

  it('accepts --dispatch-mode=human-commanded and stores it', () => {
    const result = runCli(['worker-01', '--provider=claude', '--dispatch-mode=human-commanded']);
    expect(result.status).toBe(0);
    expect(readAgents()[0].dispatch_mode).toBe('human-commanded');
  });

  it('succeeds when --dispatch-mode is omitted', () => {
    const result = runCli(['worker-01', '--provider=claude']);
    expect(result.status).toBe(0);
  });
});

function runCli(args) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/register-worker.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}
