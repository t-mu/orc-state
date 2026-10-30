import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, withEventDbTransaction } from './eventLog.ts';
import { commitClaims } from './runStore.ts';
import { requirePrincipal, requireProjectAuthor, requireProjectReader, resolveControlPrincipal } from './controlPrincipal.ts';

let dir: string;

beforeEach(() => {
  dir = createTempStateDir('orch-principal-');
  seedState(dir);
  initEventsDb(dir);
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [
    { agent_id: 'master', provider: 'codex', role: 'master', capabilities: [], status: 'idle', registered_at: '2026-01-01T00:00:00.000Z' },
    { agent_id: 'worker-a', provider: 'claude', role: 'worker', capabilities: [], status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
    { agent_id: 'scout-1', provider: 'claude', role: 'scout', capabilities: [], status: 'running', registered_at: '2026-01-01T00:00:00.000Z' },
  ] }));
  commitClaims(dir, { version: '1', claims: ['run-a', 'run-r', 'run-o'].map((runId) => ({
    run_id: runId, task_ref: `orch/task-${runId}`, agent_id: 'worker-a', state: 'in_progress' as const,
    claimed_at: '2026-01-01T00:00:00.000Z', started_at: '2026-01-01T00:00:01.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z',
  })) });
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at)
      VALUES ('session-master', NULL, 'master', 'codex', 'running', '2026-01-01', '2026-01-01'),
        ('session-a', 'run-a', 'worker-a', 'claude', 'running', '2026-01-01', '2026-01-01'),
        ('session-recoverable', 'run-r', 'worker-a', 'claude', 'recoverable', '2026-01-01', '2026-01-01'),
        ('session-offline', 'run-o', 'worker-a', 'claude', 'offline', '2026-01-01', '2026-01-01'),
        ('session-scout', NULL, 'scout-1', 'claude', 'running', '2026-01-01', '2026-01-01'),
        ('session-runless', NULL, 'worker-c', 'claude', 'running', '2026-01-01', '2026-01-01')`).run();
  });
});

afterEach(() => {
  closeAllDatabases();
  cleanupTempStateDir(dir);
});

describe('resolveControlPrincipal', () => {
  it.each([
    ['master session', 'session-master', false, { kind: 'master', agentId: 'master', runId: null, live: true, running: true }],
    ['worker session', 'session-a', false, { kind: 'worker', agentId: 'worker-a', runId: 'run-a', live: true, running: true }],
    ['recoverable worker session', 'session-recoverable', false, { kind: 'worker', live: true, running: false }],
    ['offline worker session', 'session-offline', false, { kind: 'worker', live: false, running: false }],
    ['scout session', 'session-scout', false, { kind: 'scout', agentId: 'scout-1', runId: null, running: true }],
    ['run-less worker session', 'session-runless', false, { kind: 'worker', runId: null }],
    ['operator token', null, true, { kind: 'operator', agentId: null, live: true, running: true }],
    ['a session wins over the operator token', 'session-a', true, { kind: 'worker', agentId: 'worker-a' }],
  ] as const)('resolves a %s', (_label, credential, operator, expected) => {
    expect(resolveControlPrincipal(dir, credential, operator)).toMatchObject(expected);
  });

  it('returns null for a bearer-only caller and refuses an unknown credential', () => {
    expect(resolveControlPrincipal(dir, null, false)).toBeNull();
    expect(() => resolveControlPrincipal(dir, 'not-a-session', false)).toThrow(expect.objectContaining({ code: 'unauthenticated', status: 401 }));
  });
});

describe('principal requirements', () => {
  const resolve = (credential: string | null, operator = false) => resolveControlPrincipal(dir, credential, operator);

  it('refuses a bearer-only caller and an offline session with 401, unless offline is allowed', () => {
    expect(() => requirePrincipal(resolve(null))).toThrow(expect.objectContaining({ status: 401 }));
    expect(() => requirePrincipal(resolve('session-offline'))).toThrow(expect.objectContaining({ status: 401 }));
    expect(requirePrincipal(resolve('session-offline'), { allowOffline: true })).toMatchObject({ kind: 'worker' });
  });

  it('lets only the master and the operator read the whole project', () => {
    expect(requireProjectReader(resolve('session-master'))).toMatchObject({ kind: 'master' });
    expect(requireProjectReader(resolve(null, true))).toMatchObject({ kind: 'operator' });
    expect(() => requireProjectReader(resolve('session-a'))).toThrow(expect.objectContaining({ code: 'forbidden', status: 403 }));
    expect(() => requireProjectReader(resolve('session-scout'))).toThrow(expect.objectContaining({ code: 'forbidden', status: 403 }));
  });

  it('records the master as itself and the operator as human or a registered agent', () => {
    expect(requireProjectAuthor(dir, resolve('session-master'), 'human')).toBe('master');
    expect(requireProjectAuthor(dir, resolve(null, true))).toBe('human');
    expect(requireProjectAuthor(dir, resolve(null, true), 'worker-a')).toBe('worker-a');
    expect(() => requireProjectAuthor(dir, resolve(null, true), 'coordinator')).toThrow(expect.objectContaining({ code: 'bad_request', status: 400 }));
    expect(() => requireProjectAuthor(dir, resolve('session-a'))).toThrow(expect.objectContaining({ status: 403 }));
  });
});
