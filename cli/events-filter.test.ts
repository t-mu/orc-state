import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { appendSequencedEvent } from '../lib/eventLog.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-events-filter-test-');
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/events-filter.ts', () => {
  it('prints (no events file) when events.db does not exist', () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no events file)');
  });

  it('prints (no matching events) when no events match filter', () => {
    seedEvents();
    const result = runCli(['--event=nonexistent_event']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no matching events)');
  });

  it('outputs all events when no filter is provided', () => {
    seedEvents();
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run_started');
    expect(result.stdout).toContain('heartbeat');
  });

  it('filters by --event type', () => {
    seedEvents();
    const result = runCli(['--event=heartbeat']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('heartbeat');
    expect(result.stdout).not.toContain('run_started');
  });

  it('filters by --run-id', () => {
    seedEvents();
    const result = runCli(['--run-id=run-2']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('run-2');
    expect(result.stdout).not.toContain('run-1');
  });

  it('filters by --agent-id', () => {
    seedEvents();
    const result = runCli(['--agent-id=worker-2']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('worker-2');
    expect(result.stdout).not.toContain('worker-1');
  });

  it('outputs json with --json flag', () => {
    seedEvents();
    const result = runCli(['--event=run_started', '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThan(0);
    expect(json[0].event).toBe('run_started');
  });

  it('returns empty json array when events file missing with --json', () => {
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json).toEqual([]);
  });

  it('limits results with --last=N', () => {
    seedEvents();
    const result = runCli(['--last=1', '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.length).toBe(1);
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/events-filter.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedEvents() {
  // Use appendSequencedEvent directly so events.db is created in the temp dir
  appendSequencedEvent(dir, {
    ts: '2026-01-01T00:01:00Z',
    event: 'run_started',
    actor_type: 'agent',
    actor_id: 'worker-1',
    agent_id: 'worker-1',
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    payload: {},
  });
  appendSequencedEvent(dir, {
    ts: '2026-01-01T00:02:00Z',
    event: 'heartbeat',
    actor_type: 'agent',
    actor_id: 'worker-1',
    agent_id: 'worker-1',
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    payload: {},
  });
  appendSequencedEvent(dir, {
    ts: '2026-01-01T00:03:00Z',
    event: 'run_started',
    actor_type: 'agent',
    actor_id: 'worker-2',
    agent_id: 'worker-2',
    run_id: 'run-2',
    task_ref: 'docs/task-2',
    payload: {},
  });
}
