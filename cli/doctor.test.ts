import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-doctor-cli-test-');
  process.env.ORC_REPO_ROOT = dir;
  mkdirSync(join(dir, 'backlog'), { recursive: true });
});

afterEach(() => {
  cleanupTempStateDir(dir);
  delete process.env.ORC_REPO_ROOT;
});

describe('cli/doctor.ts', () => {
  it('reports stale active claims with actionable hint', () => {
    seedState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        task_envelope_sent_at: '2026-01-01T00:00:01Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runCli(['--json', '--stale-start-ms=1']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.staleActiveClaims.length).toBe(1);
    expect(json.checks.staleActiveClaims[0].hint).toContain('Check coordinator logs');
  });

  it('does not flag claimed runs as stale before task envelope delivery', () => {
    seedState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        task_envelope_sent_at: null,
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runCli(['--json', '--stale-start-ms=1']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.staleActiveClaims.length).toBe(0);
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

  it('reports lifecycle invariant issues in structured output', () => {
    seedState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
      claims: [
        {
          run_id: 'run-old',
          task_ref: 'docs/task-1',
          agent_id: 'bob',
          state: 'claimed',
          claimed_at: '2026-01-01T00:00:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
        },
        {
          run_id: 'run-new',
          task_ref: 'docs/task-1',
          agent_id: 'bob',
          state: 'in_progress',
          claimed_at: '2026-01-01T00:05:00Z',
          lease_expires_at: '2099-01-01T00:00:00Z',
          finalization_state: 'blocked_finalize',
        },
      ],
    });
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(json.checks.lifecycleIssues.some((issue: Record<string, unknown>) => issue.code === 'duplicate_active_claims')).toBe(true);
    expect(json.checks.lifecycleIssues.some((issue: Record<string, unknown>) => issue.code === 'missing_finalization_blocked_reason')).toBe(true);
  });

  it('reports authoritative backlog drift in structured output', () => {
    seedState({ agents: [], claims: [] });
    writeFileSync(join(dir, 'backlog', '999-task-1.md'), ['---', 'ref: docs/task-1', 'feature: docs', 'status: todo', '---', '', '# Task 999 - Different Title', ''].join('\n'));
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(json.checks.backlogSync.mismatches.some((issue: Record<string, unknown>) => issue.field === 'title')).toBe(true);
  });

  it('reports state validation errors when events storage is missing', () => {
    seedState({ agents: [], claims: [] });
    // Remove the events file so doctor detects missing storage
    unlinkSync(join(dir, 'events.jsonl'));
    const result = runCli(['--json']);
    const json = JSON.parse(result.stdout);
    expect(result.status).toBe(1);
    expect(json.checks.stateErrors.some((error: string) => error.includes('events'))).toBe(true);
  });
});

function runCli(args: string[], env = process.env) {
  return spawnSync(process.execPath, ['--experimental-strip-types', 'cli/doctor.ts', ...args], {
    cwd: repoRoot,
    env: { ...env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState({ agents = [] as unknown[], claims = [] as unknown[] } = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}
