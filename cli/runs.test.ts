import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { listRuns } from '../lib/runList.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-runs-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

const longAgo = '2026-01-01T00:00:00Z';
const claim = (runId: string, extra: Record<string, unknown> = {}) => ({
  run_id: runId, task_ref: `docs/${runId}`, agent_id: 'bob', state: 'in_progress',
  claimed_at: longAgo, started_at: longAgo, lease_expires_at: '2099-01-01T00:00:00Z', ...extra,
});

describe('cli/runs.ts', () => {
  it('prints the same { runs } JSON as list_runs, live runs only', () => {
    seedState({
      claims: [claim('run-1'), claim('run-done', { state: 'done' })],
      events: [{ seq: 1, ts: '2026-01-01T00:02:00Z', event: 'phase_started', actor_type: 'agent', actor_id: 'bob', agent_id: 'bob', run_id: 'run-1', task_ref: 'docs/run-1', phase: 'implement' }],
    });
    const result = runCli(['--json']);
    expect(result.status, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout) as { runs: Array<Record<string, unknown>> };
    expect(Object.keys(json)).toEqual(['runs']);
    expect(json.runs).toHaveLength(1);
    expect(json.runs[0]).toMatchObject({ run_id: 'run-1', task_ref: 'docs/run-1', agent_id: 'bob', state: 'in_progress', phase: 'implement', stalled: true });
    const stable = (runs: Array<Record<string, unknown>>) => runs.map(({ age_seconds: _a, idle_seconds: _i, ...rest }) => rest);
    expect(stable(json.runs)).toEqual(stable(listRuns(dir).runs as unknown as Array<Record<string, unknown>>));
  });

  it('--state=stalled honours --stale-after-ms', () => {
    const recent = new Date(Date.now() - 5_000).toISOString();
    seedState({ claims: [claim('run-old'), claim('run-new', { started_at: recent, last_heartbeat_at: recent })] });
    const stalled = JSON.parse(runCli(['--state=stalled', '--json']).stdout) as { runs: Array<{ run_id: string }> };
    expect(stalled.runs.map((r) => r.run_id)).toEqual(['run-old']);
    const none = JSON.parse(runCli(['--state=stalled', '--stale-after-ms=99999999999999', '--json']).stdout) as { runs: unknown[] };
    expect(none.runs).toEqual([]);
    const all = JSON.parse(runCli(['--state=stalled', '--stale-after-ms=0', '--json']).stdout) as { runs: Array<{ run_id: string }> };
    expect(all.runs.map((r) => r.run_id).sort()).toEqual(['run-new', 'run-old']);
  });

  it('--state=waiting-input lists live waiting runs with the question and leaves out legacy claims', () => {
    seedState({
      claims: [
        claim('run-w', { input_state: 'awaiting_input' }),
        claim('run-legacy', { state: 'failed', input_state: 'awaiting_input' }),
        claim('run-busy'),
      ],
      events: [{ seq: 1, ts: '2026-01-01T00:05:00Z', event: 'input_requested', actor_type: 'agent', actor_id: 'bob', run_id: 'run-w', agent_id: 'bob', payload: { question: 'what should I do?', request_id: 'req-xyz' } }],
    });
    const json = JSON.parse(runCli(['--state=waiting-input', '--json']).stdout) as { runs: Array<Record<string, unknown>> };
    expect(json.runs).toEqual([expect.objectContaining({ run_id: 'run-w', question: 'what should I do?', request_id: 'req-xyz', stalled: false })]);
    const text = runCli(['--state=waiting-input']);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Runs (waiting-input): 1');
    expect(text.stdout).toContain('what should I do?');
    expect(text.stdout).not.toContain('run-legacy');
  });

  it('prints (none) when no run matches', () => {
    seedState({ claims: [] });
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Runs (active): 0');
    expect(result.stdout).toContain('(none)');
  });

  it('rejects an unknown --state and a bad --stale-after-ms as usage errors', () => {
    seedState({ claims: [] });
    const badState = runCli(['--state=done']);
    expect(badState.status).toBe(1);
    expect(badState.stderr).toContain('--state must be active, stalled or waiting-input');
    expect(runCli(['--state=constructor']).stderr).toContain('--state must be active, stalled or waiting-input');
    const badStale = runCli(['--stale-after-ms=-5']);
    expect(badStale.status).toBe(1);
    expect(badStale.stderr).toContain('--stale-after-ms must be a non-negative integer');
  });
});

describe('cli/runs.ts outside a project', () => {
  it('exits 1 with a no-project message instead of reading the placeholder directory', () => {
    const empty = mkdtempSync(join(tmpdir(), 'orc-no-project-'));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
      const result = spawnSync('node', [resolve(repoRoot, 'cli/runs.ts'), '--json'], {
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
  return spawnSync('node', ['cli/runs.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORC_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState({ claims = [] as unknown[], events = [] as unknown[] } = {}) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: longAgo }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  const refs = (claims as Array<{ task_ref: string }>).map((c) => c.task_ref);
  seedProjectTasks(dir, refs.map((ref) => ({ ref, title: ref, status: 'in_progress' })), claims);
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join(''));
}
