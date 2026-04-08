import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orc-worker-status-test-');
  seedState();
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/worker-status.ts', () => {
  it('lists all workers in table format', () => {
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('worker-1');
    expect(result.stdout).toContain('claude');
    expect(result.stdout).toContain('running');
  });

  it('shows a single agent detail when agent-id is given', () => {
    const result = runCli(['worker-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Agent: worker-1');
    expect(result.stdout).toContain('provider:');
    expect(result.stdout).toContain('status:');
  });

  it('outputs json for all workers with --json', () => {
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(Array.isArray(json)).toBe(true);
    const worker = json.find((a: Record<string, unknown>) => a.agent_id === 'worker-1');
    expect(worker).toBeDefined();
    expect(worker?.provider).toBe('claude');
  });

  it('outputs json for a single agent with agent-id and --json', () => {
    const result = runCli(['worker-1', '--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.agent_id).toBe('worker-1');
    expect(json.status).toBe('running');
  });

  it('shows idle when no active task', () => {
    const result = runCli(['worker-1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('idle');
  });

  it('shows active task ref when worker has claim', () => {
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({
      version: '1',
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'worker-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    }));
    const result = runCli(['--json']);
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    const worker = json.find((a: Record<string, unknown>) => a.agent_id === 'worker-1');
    expect(worker?.active_task_ref).toBe('docs/task-1');
  });

  it('prints (no workers registered) when no non-master agents exist', () => {
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: '1',
      agents: [{ agent_id: 'master-1', provider: 'claude', role: 'master', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
    }));
    const result = runCli([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no workers registered)');
  });

  it('exits 1 when agent-id is not found', () => {
    const result = runCli(['nonexistent-agent']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent not found');
  });
});

function runCli(args: string[]) {
  return spawnSync('node', ['cli/worker-status.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedState() {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{
      ref: 'docs',
      title: 'Docs',
      tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }],
    }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({
    version: '1',
    agents: [{ agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'claude:session-1', registered_at: '2026-01-01T00:00:00Z' }],
  }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}
