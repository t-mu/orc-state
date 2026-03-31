import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempStateDir, cleanupTempStateDir } from '../test-fixtures/stateHelpers.ts';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-preflight-cli-test-');
});

afterEach(() => {
  cleanupTempStateDir(dir);
});

describe('cli/preflight.ts', () => {
  it('passes for valid state with at least one registered worker', () => {
    seedValidState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
    });
    createFakeBinary('codex');
    const result = runPreflight(['--json'], { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.ok).toBe(true);
  });

  it('fails when an active claim has missing owner agent', () => {
    seedValidState({
      claims: [{
        run_id: 'run-1',
        task_ref: 'docs/task-1',
        agent_id: 'missing',
        state: 'claimed',
        claimed_at: '2026-01-01T00:00:00Z',
        lease_expires_at: '2099-01-01T00:00:00Z',
      }],
    });
    const result = runPreflight(['--json']);
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.checks.orphaned_active_claims_count).toBe(1);
  });

  it('returns warning when all registered workers are offline', () => {
    seedValidState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'offline', registered_at: '2026-01-01T00:00:00Z' }],
    });
    createFakeBinary('codex');
    const result = runPreflight(['--json'], { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` });
    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.warnings.length).toBeGreaterThan(0);
  });

  it('reports provider_binaries as empty map when no agents are registered', () => {
    seedValidState({ agents: [] });
    const result = runPreflight(['--json']);
    const json = JSON.parse(result.stdout);
    expect(json.checks.provider_binaries).toEqual({});
  });

  it('fails when registered provider binary is missing', () => {
    seedValidState({
      agents: [{ agent_id: 'bob', provider: 'codex', status: 'running', registered_at: '2026-01-01T00:00:00Z' }],
    });
    const result = runPreflight(['--json'], { ...process.env, PATH: '/definitely-not-real' });
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.checks.provider_binaries.codex).toBe(false);
  });

  it('fails when state files are missing', () => {
    const result = runPreflight(['--json']);
    expect(result.status).toBe(1);
    const json = JSON.parse(result.stdout);
    expect(json.details.state_errors.length).toBeGreaterThan(0);
  });
});

function runPreflight(args: string[], env = process.env) {
  return spawnSync(process.execPath, ['--experimental-strip-types', 'cli/preflight.ts', ...args], {
    cwd: repoRoot,
    env: { ...env, ORCH_STATE_DIR: dir },
    encoding: 'utf8',
  });
}

function seedValidState({
  agents = [] as unknown[],
  claims = [] as unknown[],
} = {}) {
  writeFileSync(join(dir, 'backlog.json'), JSON.stringify({
    version: '1',
    features: [{ ref: 'docs', title: 'Docs', tasks: [{ ref: 'docs/task-1', title: 'Task 1', status: 'todo' }] }],
  }));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims }));
  writeFileSync(join(dir, 'events.jsonl'), '');
}

function createFakeBinary(name: string) {
  const file = join(dir, name);
  writeFileSync(file, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(file, 0o755);
}
