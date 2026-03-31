import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-deregister-cli-test-');
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({ version: '1', features: [] }));
  writeFileSync(join(dir, 'events.jsonl'), '');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

function seedAgents(agents: unknown[]) {
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
}

function seedClaims(claims: unknown[]) {
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
}

function readAgents() {
  return JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')).agents;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', 'cli/deregister.ts', ...args], {
    env: { ...process.env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

describe('cli/deregister.ts', () => {
  it('removes existing agent with no active claim and exits 0', () => {
    seedAgents([
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'idle', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    seedClaims([]);

    const result = runCli(['orc-1']);
    expect(result.status).toBe(0);
    expect(readAgents()).toEqual([]);
  });

  it('exits 1 when agent has active claim', () => {
    seedAgents([
      { agent_id: 'orc-1', provider: 'codex', role: 'worker', status: 'running', registered_at: '2026-01-01T00:00:00Z' },
    ]);
    seedClaims([
      {
        run_id: 'run-1',
        task_ref: 'proj/task-1',
        agent_id: 'orc-1',
        state: 'in_progress',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2026-01-01T01:00:00Z',
      },
    ]);

    const result = runCli(['orc-1']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot deregister orc-1: active claim exists');
  });

  it('exits 1 when agent does not exist', () => {
    seedAgents([]);
    seedClaims([]);

    const result = runCli(['missing-agent']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Agent not found: missing-agent');
  });
});
