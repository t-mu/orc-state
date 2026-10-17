import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { claimTask } from './claimManager.ts';
import { closeAllDatabases, initEventsDb, queryEvents } from './eventLog.ts';
import { readAgents, readClaims } from './stateReader.ts';
import { reconcileState } from './reconcile.ts';
import { closeProviderSessionsForAgent, commitClaims, recordProviderSession, refreshClaimsProjection } from './runStore.ts';
import type { Claim } from '../types/claims.ts';
import type { OrcEventInput } from '../types/events.ts';

let dir: string;

beforeEach(() => { dir = createTempStateDir('orch-run-store-'); });
afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

function makeClaim(runId: string, taskRef = 'orch/task-1'): Claim {
  return {
    run_id: runId, task_ref: taskRef, agent_id: 'worker-1', state: 'claimed',
    claimed_at: '2026-01-01T00:00:00Z', lease_expires_at: '2099-01-01T00:00:00Z',
  };
}

describe('SQLite run authority', () => {
  it.each(['fresh', 'imported'] as const)('passes doctor schema checks for %s state', (kind) => {
    seedState(dir, kind === 'imported' ? { claims: [{ ...makeClaim('run-old'), state: 'failed' }] } : {});
    initEventsDb(dir);
    const result = spawnSync('node', ['cli/doctor.ts', '--json'], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, ORC_STATE_DIR: dir, ORC_BACKLOG_DIR: join(dir, 'backlog') },
      encoding: 'utf8',
    });
    const report = JSON.parse(result.stdout) as { checks: { runtimeSchema: { ok: boolean } }; active_claims: number };
    expect(result.status, result.stdout).toBe(0);
    expect(report.checks.runtimeSchema.ok).toBe(true);
    expect(report.active_claims).toBe(0);
  });

  it('imports legacy claims once and ignores later file-only changes', () => {
    seedState(dir, { claims: [makeClaim('run-legacy')] });
    initEventsDb(dir);
    expect(readClaims(dir).claims.map((claim) => claim.run_id)).toEqual(['run-legacy']);
    const db = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM runtime_cutovers WHERE name = 'runs'").get()).toEqual({ count: 1 });
      expect(db.prepare('SELECT state FROM runs WHERE run_id = ?').get('run-legacy')).toEqual({ state: 'claimed' });
    } finally {
      db.close();
    }
    writeFileSync(join(dir, 'claims.json'), JSON.stringify({ version: '1', claims: [] }));
    expect(readClaims(dir).claims.map((claim) => claim.run_id)).toEqual(['run-legacy']);
    closeAllDatabases();
    expect(readClaims(dir).claims.map((claim) => claim.run_id)).toEqual(['run-legacy']);
    expect(refreshClaimsProjection(dir)).toBe(true);
    expect((JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Claim[] }).claims.map((claim) => claim.run_id))
      .toEqual(['run-legacy']);
  });

  it('rolls back a run write when its event fails validation', () => {
    seedState(dir);
    initEventsDb(dir);
    const state = { version: '1' as const, claims: [makeClaim('run-rollback')] };
    expect(() => commitClaims(dir, state, [{
      ts: '2026-01-01T00:00:00Z', event: 'run_started', actor_type: 'agent', actor_id: 'worker-1',
    } as OrcEventInput])).toThrow('event validation failed');
    expect(readClaims(dir).claims).toEqual([]);
    expect(queryEvents(dir, {})).toEqual([]);
    expect((JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Claim[] }).claims).toEqual([]);
  });

  it('rolls back a run write when SQLite rejects the event insert', () => {
    seedState(dir);
    initEventsDb(dir);
    const db = new Database(join(dir, 'events.db'));
    try {
      db.exec(`CREATE TRIGGER reject_test_event BEFORE INSERT ON events
        WHEN new.event_id = 'event-rejected' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    } finally {
      db.close();
    }
    expect(() => commitClaims(dir, { version: '1', claims: [makeClaim('run-rejected')] }, [{
      event_id: 'event-rejected', ts: '2026-01-01T00:00:00Z', event: 'claim_created',
      actor_type: 'coordinator', actor_id: 'coordinator', run_id: 'run-rejected',
      task_ref: 'orch/task-1', agent_id: 'worker-1', payload: { lease_expires_at: '2099-01-01T00:00:00Z' },
    }])).toThrow('injected failure');
    expect(readClaims(dir).claims).toEqual([]);
    expect(queryEvents(dir, {})).toEqual([]);
  });

  it('recovers a committed run and event when JSON projection fails', () => {
    seedState(dir);
    initEventsDb(dir);
    mkdirSync(join(dir, 'claims.json.tmp'));
    try {
      commitClaims(dir, { version: '1', claims: [makeClaim('run-committed')] }, [{
        event_id: 'event-committed', ts: '2026-01-01T00:00:00Z', event: 'claim_created',
        actor_type: 'coordinator', actor_id: 'coordinator', run_id: 'run-committed',
        task_ref: 'orch/task-1', agent_id: 'worker-1', payload: { lease_expires_at: '2099-01-01T00:00:00Z' },
      }]);
      expect(readClaims(dir).claims.map((claim) => claim.run_id)).toEqual(['run-committed']);
      expect(queryEvents(dir, {}).map((event) => event.event_id)).toEqual(['event-committed']);
      expect((JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Claim[] }).claims).toEqual([]);
    } finally {
      rmSync(join(dir, 'claims.json.tmp'), { recursive: true });
    }
    expect(refreshClaimsProjection(dir)).toBe(true);
    expect((JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Claim[] }).claims.map((claim) => claim.run_id))
      .toEqual(['run-committed']);
  });

  it('imports a legacy running agent session with a stable separate ID', () => {
    seedState(dir, { claims: [makeClaim('run-legacy')] });
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ version: '1', agents: [{
      agent_id: 'worker-1', provider: 'codex', status: 'running',
      session_handle: 'pty:worker-1', registered_at: '2026-01-01T00:00:00Z',
    }] }));
    initEventsDb(dir);
    const first = readAgents(dir).agents[0].session_token;
    expect(first).toMatch(/^legacy-/);
    closeAllDatabases();
    expect(readAgents(dir).agents[0].session_token).toBe(first);
    const db = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT session_id, run_id FROM sessions').get()).toEqual({ session_id: first, run_id: 'run-legacy' });
      expect(db.prepare("SELECT count(*) AS count FROM runtime_cutovers WHERE name = 'sessions'").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('leaves duplicate legacy claims visible until reconciliation repairs them', () => {
    seedState(dir, {
      tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'claimed' }],
      claims: [makeClaim('run-old'), makeClaim('run-new')],
    });
    initEventsDb(dir);
    expect(readClaims(dir).claims.filter((claim) => claim.state === 'claimed')).toHaveLength(2);
    const before = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(before.prepare("SELECT count(*) AS count FROM runtime_cutovers WHERE name = 'runs'").get()).toEqual({ count: 0 });
    } finally {
      before.close();
    }
    reconcileState(dir);
    expect(readClaims(dir).claims.filter((claim) => claim.state === 'claimed')).toHaveLength(1);
    const after = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(after.prepare("SELECT count(*) AS count FROM runtime_cutovers WHERE name = 'runs'").get()).toEqual({ count: 1 });
    } finally {
      after.close();
    }
  });

  it('rejects concurrent claims for the same task across processes', async () => {
    seedState(dir, { tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'todo' }] });
    initEventsDb(dir);
    closeAllDatabases();
    const moduleUrl = new URL('./claimManager.ts', import.meta.url).href;
    const childCode = `
      const { claimTask } = await import(process.argv[1]);
      try {
        const result = claimTask(process.argv[2], 'orch/task-1', process.argv[3]);
        process.stdout.write(JSON.stringify({ ok: true, runId: result.run_id }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
      }
    `;
    const runChild = (agentId: string) => new Promise<{ ok: boolean; runId?: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, moduleUrl, dir, agentId]);
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (part: string) => { output += part; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve(JSON.parse(output) as { ok: boolean; runId?: string }) : reject(new Error(`child exited ${code}`)));
    });
    const results = await Promise.all(['worker-1', 'worker-2', 'worker-3'].map(runChild));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const db = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM runs WHERE state IN ('claimed', 'in_progress')").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT count(*) AS count FROM events WHERE event = 'claim_created'").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  }, 20_000);

  it('keeps provider session identity distinct from run and agent IDs', () => {
    seedState(dir, { tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'todo' }] });
    const { run_id } = claimTask(dir, 'orch/task-1', 'worker-1');
    expect(recordProviderSession(dir, {
      sessionId: 'session-unique', runId: run_id, agentId: 'worker-1',
      provider: 'codex', providerRef: { thread: 'thread-1' }, startedAt: '2026-01-01T00:00:00Z',
    })).toBe(true);
    const db = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(db.prepare('SELECT session_id, run_id, agent_id, provider_ref FROM sessions').get()).toEqual({
        session_id: 'session-unique', run_id, agent_id: 'worker-1', provider_ref: '{"thread":"thread-1"}',
      });
    } finally {
      db.close();
    }
    expect(() => recordProviderSession(dir, {
      sessionId: run_id, runId: run_id, agentId: 'worker-1', provider: 'codex',
      providerRef: null, startedAt: '2026-01-01T00:00:00Z',
    })).toThrow('must differ');
    expect(recordProviderSession(dir, {
      sessionId: 'session-master', runId: null, agentId: 'master',
      provider: 'codex', providerRef: null, startedAt: '2026-01-01T00:00:00Z',
    })).toBe(true);
    expect(recordProviderSession(dir, {
      sessionId: 'session-new', runId: run_id, agentId: 'worker-1',
      provider: 'codex', providerRef: null, startedAt: '2026-01-01T00:01:00Z',
    })).toBe(true);
    closeProviderSessionsForAgent(dir, 'master', '2026-01-01T00:01:00Z');
    const check = new Database(join(dir, 'events.db'), { readonly: true });
    try {
      expect(check.prepare("SELECT run_id, state FROM sessions WHERE session_id = 'session-master'").get())
        .toEqual({ run_id: null, state: 'offline' });
      expect(check.prepare("SELECT session_id, state FROM sessions WHERE agent_id = 'worker-1' ORDER BY rowid").all())
        .toEqual([{ session_id: 'session-unique', state: 'offline' }, { session_id: 'session-new', state: 'running' }]);
    } finally {
      check.close();
    }
  });
});
