import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTempStateDir, cleanupTempStateDir, seedProjectTasks } from '../test-fixtures/stateHelpers.ts';
import { appendSequencedEvent } from '../lib/eventLog.ts';
import { runProjectCli } from '../test-fixtures/projectCli.ts';
import type { OrcEventInput } from '../types/events.ts';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-cli-robustness-test-');
  seedProjectTasks(dir, []);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function run(script: string, args: string[], env: NodeJS.ProcessEnv = { ...process.env, ORC_STATE_DIR: dir }) {
  return spawnSync('node', [resolve(repoRoot, script), ...args], { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function seedEvents(count: number) {
  for (let i = 0; i < count; i++) {
    appendSequencedEvent(dir, { ts: '2026-01-01T00:00:00Z', event: 'heartbeat', actor_type: 'agent', actor_id: 'w', run_id: `run-${i}`, task_ref: 'docs/task-1', agent_id: 'w', payload: {} } as OrcEventInput);
  }
}

describe('unknown flags are usage errors', () => {
  it.each([
    ['cli/task-cancel.ts', ['docs/task-1', '--bogus'], 'Usage: orc task-cancel'],
    ['cli/worker-status.ts', ['--bogus'], 'Usage: orc worker-status'],
    ['cli/remove-worker.ts', ['worker-1', '--bogus'], 'Usage: orc worker-remove'],
    ['cli/run-info.ts', ['run-1', '--bogus'], 'Usage: orc run-info'],
    ['cli/events.ts', ['--bogus'], 'Usage: orc events'],
  ])('%s %j', (script, args, usage) => {
    const result = run(script, args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(usage);
  });

  it('task-cancel takes the positional, not a flag value, as the task ref', () => {
    const result = runProjectCli(dir, 'cli/task-cancel.ts', ['--actor-id', 'human', 'app/x']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('app/x');
  });
});

describe('project-scoped reads fail outside a project', () => {
  it.each([
    ['cli/worker-status.ts', []],
    ['cli/waiting-input.ts', ['--json']],
    ['cli/sessions.ts', ['--json']],
    ['cli/events.ts', ['--json']],
    ['cli/run-info.ts', ['run-1']],
    ['cli/status.ts', ['--json']],
  ])('%s', (script, args) => {
    const empty = mkdtempSync(join(tmpdir(), 'orc-no-project-'));
    try {
      const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ORC_')));
      const result = run(script, args, { ...base, ORC_DATA_HOME: join(empty, 'data') });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No registered project');
      expect(result.stdout).toBe('');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('orc events', () => {
  const page = (args: string[]) => {
    const result = run('cli/events.ts', [...args, '--json']);
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { events: Array<{ seq: number; run_id: string }>; last_seq: number; has_more: boolean };
  };

  it('--after pages forward oldest-first; no cursor returns the newest page', () => {
    seedEvents(5);
    expect(page(['--after=1', '--limit=2'])).toMatchObject({ last_seq: 3, has_more: true, events: [{ seq: 2 }, { seq: 3 }] });
    expect(page(['--limit=2'])).toMatchObject({ last_seq: 5, has_more: true, events: [{ seq: 4 }, { seq: 5 }] });
    expect(page(['--run-id=run-2']).events.map((e) => e.seq)).toEqual([3]);
  });

  it('prints compact events unless --verbose', () => {
    seedEvents(1);
    expect(page([]).events[0]).not.toHaveProperty('actor_id');
    expect(page(['--verbose']).events[0]).toHaveProperty('actor_id', 'w');
  });

  it('--follow prints new events as JSON lines up to --max-events', () => {
    seedEvents(3);
    const result = run('cli/events.ts', ['--after=0', '--follow', '--max-events=2', '--json']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([1, 2]);
  });

  it('rejects bad --after and out-of-range --limit', () => {
    expect(run('cli/events.ts', ['--after=x']).status).toBe(1);
    const tooMany = run('cli/events.ts', ['--limit=101']);
    expect(tooMany.status).toBe(1);
    expect(tooMany.stderr).toMatch(/limit must be an integer from 1 to 100/);
  });

  it('reports an empty log without creating the database', () => {
    expect(page([])).toEqual({ events: [], last_seq: 0, has_more: false });
    expect(existsSync(join(dir, 'events.db'))).toBe(false);
  });
});

describe('run-info --json', () => {
  function seedClaim(extra: Record<string, unknown> = {}) {
    const claims = [{ run_id: 'run-1', task_ref: 'docs/task-1', agent_id: 'worker-1', state: 'in_progress', claimed_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:01:00Z', lease_expires_at: '2099-01-01T00:00:00Z', ...extra }];
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
    seedProjectTasks(dir, [{ ref: 'docs/task-1', title: 'Task 1', status: 'in_progress' }], claims);
  }

  it('is one compact line when piped', () => {
    seedClaim();
    const result = run('cli/run-info.ts', ['run-1', '--json']);
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(result.stdout).run_id).toBe('run-1');
  });

  it('is complete beyond 64 KB', () => {
    const big = 'x'.repeat(200 * 1024);
    seedClaim({ task_title_note: big });
    const result = run('cli/run-info.ts', ['run-1', '--json']);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(result.stdout).task_title_note).toHaveLength(big.length);
  });
});
