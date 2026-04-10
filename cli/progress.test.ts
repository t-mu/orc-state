import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { queryEvents } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-progress-cli-test-');
  seedState(dir);
});

afterEach(() => {
  cleanupTempStateDir(dir);
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

  it('accepts phase_started before coordinator has processed run_started and leaves claims untouched', () => {
    const before = readClaims();
    const result = runProgress(['--event=phase_started', '--run-id=run-1', '--agent-id=bob', '--phase=impl']);
    expect(result.status).toBe(0);
    expect(readClaims()).toEqual(before);
    expect(readEvents().some((event) => event.event === 'phase_started' && event.phase === 'impl')).toBe(true);
  });

  it('accepts duplicate run_started reports and leaves shared state untouched', () => {
    const before = readClaims();
    const first = runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    const result = runProgress(['--event=run_started', '--run-id=run-1', '--agent-id=bob']);
    expect(first.status).toBe(0);
    expect(result.status).toBe(0);
    expect(readClaims()).toEqual(before);
    expect(readEvents().filter((event) => event.event === 'run_started')).toHaveLength(2);
  });

  it('accepts run_finished as an append-only lifecycle report', () => {
    const beforeClaims = readClaims();
    const beforeBacklog = readBacklog();
    const result = runProgress(['--event=run_finished', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(0);
    expect(readClaims()).toEqual(beforeClaims);
    expect(readBacklog()).toEqual(beforeBacklog);
    expect(readEvents().some((event) => event.event === 'run_finished' && event.run_id === 'run-1')).toBe(true);
  });

  it('accepts work_complete as an append-only event and leaves claims untouched', () => {
    const before = readClaims();
    const result = runProgress(['--event=work_complete', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(0);
    expect(readClaims()).toEqual(before);
    expect(readEvents().some((event) => event.event === 'work_complete' && event.run_id === 'run-1')).toBe(true);
  });

  it('rejects heartbeat before run_started', () => {
    const before = readClaims();
    const result = runProgress(['--event=heartbeat', '--run-id=run-1', '--agent-id=bob']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("heartbeat requires run_started first");
    expect(readClaims()).toEqual(before);
    expect(readEvents().some((event) => event.event === 'heartbeat' && event.run_id === 'run-1')).toBe(false);
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

function runProgress(args: string[]) {
  return spawnSync('node', ['cli/progress.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState(stateDir: string) {
  writeFileSync(join(stateDir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'claimed', depends_on: [], acceptance_criteria: ['a', 'b', 'c'] }] }],
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

function readEvents() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return queryEvents(dir, {}) as unknown as Array<any>;
}
