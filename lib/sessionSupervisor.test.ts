import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processIdentity } from './processIdentity.ts';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents, withEventDb, withEventDbTransaction } from './eventLog.ts';
import { closeProviderSessionsForAgent, commitClaims, recordProviderSession } from './runStore.ts';
import { CommandDispatcher } from './commandDelivery.ts';
import {
  classifySession, currentSessionOwnerId, listSupervisedSessions, reconcileSessions,
  renewSessionOwnership, setSessionState, type SupervisedSession,
} from './sessionSupervisor.ts';
import type { SessionInspection } from '../adapters/interface.ts';
import type { Agent } from '../types/agents.ts';

let dir: string;

function agent(agentId: string, sessionToken: string, handle = `tmux:${agentId}`): Agent {
  return {
    agent_id: agentId, provider: 'claude', status: 'running', role: 'worker',
    session_handle: handle, session_token: sessionToken, registered_at: '2026-01-01T00:00:00.000Z',
  };
}

function insertSession(sessionId: string, agentId: string, runId: string | null, pid: number | null, start: string | null, transport = 'tmux') {
  withEventDbTransaction(dir, (db) => {
    db.prepare(`INSERT INTO sessions (session_id, run_id, agent_id, provider, state, started_at, updated_at,
      transport, process_pid, process_start, owner_id)
      VALUES (?, ?, ?, 'claude', 'running', '2026-01-01', '2026-01-01', ?, ?, ?, 'pid:1:old-coordinator')`)
      .run(sessionId, runId, agentId, transport, pid, start);
  });
}

const live = (pid: number, processStart: string, writable = true): SessionInspection => ({
  transport: 'tmux', alive: true, writable, pid, processStart,
});

function session(overrides: Partial<SupervisedSession> = {}): SupervisedSession {
  return {
    session_id: 's', run_id: null, agent_id: 'a', provider: 'claude', state: 'running', transport: 'tmux',
    process_pid: 100, process_start: 'proc:5', owner_id: null, owner_expires_at: null, state_reason: null,
    started_at: '', updated_at: '', ...overrides,
  };
}

beforeEach(() => {
  dir = createTempStateDir('orch-supervisor-');
  seedState(dir);
  initEventsDb(dir);
  commitClaims(dir, { version: '1', claims: [{
    run_id: 'run-1', task_ref: 'orch/task-1', agent_id: 'worker-a', state: 'in_progress',
    claimed_at: '2026-01-01T00:00:00.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z',
  }] });
});

afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

describe('classifySession', () => {
  it('adopts only a writable process whose PID and start time match the record', () => {
    expect(classifySession(session(), live(100, 'proc:5'))).toEqual({ state: 'running', outcome: 'adopted', reason: null });
  });

  it('never adopts a reused PID', () => {
    expect(classifySession(session(), live(100, 'proc:9'))).toMatchObject({ state: 'unknown', outcome: 'unknown' });
    expect(classifySession(session(), live(101, 'proc:5'))).toMatchObject({ state: 'unknown' });
  });

  it('marks a live but unwritable session recoverable with operator guidance', () => {
    const result = classifySession(session({ transport: 'pty' }), { ...live(100, 'proc:5', false), transport: 'pty', reason: 'pty is owned by another process' });
    expect(result.state).toBe('recoverable');
    expect(result.reason).toContain('orc worker-remove');
  });

  it('treats a legacy session without identity as unknown and an exited one as offline', () => {
    expect(classifySession(session({ process_pid: null, process_start: null }), live(100, 'proc:5')).state).toBe('unknown');
    expect(classifySession(session(), { ...live(100, 'proc:5'), alive: false, reason: 'tmux session not found' }))
      .toEqual({ state: 'offline', outcome: 'exited', reason: 'tmux session not found' });
    expect(classifySession(session(), null).state).toBe('offline');
  });
});

describe('reconcileSessions', () => {
  it('records each decision with an audit event, idempotently', async () => {
    insertSession('s-adopt', 'worker-a', 'run-1', 100, 'proc:5');
    insertSession('s-pty', 'worker-b', null, 200, 'proc:6', 'pty');
    insertSession('s-reused', 'worker-c', null, 300, 'proc:7');
    insertSession('s-gone', 'worker-d', null, 400, 'proc:8');
    insertSession('s-old', 'worker-e', null, 500, 'proc:9');
    const agents = [
      agent('worker-a', 's-adopt'), agent('worker-b', 's-pty', 'pty:worker-b'), agent('worker-c', 's-reused'),
      agent('worker-d', 's-gone'), agent('worker-e', 's-new'),
    ];
    const inspections: Record<string, SessionInspection> = {
      'worker-a': live(100, 'proc:5'),
      'worker-b': { ...live(200, 'proc:6', false), transport: 'pty', reason: 'pty is owned by another process and cannot be written' },
      'worker-c': live(300, 'proc:other'),
      'worker-d': { transport: 'tmux', alive: false, writable: false, pid: null, processStart: null, reason: 'tmux session not found' },
    };
    const reconcile = () => reconcileSessions(dir, {
      owner: 'pid:2:new-coordinator', agents, inspect: (a) => Promise.resolve(inspections[a.agent_id] ?? null),
    });

    const results = await reconcile();
    expect(Object.fromEntries(results.map((r) => [r.session_id, r.outcome]))).toEqual({
      's-adopt': 'adopted', 's-pty': 'recoverable', 's-reused': 'unknown', 's-gone': 'exited', 's-old': 'superseded',
    });
    const rows = new Map(listSupervisedSessions(dir).map((row) => [row.session_id, row]));
    expect(rows.get('s-adopt')).toMatchObject({ state: 'running', owner_id: 'pid:2:new-coordinator', state_reason: null });
    expect(rows.get('s-adopt')!.owner_expires_at).not.toBeNull();
    expect(rows.get('s-pty')).toMatchObject({ state: 'recoverable', owner_id: 'pid:1:old-coordinator' });
    expect(rows.get('s-reused')!.state).toBe('unknown');
    expect(rows.get('s-gone')!.state).toBe('offline');

    const events = queryEvents(dir, { event_type: 'session_reconciled' });
    expect(events).toHaveLength(5);
    expect(events.find((e) => (e.payload as { session_id: string }).session_id === 's-adopt'))
      .toMatchObject({ agent_id: 'worker-a', run_id: 'run-1', task_ref: 'orch/task-1', payload: { state: 'running', outcome: 'adopted' } });

    // A second coordinator pass with unchanged processes writes nothing new.
    expect(await reconcile()).toEqual([]);
    expect(queryEvents(dir, { event_type: 'session_reconciled' })).toHaveLength(5);
  });

  it('leaves the foreground master session to start-session (task 232)', async () => {
    insertSession('session-master', 'master', null, null, null, 'pty');
    // start-session records the master's session but never gives the master agent a handle.
    const master: Agent = { ...agent('master', 'session-master'), role: 'master', session_handle: null };
    const results = await reconcileSessions(dir, { owner: 'pid:2:new-coordinator', agents: [master], inspect: () => Promise.resolve(null) });
    expect(results).toEqual([]);
    expect(listSupervisedSessions(dir).find((row) => row.session_id === 'session-master')?.state).toBe('running');
  });

  it('refuses commands to a recoverable session', () => {
    insertSession('s-pty', 'worker-a', 'run-1', 200, 'proc:6', 'pty');
    insertSession('s-master', 'master', null, null, null);
    setSessionState(dir, 's-pty', 'recoverable', 'not writable');
    const queue = new CommandDispatcher(dir, { send: () => Promise.resolve() },
      (credential) => (credential === 'm' ? { agentId: 'master', sessionId: 's-master' } : null));
    expect(() => queue.enqueue('m', { runId: 'run-1', recipientSessionId: 's-pty', idempotencyKey: 'k', kind: 'input', payload: {} }))
      .toThrow('session is not running');
  });

  it('renews only the leases of running sessions this owner supervises', () => {
    insertSession('s-1', 'worker-a', 'run-1', 100, 'proc:5');
    insertSession('s-2', 'worker-b', null, 200, 'proc:6');
    setSessionState(dir, 's-1', 'running', null, { ownerId: 'me', ownerTtlMs: 1 });
    expect(renewSessionOwnership(dir, 'me', 60_000)).toBe(1);
    const expires = withEventDb(dir, (db) => db.prepare("SELECT owner_expires_at FROM sessions WHERE session_id = 's-1'").get() as { owner_expires_at: string });
    expect(Date.parse(expires.owner_expires_at)).toBeGreaterThan(Date.now() + 50_000);
    expect(currentSessionOwnerId()).toMatch(new RegExp(`^pid:${process.pid}:`));
  });
});

describe('closing recoverable and unknown sessions', () => {
  it('worker-remove and relaunch leave no live row for a recoverable or unknown session', () => {
    insertSession('s-1', 'worker-a', 'run-1', 100, 'proc:5', 'pty');
    insertSession('s-2', 'worker-b', null, 200, 'proc:6', 'pty');
    setSessionState(dir, 's-1', 'recoverable', 'not writable');
    setSessionState(dir, 's-2', 'unknown', 'mismatch');

    closeProviderSessionsForAgent(dir, 'worker-a', new Date().toISOString());
    recordProviderSession(dir, { sessionId: 's-3', runId: null, agentId: 'worker-b', provider: 'claude', providerRef: null, startedAt: new Date().toISOString() });

    const states = Object.fromEntries(listSupervisedSessions(dir).map((row) => [row.session_id, row.state]));
    expect(states).toEqual({ 's-1': 'offline', 's-2': 'offline', 's-3': 'running' });
  });
});

describe('PID reuse with real processes', () => {
  async function spawnSleeper() {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return child;
  }

  it('never adopts a live process that differs from the recorded one', async () => {
    const original = await spawnSleeper();
    const recorded = processIdentity(original.pid!)!;
    original.kill('SIGKILL');
    await new Promise((resolve) => original.once('exit', resolve));
    // macOS ps reports lstart only to the nearest second. Keep the replacement
    // outside that second so the test actually exercises an identity mismatch.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const other = await spawnSleeper();
    const previousStateDir = process.env.ORC_STATE_DIR;
    try {
      process.env.ORC_STATE_DIR = dir;
      vi.resetModules();
      const { createPtyAdapter } = await import('../adapters/pty.ts');
      const adapter = createPtyAdapter({ provider: 'claude' });
      mkdirSync(join(dir, 'pty-pids'), { recursive: true });
      // The PID now belongs to another process: the recorded start time no longer matches.
      insertSession('s-reused', 'worker-a', null, other.pid!, recorded.start, 'pty');
      writeFileSync(join(dir, 'pty-pids', 'worker-a.pid'), JSON.stringify({ pid: other.pid, start: recorded.start }));
      // A legacy bare PID file cannot prove identity either.
      insertSession('s-legacy', 'worker-b', null, other.pid!, recorded.start, 'pty');
      writeFileSync(join(dir, 'pty-pids', 'worker-b.pid'), String(other.pid));

      const results = await reconcileSessions(dir, {
        owner: 'me',
        agents: [agent('worker-a', 's-reused', 'pty:worker-a'), agent('worker-b', 's-legacy', 'pty:worker-b')],
        inspect: (a) => Promise.resolve(adapter.inspectSession(a.session_handle!)),
      });
      expect(Object.fromEntries(results.map((r) => [r.session_id, r.state]))).toEqual({ 's-reused': 'offline', 's-legacy': 'unknown' });
      await adapter.stop('pty:worker-a');
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
    } finally {
      other.kill('SIGKILL');
      if (previousStateDir === undefined) delete process.env.ORC_STATE_DIR;
      else process.env.ORC_STATE_DIR = previousStateDir;
    }
  });
});
