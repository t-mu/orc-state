import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orch-events-tail-cli-test-'));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cli/events-tail.ts', () => {
  it('prints no events marker when log is empty', () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no events)');
  });

  it('returns json tail and supports event filter', () => {
    writeFileSync(join(dir, 'events.jsonl'), [
      JSON.stringify(ev(1, 'run_started')),
      JSON.stringify(ev(2, 'heartbeat')),
      JSON.stringify(ev(3, 'run_finished')),
      '',
    ].join('\n'));

    const result = runCli(['--json', '--n=2', '--event=run_finished']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.total).toBe(1);
    expect(json.events[0].event).toBe('run_finished');
  });

  it('fails when events file has invalid line', () => {
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(ev(1, 'heartbeat'))}\n{not-json}\n`);
    const result = runCli(['--json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('events.jsonl parse error');
  });
});

function ev(seq, event) {
  return {
    seq,
    ts: '2026-01-01T00:00:00Z',
    event,
    actor_type: 'agent',
    actor_id: 'worker-01',
    run_id: 'run-1',
    task_ref: 'docs/task-1',
    agent_id: 'worker-01',
  };
}

function runCli(args) {
  return spawnSync('node', ['--experimental-strip-types', 'cli/events-tail.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}
