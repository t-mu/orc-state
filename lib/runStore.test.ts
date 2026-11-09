import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { claimTask } from './claimManager.ts';
import { closeAllDatabases, initEventsDb, queryEvents } from './eventLog.ts';
import { readAgents, readClaims } from './stateReader.ts';
import {
  closeProviderSessionsForAgent, commitClaims, recordProviderSession, refreshClaimsProjection,
  restoreProviderSessionsForAgents, resumeProviderSession,
} from './runStore.ts';
import { beginSessionResume, completeSessionResume, recordSessionExit } from './sessionResume.ts';
import { listSupervisedSessions, setSessionState } from './sessionSupervisor.ts';
import type { Agent } from '../types/agents.ts';
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
      env: { ...process.env, ORC_STATE_DIR: dir },
      encoding: 'utf8',
    });
    const report = JSON.parse(result.stdout) as { checks: { runtimeSchema: { ok: boolean } }; active_claims: number };
    // Without a project doctor fails overall; the fixture's state checks still pass.
    expect((report.checks as Record<string, unknown>).stateErrors, result.stdout).toEqual([]);
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

  it('keeps runs missing from a shorter list and refuses to rewrite a run for another task', () => {
    seedState(dir);
    initEventsDb(dir);
    commitClaims(dir, { version: '1', claims: [makeClaim('run-a'), makeClaim('run-b', 'orch/task-2')] });
    commitClaims(dir, { version: '1', claims: [makeClaim('run-a')] });
    expect(readClaims(dir).claims.map((claim) => claim.run_id)).toEqual(['run-a', 'run-b']);
    expect((JSON.parse(readFileSync(join(dir, 'claims.json'), 'utf8')) as { claims: Claim[] }).claims.map((claim) => claim.run_id))
      .toEqual(['run-a', 'run-b']);
    expect(() => commitClaims(dir, { version: '1', claims: [makeClaim('run-a', 'orch/other')] })).toThrow('refusing to overwrite');
    expect(readClaims(dir).claims.find((claim) => claim.run_id === 'run-a')?.task_ref).toBe('orch/task-1');
    expect(() => commitClaims(dir, { version: '1', claims: [{ ...makeClaim('run-a'), agent_id: 'other-worker' }] })).toThrow('refusing to overwrite');
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

describe('session row events', () => {
  let runId: string;
  const sessionEvents = () => queryEvents(dir, {}).filter((event) => event.event.startsWith('session_'));
  const since = (seq: number) => sessionEvents().filter((event) => event.seq > seq);
  const lastSeq = () => sessionEvents().at(-1)?.seq ?? 0;
  const record = (sessionId: string, at: string) => recordProviderSession(dir, {
    sessionId, runId, agentId: 'worker-1', provider: 'claude', providerRef: null, startedAt: at, transport: 'tmux',
  });
  const agent = (overrides: Partial<Agent> = {}): Agent => ({
    agent_id: 'worker-1', provider: 'claude', role: 'worker', status: 'running', session_handle: 'tmux:worker-1',
    session_token: 'session-1', registered_at: '2026-01-01T00:00:00Z', ...overrides,
  });

  beforeEach(() => {
    seedState(dir, { tasks: [{ ref: 'orch/task-1', title: 'Task 1', status: 'todo' }], agents: [agent()] });
    runId = claimTask(dir, 'orch/task-1', 'worker-1').run_id;
  });

  it('opens a session with session_opened and supersedes the previous one with one state change', () => {
    record('session-1', '2026-01-01T00:00:00.000Z');
    expect(sessionEvents().map((event) => [event.event, event.payload])).toEqual([
      ['session_opened', { session_id: 'session-1', agent_id: 'worker-1', run_id: runId, state: 'running', transport: 'tmux', generation: 0 }],
    ]);
    const seq = lastSeq();
    record('session-2', '2026-01-01T00:01:00.000Z');
    expect(since(seq).map((event) => [event.event, event.payload])).toEqual([
      ['session_state_changed', {
        session_id: 'session-1', agent_id: 'worker-1', run_id: runId, from: 'running', to: 'offline',
        reason: 'superseded by a new session', generation: 0,
      }],
      ['session_opened', { session_id: 'session-2', agent_id: 'worker-1', run_id: runId, state: 'running', transport: 'tmux', generation: 0 }],
    ]);
    expect(since(seq).every((event) => (event as { task_ref?: string }).task_ref === 'orch/task-1')).toBe(true);
  });

  it('writes nothing when the run is gone', () => {
    expect(recordProviderSession(dir, {
      sessionId: 'session-x', runId: 'run-missing', agentId: 'worker-1', provider: 'claude', providerRef: null, startedAt: '2026-01-01T00:00:00.000Z',
    })).toBe(false);
    expect(sessionEvents()).toEqual([]);
    expect(listSupervisedSessions(dir)).toEqual([]);
  });

  it('records close, exit, resume start and resume completion with exactly one event each', () => {
    record('session-1', '2026-01-01T00:00:00.000Z');
    const steps: Array<[string, () => void, string, Record<string, unknown>]> = [
      ['exit', () => recordSessionExit(dir, 'session-1', 'crash'), 'session_state_changed',
        { from: 'running', to: 'offline', reason: 'session process exited (crash)', generation: 0 }],
      ['resume start', () => { beginSessionResume(dir, 'session-1', 'hash-2'); }, 'session_state_changed',
        { from: 'offline', to: 'offline', reason: 'resume started', generation: 1 }],
      ['resume complete', () => completeSessionResume(dir, listSupervisedSessions(dir)[0], {
        generation: 1, providerRef: null, transport: 'tmux', processPid: 2, processStart: 'proc:2',
        ownerId: 'pid:1:x', ownerExpiresAt: '2099-01-01T00:00:00.000Z', conversationId: null, reason: 'pty_pid_dead',
      }), 'session_resumed', { generation: 1, reason: 'pty_pid_dead' }],
      ['close', () => closeProviderSessionsForAgent(dir, 'worker-1', '2026-01-01T00:05:00.000Z'), 'session_state_changed',
        { from: 'running', to: 'offline', reason: 'session closed', generation: 1 }],
      ['restore', () => restoreProviderSessionsForAgents(dir, [agent()], '2026-01-01T00:06:00.000Z'), 'session_state_changed',
        { from: 'offline', to: 'running', reason: 'session reset rolled back', generation: 1 }],
      ['reconcile', () => { setSessionState(dir, 'session-1', 'recoverable', 'not writable'); }, 'session_reconciled',
        { state: 'recoverable', previous_state: 'running', generation: 1 }],
    ];
    for (const [name, write, event, payload] of steps) {
      const seq = lastSeq();
      write();
      const emitted = since(seq);
      expect(emitted.map((entry) => entry.event), name).toEqual([event]);
      expect(emitted[0].payload, name).toMatchObject({ session_id: 'session-1', ...payload });
    }
  });

  it('records a master resume as session_resumed and supersedes its other sessions', () => {
    recordProviderSession(dir, { sessionId: 'master-1', runId: null, agentId: 'master', provider: 'claude', providerRef: null, startedAt: '2026-01-01T00:00:00.000Z' });
    recordProviderSession(dir, { sessionId: 'master-2', runId: null, agentId: 'master', provider: 'claude', providerRef: null, startedAt: '2026-01-01T00:01:00.000Z' });
    const seq = lastSeq();
    expect(resumeProviderSession(dir, {
      sessionId: 'master-1', providerRef: null, at: '2026-01-01T00:02:00.000Z', transport: 'tmux', processPid: 3, processStart: 'proc:3', credentialHash: 'h',
    })).toBe(1);
    expect(since(seq).map((event) => [event.event, (event.payload as { session_id?: string }).session_id])).toEqual([
      ['session_state_changed', 'master-2'], ['session_resumed', 'master-1'],
    ]);
  });

  it('reports the session row state through readAgents: an offline row takes a running agent offline', () => {
    record('session-1', '2026-01-01T00:00:00.000Z');
    expect(readAgents(dir).agents[0]).toMatchObject({ status: 'running', session_token: 'session-1', session_handle: 'tmux:worker-1' });
    setSessionState(dir, 'session-1', 'recoverable', 'not writable');
    expect(readAgents(dir).agents[0]).toMatchObject({ status: 'running', session_token: 'session-1' });
    recordSessionExit(dir, 'session-1', 'crash');
    // The handle stays: it names the dead pane cleanup still has to stop.
    expect(readAgents(dir).agents[0]).toMatchObject({ status: 'offline', session_token: null, session_handle: 'tmux:worker-1' });
  });
});
