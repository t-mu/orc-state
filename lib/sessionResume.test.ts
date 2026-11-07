import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTempStateDir, createTempStateDir, seedState } from '../test-fixtures/stateHelpers.ts';
import { closeAllDatabases, initEventsDb, queryEvents } from './eventLog.ts';
import { commitClaims, recordProviderSession } from './runStore.ts';
import { credentialHash, sessionForCredential } from './sessionCredentials.ts';
import { listSupervisedSessions } from './sessionSupervisor.ts';
import {
  SESSION_RESUME_BUDGET, beginSessionResume, classifySessionExit, completeSessionResume, decideSessionResume, latestRunSession,
  providerSupportsResume, recordSessionExit, recordSessionResumeFailed, type ResumeDecisionInput,
} from './sessionResume.ts';

const crash: ResumeDecisionInput = {
  setting: 'auto', provider: 'claude', transport: 'tmux', conversationId: 'conv-1',
  exitReason: 'crash', resumeCount: 0, worktreeExists: true,
};

describe('providerSupportsResume', () => {
  it('supports the Claude CLI and Codex app-server, never Gemini or the Codex CLI', () => {
    expect(providerSupportsResume('claude', 'tmux')).toBe(true);
    expect(providerSupportsResume('claude', 'pty')).toBe(true);
    expect(providerSupportsResume('codex', 'app-server')).toBe(true);
    expect(providerSupportsResume('codex', 'tmux')).toBe(false);
    expect(providerSupportsResume('codex', 'pty')).toBe(false);
    for (const transport of ['tmux', 'pty', 'app-server', null]) expect(providerSupportsResume('gemini', transport)).toBe(false);
    expect(providerSupportsResume('claude', null)).toBe(false);
  });
});

describe('classifySessionExit', () => {
  it('tells a crash from a finished worker and a user exit', () => {
    expect(classifySessionExit({ code: null, signal: 9 }, { workComplete: false })).toBe('crash');
    expect(classifySessionExit({ code: null, signal: 'SIGTERM' }, { workComplete: true })).toBe('crash');
    expect(classifySessionExit({ code: 1, signal: null }, { workComplete: false })).toBe('crash');
    expect(classifySessionExit({ code: 0, signal: null }, { workComplete: false })).toBe('user_exit');
    expect(classifySessionExit({ code: 0, signal: null }, { workComplete: true })).toBe('finished');
    expect(classifySessionExit(null, { workComplete: false })).toBe('unknown');
    expect(classifySessionExit({ code: null, signal: null }, { workComplete: false })).toBe('unknown');
  });
});

describe('decideSessionResume', () => {
  it('resumes a crashed Claude CLI or Codex app-server session', () => {
    expect(decideSessionResume(crash)).toEqual({ resume: true });
    expect(decideSessionResume({ ...crash, provider: 'codex', transport: 'app-server' })).toEqual({ resume: true });
  });

  it.each([
    ['the setting is off', { setting: 'off' as const }, /sessions.resume is off/],
    ['the provider is gemini', { provider: 'gemini' }, /gemini sessions on tmux cannot be resumed/],
    ['the Codex CLI cannot resume', { provider: 'codex', transport: 'tmux' }, /cannot be resumed/],
    ['no conversation id was recorded', { conversationId: null }, /no provider conversation id/],
    ['the worker exited normally', { exitReason: 'finished' as const }, /not a crash \(finished\)/],
    ['the user exited', { exitReason: 'user_exit' as const }, /not a crash \(user_exit\)/],
    ['the exit is unknown', { exitReason: 'unknown' as const }, /not a crash \(unknown\)/],
    ['the worktree is missing', { worktreeExists: false }, /worktree no longer exists/],
  ])('requeues when %s', (_label, overrides, reason) => {
    const decision = decideSessionResume({ ...crash, ...overrides });
    expect(decision.resume).toBe(false);
    if (decision.resume) return;
    expect(decision.reason).toMatch(reason);
    expect(decision.budgetExhausted).toBe(false);
  });

  it('requeues once the per-run budget (default 2) is spent, flagged as exhausted', () => {
    expect(SESSION_RESUME_BUDGET).toBe(2);
    expect(decideSessionResume({ ...crash, resumeCount: 1 })).toEqual({ resume: true });
    expect(decideSessionResume({ ...crash, resumeCount: 2 })).toEqual({ resume: false, reason: 'resume budget of 2 spent', budgetExhausted: true });
    expect(decideSessionResume({ ...crash, resumeCount: 0, budget: 0 })).toMatchObject({ resume: false, budgetExhausted: true });
  });
});

describe('session resume records', () => {
  let dir: string;

  beforeEach(() => {
    dir = createTempStateDir('orch-resume-');
    seedState(dir);
    initEventsDb(dir);
    commitClaims(dir, { version: '1', claims: [{
      run_id: 'run-1', task_ref: 'orch/task-1', agent_id: 'worker-a', state: 'in_progress',
      claimed_at: '2026-01-01T00:00:00.000Z', lease_expires_at: '2099-01-01T00:00:00.000Z',
    }] });
    recordProviderSession(dir, {
      sessionId: 'session-1', runId: 'run-1', agentId: 'worker-a', provider: 'claude', providerRef: null,
      startedAt: '2026-01-01T00:00:00.000Z', transport: 'tmux', processPid: 100, processStart: 'proc:1',
      credentialHash: credentialHash('secret-old'), providerConversationId: 'conv-1',
    });
  });

  afterEach(() => { closeAllDatabases(); cleanupTempStateDir(dir); });

  const current = () => listSupervisedSessions(dir).find((row) => row.session_id === 'session-1')!;

  it('records the provider conversation id at spawn and keeps it across a re-record', () => {
    expect(current().provider_conversation_id).toBe('conv-1');
    recordProviderSession(dir, {
      sessionId: 'session-1', runId: 'run-1', agentId: 'worker-a', provider: 'claude', providerRef: null, startedAt: 'later',
    });
    expect(current().provider_conversation_id).toBe('conv-1');
  });

  it('rotates the secret atomically: the old one is rejected, the new one accepted, the session id kept', () => {
    recordSessionExit(dir, 'session-1', 'crash');
    expect(current()).toMatchObject({ state: 'offline', exit_reason: 'crash' });

    expect(beginSessionResume(dir, 'session-1', credentialHash('secret-new'))).toEqual({ generation: 1, resume_count: 1 });
    expect(sessionForCredential(dir, 'secret-old')).toBeNull();
    expect(sessionForCredential(dir, 'secret-new')?.session_id).toBe('session-1');

    completeSessionResume(dir, current(), {
      generation: 1, providerRef: { pid: 200 }, transport: 'tmux', processPid: 200, processStart: 'proc:2',
      ownerId: 'pid:1:x', ownerExpiresAt: '2099-01-01T00:00:00.000Z', conversationId: null, reason: 'pty_pid_dead',
    });
    expect(current()).toMatchObject({
      session_id: 'session-1', state: 'running', exit_reason: null, generation: 1, resume_count: 1,
      process_pid: 200, process_start: 'proc:2', provider_conversation_id: 'conv-1',
    });
    const resumed = queryEvents(dir, { event_type: 'session_resumed' }) as unknown as Array<Record<string, unknown>>;
    expect(resumed).toEqual([expect.objectContaining({
      agent_id: 'worker-a', run_id: 'run-1', task_ref: 'orch/task-1',
      payload: expect.objectContaining({ session_id: 'session-1', generation: 1, provider_conversation_id: 'conv-1', reason: 'pty_pid_dead' }),
    })]);
  });

  it('emits session_resume_failed with the reason', () => {
    recordSessionResumeFailed(dir, current(), 'resume budget of 2 spent');
    const failed = queryEvents(dir, { event_type: 'session_resume_failed' }) as unknown as Array<Record<string, unknown>>;
    expect(failed).toEqual([expect.objectContaining({
      agent_id: 'worker-a', run_id: 'run-1',
      payload: expect.objectContaining({ session_id: 'session-1', generation: 0, reason: 'resume budget of 2 spent' }),
    })]);
  });

  it('finds the run session even after a restart reconciled it offline, but not another run\'s', () => {
    recordSessionExit(dir, 'session-1', 'crash');
    expect(latestRunSession(dir, 'worker-a', 'run-1')).toMatchObject({ session_id: 'session-1', state: 'offline' });
    expect(latestRunSession(dir, 'worker-a', 'run-other')).toBeNull();
    expect(latestRunSession(dir, 'worker-b', 'run-1')).toBeNull();
  });

  it('returns null for a session that does not exist', () => {
    expect(beginSessionResume(dir, 'missing', credentialHash('x'))).toBeNull();
  });
});
