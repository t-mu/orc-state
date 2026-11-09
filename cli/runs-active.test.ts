import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-runs-active-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/runs-active.ts', () => {
  it('prints active runs in json', () => {
    seedState({
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:01:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
      eventsRaw: `${JSON.stringify({ seq: 1, ts: '2026-01-01T00:02:00Z', event: 'heartbeat', actor_type: 'agent', actor_id: 'bob', agent_id: 'bob', run_id: 'run-1', payload: { source: 'worker-runtime-owner' } })}\n`,
    });
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.total).toBe(1);
    expect(json.runs[0].run_id).toBe('run-1');
    expect(json.runs[0].last_activity_source).toBe('worker-runtime-owner');
  });

  it('survives malformed events log by skipping corrupted rows', () => {
    seedState({
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
      eventsRaw: '{"seq":1}\nnot-json\n',
    });
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    // Corrupted rows are skipped — no error reported
    expect(json.event_read_error).toBeNull();
  });

  it('anchors claimed run age and idle on task_envelope_sent_at when present', () => {
    const now = new Date();
    const recentEnvelopeTs = new Date(now.getTime() - 5_000).toISOString();
    seedState({
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'bob',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        task_envelope_sent_at: recentEnvelopeTs,
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
      eventsRaw: `${JSON.stringify({ seq: 1, ts: recentEnvelopeTs, event: 'task_envelope_sent', actor_type: 'coordinator', actor_id: 'coordinator', agent_id: 'bob', run_id: 'run-1', payload: { source: 'dispatch' } })}\n`,
    });
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.runs[0].age_seconds).toBeLessThan(30);
    expect(json.runs[0].idle_seconds).toBeLessThan(30);
    expect(json.runs[0].awaiting_run_started).toBe(true);
  });

  it('leaves age and idle unknown for claimed runs before task envelope delivery', () => {
    seedState({
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
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.runs[0].age_seconds).toBeNull();
    expect(json.runs[0].idle_seconds).toBeNull();
    expect(json.runs[0].awaiting_run_started).toBe(true);
  });
});

describe('cli/runs-active.ts outside a project', () => {
  it('exits 1 with a no-project message instead of reading the placeholder directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'orc-no-project-'));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
      const result = spawnSync('node', [resolve(repoRoot, 'cli/runs-active.ts'), '--json'], {
        cwd: empty, env: { ...env, ORC_DATA_HOME: join(empty, 'data') }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No registered project');
      expect(result.stdout).toBe('');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/runs-active.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState({ claims = [] as unknown[], eventsRaw = '' } = {}) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }], claims);
  writeFileSync(join(dir, 'events.jsonl'), eventsRaw);
}
