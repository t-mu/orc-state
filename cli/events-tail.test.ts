import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import type { OrcEventInput } from '../types/events.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-events-tail-cli-test-');
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/events-tail.ts', () => {
  it('prints no events marker when log is empty', () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no events)');
  });

  it('returns json tail and supports event filter', () => {
    appendSequencedEvent(dir, ev('run_started') as OrcEventInput);
    appendSequencedEvent(dir, ev('heartbeat') as OrcEventInput);
    appendSequencedEvent(dir, ev('run_finished') as OrcEventInput);

    const result = runCli(['--json', '--n=2', '--event=run_finished']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.total).toBe(1);
    expect(json.events[0].event).toBe('run_finished');
  });

  it('silently skips malformed lines during JSONL migration', () => {
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(ev('heartbeat'))}\n{not-json}\n`);
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.total).toBe(1);
    expect(json.events[0].event).toBe('heartbeat');
  });
});

function ev(event: string) {
  return {
    ts: '2026-01-01T00:00:00Z',
    event,
    actor_type: 'agent' as const,
    actor_id: 'worker-01',
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    agent_id: 'worker-01',
    payload: {},
  };
}

function runCli(args: string[]) {
  return spawnSync('node', ['cli/events-tail.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}
