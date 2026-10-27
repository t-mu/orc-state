import { queryEvents } from './eventLog.ts';
import { readBridgedReviewFeedback } from './messageBridge.ts';
import type { ReviewSubmittedEvent } from '../types/events.ts';

/**
 * A run's reviews: its review_submitted events plus bridged reviewer
 * feedback messages, deduplicated by agent_id (latest submission wins).
 */
export function readRunReviews(stateDir: string, runId: string): ReviewSubmittedEvent[] {
  const events = queryEvents(stateDir, {
    run_id: runId,
    event_type: 'review_submitted',
    limit: 100,
  }) as ReviewSubmittedEvent[];

  const byAgent = new Map<string, ReviewSubmittedEvent>();
  for (const e of events) {
    byAgent.set(e.agent_id, e);
  }
  const eventMessageIds = new Set(events.map((event) => event.payload.message_id).filter((id): id is string => typeof id === 'string'));
  for (const message of readBridgedReviewFeedback(stateDir, runId)) {
    if (eventMessageIds.has(message.messageId)) continue;
    const current = byAgent.get(message.agentId);
    if (current && current.ts > message.createdAt) continue;
    byAgent.set(message.agentId, {
      seq: 0, ts: message.createdAt, event: 'review_submitted', actor_type: 'agent', actor_id: message.agentId,
      run_id: runId, agent_id: message.agentId,
      payload: { outcome: message.outcome, findings: message.findings, message_id: message.messageId },
    });
  }
  return [...byAgent.values()];
}
