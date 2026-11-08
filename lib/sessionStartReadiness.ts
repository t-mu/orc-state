import { updateAgentRuntime } from './agentRegistry.ts';
import { appendSequencedEvent, withEventDbTransaction } from './eventLog.ts';
import type { SessionStartHookEvent } from './hookEventBus.ts';
import type { Agent } from '../types/agents.ts';

/** True once the agent's current session has reported ready (hook, report-for-duty or protocol handshake). */
export function isAgentSessionReady(agent: Agent | null | undefined): boolean {
  if (!agent?.session_handle || !agent.session_token || !agent.session_started_at || !agent.session_ready_at) {
    return false;
  }
  return new Date(agent.session_ready_at).getTime() >= new Date(agent.session_started_at).getTime();
}

/**
 * What to do with a drained `session_start` hook record:
 * - `apply`: it marks the agent's current session ready;
 * - `wait`: the launch is not recorded yet (the hook can fire while `adapter.start`
 *   is still running), keep it for a later tick;
 * - `drop`: the agent is gone, the record names another orc session, or the
 *   session is already ready (a later `/clear`, compaction or a report-for-duty).
 */
export function sessionStartDecision(agent: Agent | null | undefined, record: SessionStartHookEvent): 'apply' | 'wait' | 'drop' {
  if (!agent || agent.status === 'offline') return 'drop';
  if (!agent.session_handle || !agent.session_token || !agent.session_started_at) return 'wait';
  if (record.orc_session_id && record.orc_session_id !== agent.session_token) return 'drop';
  return isAgentSessionReady(agent) ? 'drop' : 'apply';
}

/**
 * Mark the agent's current session ready from its session-start hook: emit the
 * same `reported_for_duty` event `orc report-for-duty` does, with
 * `source: 'hook'`, and keep the provider's conversation id on the session so a
 * crashed session can be resumed. The caller has checked sessionStartDecision.
 */
export function applySessionStart(stateDir: string, agent: Agent, record: SessionStartHookEvent, at: string): void {
  const sessionToken = agent.session_token!;
  const conversationId = record.session_id || null;
  withEventDbTransaction(stateDir, (db) => {
    if (conversationId) {
      db.prepare('UPDATE sessions SET provider_conversation_id = ?, updated_at = ? WHERE session_id = ?')
        .run(conversationId, at, sessionToken);
    }
    appendSequencedEvent(stateDir, {
      ts: at, event: 'reported_for_duty', actor_type: 'coordinator', actor_id: 'coordinator', agent_id: agent.agent_id,
      payload: {
        session_token: sessionToken,
        source: 'hook',
        ...(conversationId ? { provider_conversation_id: conversationId } : {}),
      },
    });
  });
  updateAgentRuntime(stateDir, agent.agent_id, { session_ready_at: at, last_heartbeat_at: at });
}
