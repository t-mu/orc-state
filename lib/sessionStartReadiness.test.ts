import { describe, expect, it } from 'vitest';
import { isAgentSessionReady, sessionStartDecision } from './sessionStartReadiness.ts';
import type { SessionStartHookEvent } from './hookEventBus.ts';
import type { Agent } from '../types/agents.ts';

const STARTED = '2026-11-08T10:00:00.000Z';
const agent = (overrides: Partial<Agent> = {}): Agent => ({
  agent_id: 'worker-01', provider: 'claude', role: 'worker', status: 'running',
  session_handle: 'tmux:worker-01', session_token: 'sess-1', session_started_at: STARTED, session_ready_at: null,
  registered_at: STARTED, ...overrides,
} as Agent);
const record = (overrides: Partial<SessionStartHookEvent> = {}): SessionStartHookEvent => ({
  type: 'session_start', session_id: 'conv-1', source: 'startup', orc_session_id: 'sess-1', ts: STARTED, ...overrides,
});

describe('sessionStartDecision', () => {
  it('applies a record for the agent\'s current, not yet ready session', () => {
    expect(sessionStartDecision(agent(), record())).toBe('apply');
    // A record without an orc session id still counts for the current session.
    const { orc_session_id: _omitted, ...withoutOrcSession } = record();
    expect(sessionStartDecision(agent(), withoutOrcSession)).toBe('apply');
  });

  it('waits while the launch is not recorded yet', () => {
    expect(sessionStartDecision(agent({ session_handle: null, session_token: null, session_started_at: null }), record())).toBe('wait');
  });

  it('drops a record for a gone or offline agent, another session, or a session already ready', () => {
    expect(sessionStartDecision(null, record())).toBe('drop');
    expect(sessionStartDecision(agent({ status: 'offline' }), record())).toBe('drop');
    expect(sessionStartDecision(agent(), record({ orc_session_id: 'sess-0' }))).toBe('drop');
    expect(sessionStartDecision(agent({ session_ready_at: STARTED }), record())).toBe('drop');
  });
});

describe('isAgentSessionReady', () => {
  it('needs a ready time at or after the session start', () => {
    expect(isAgentSessionReady(agent())).toBe(false);
    expect(isAgentSessionReady(agent({ session_ready_at: '2026-11-08T09:59:59.000Z' }))).toBe(false);
    expect(isAgentSessionReady(agent({ session_ready_at: STARTED }))).toBe(true);
  });
});
