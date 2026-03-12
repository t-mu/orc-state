import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-doctor-cli-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/doctor.mjs', () => {
  it('reports stale active claims with actionable hint', () => {
    seedState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runCli(['--json', '--stale-start-ms=1']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.staleActiveClaims.length).toBe(1);
    expect(json.checks.staleActiveClaims[0].hint).toContain('Check coordinator logs');
  });

  it('reports orphaned active claims', () => {
    seedState({
      agents: [],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'missing',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:01:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.orphanedActiveClaims.length).toBe(1);
  });

  it('does not include legacy health-check keys in output', () => {
    seedState({ agents: [], claims: [] });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks).not.toHaveProperty('tm' + 'uxAccess');
    expect(json.checks).not.toHaveProperty('provider' + 'Cli');
    expect(json.checks).not.toHaveProperty('providerApiKeys');
    expect(json.checks).not.toHaveProperty('providerSdkInstalled');
  });

  it('reports providerBinaries for each registered provider', () => {
    seedState({
      agents: [{ agent_id: 'claudia', provider: 'claude', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [],
    });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks).toHaveProperty('providerBinaries');
    expect(json.checks.providerBinaries).toHaveProperty('claude');
    expect(json.checks.providerBinaries.claude.binary).toBe('claude');
    expect(typeof json.checks.providerBinaries.claude.ok).toBe('boolean');
  });

  it('includes install hint for missing mapped provider binary', () => {
    seedState({
      agents: [{ agent_id: 'cody', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [],
    });
    const result = runCli(['--json'], { ...process.env, PATH: '/definitely-not-real' });
    const json = JSON.parse(result.stdout);
    expect(json.checks.providerBinaries.codex.ok).toBe(false);
    expect(json.checks.providerBinaries.codex.detail).toContain('npm install -g @openai/codex');
  });
});

function runCli(args, env = process.env) {
  return spawnSync(process.execPath, ['cli/doctor.mjs', ...args], {
    cwd: repoRoot,
    env: { ...env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState({ agents = [], claims = [] } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}
