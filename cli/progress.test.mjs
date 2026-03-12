import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-progress-cli-test-'));
  seedState(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/progress.ts', () => {
  it('rejects unknown events', () => {
    const result = runProgress(['--event=unknown', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported event');
  });

  it('rejects run_started for non-owner agent', () => {
    const result = runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=alice']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('belongs to bob');
  });

  it('rejects phase_started before run_started', () => {
    const result = runProgress(['--event=phase_started', '--run-id=run-1', '--agent-id=bob', '--phase=impl']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires run_started first');
  });

  it('rejects duplicate run_started after in_progress', () => {
    runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    const result = runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires claim state');
  });

  it('accepts run_finished without completion gate confirmation', () => {
    runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    const result = runProgress(['--event=run_finished', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(0);
    const claims = readClaims();
    expect(claims.claims[0].state).toBe('done');
    expect(readBacklog().epics[0].tasks[0].status).toBe('done');
  });

  it('accepts work_complete as a non-terminal in_progress event', () => {
    runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    const result = runProgress(['--event=work_complete', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(0);
    const claims = readClaims();
    expect(claims.claims[0].state).toBe('in_progress');
  });

  it('requires reason for run_failed', () => {
    runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    const result = runProgress(['--event=run_failed', '--run-id=run-1', '--agent-id=bob', '--policy=requeue']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires --reason');
  });

  it('returns run-not-found error for unknown run id', () => {
    const result = runProgress(['--event=run_started', '--run-id=run-missing', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run not found in claims');
  });
});

function runProgress(args) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/progress.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState(stateDir) {
  writeFileSync(join(stateDir, 'backlog.json'), JSON.stringify({
    version: '1',
    epics: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed', depends_on: [], acceptance_criteria: ['a', 'b', 'c'] }] }],
  }));
  writeFileSync(join(stateDir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z', session_handle: 'openai:session-bob', provider_ref: null }],
  }));
  writeFileSync(join(stateDir, 'claims.json'), JSON.stringify({
    version: '1',
    claims: [{
      run_id: 'run-1',
      task_ref: 'docs/task-1',
      agent_id: 'bob',
      state: 'claimed',
      claimed_at: '2026-01-01T00:00:00Z',
      lease_expires_at: '2099-01-01T00:00:00Z',
      last_heartbeat_at: null,
      started_at: null,
      finished_at: null,
    }],
  }));
  writeFileSync(join(stateDir, 'events.jsonl'), '');
}

function readClaims() {
  return JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8'));
}

function readBacklog() {
  return JSON.parse(readFileSync(join(dir, 'backlog.json'), 'utf8'));
}
