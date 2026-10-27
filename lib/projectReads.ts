import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ControlClient } from './controlClient.ts';
import { ControlError } from './controlProtocol.ts';
import { clientCredential } from './sessionCredentials.ts';
import { queryEvents } from './eventLog.ts';
import { getMemoryDb, memoryWakeUp } from './memoryStore.ts';
import { readBridgedReviewFeedback } from './messageBridge.ts';
import { ACTIVE_PROJECT, STATE_DIR } from './paths.ts';
import type { ReviewSubmittedEvent } from '../types/events.ts';

/**
 * Read project state the way a sandboxed worker can. A registered project
 * asks its running coordinator, which holds the databases open. Only when no
 * coordinator answers (none running, or one that predates the route) does the
 * read fall back to the state directory, which a session without write
 * access opens read-only. Any other failure — a refused or timed-out
 * connection — is reported, so a sandbox that blocks the socket is not
 * hidden. A legacy installation always reads directly.
 */
export async function readViaCoordinator<T>(
  remote: (client: ControlClient) => Promise<T>,
  local: () => T,
  { project = ACTIVE_PROJECT, client = () => new ControlClient(STATE_DIR, { credential: clientCredential() }) }: { project?: unknown; client?: () => ControlClient } = {},
): Promise<T> {
  if (!project) return local();
  let unanswered: ControlError;
  try {
    return await remote(client());
  } catch (error) {
    // `not_found` is a coordinator older than the read routes; a route that can legitimately
    // answer 404 must not be read through this helper, or its 404 would turn into a direct read.
    if (!(error instanceof ControlError) || (error.code !== 'unavailable' && error.code !== 'not_found')) throw error;
    unanswered = error;
  }
  try {
    return local();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(unanswered.code === 'not_found'
      ? `The running coordinator does not serve this read and the project state could not be read directly (${reason}); restart the coordinator on this orc version`
      : `The coordinator is not running and the project state could not be read directly (${reason}); retry once the coordinator is running`);
  }
}

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

export const DEFAULT_WAKE_UP_BUDGET = 800;

export function isWakeUpBudget(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

/** The memory wake-up text; `initialized` is false when the project has no memory store yet. */
export function readMemoryWakeUp(stateDir: string, opts: { wing?: string | null; budget?: number } = {}): { initialized: boolean; text: string } {
  const budget = opts.budget ?? DEFAULT_WAKE_UP_BUDGET;
  if (!isWakeUpBudget(budget)) throw new Error('budget must be a positive integer');
  if (!existsSync(join(stateDir, 'memory.db'))) return { initialized: false, text: '' };
  // Open first: memoryWakeUp reports an unreadable store as no memories.
  getMemoryDb(stateDir);
  return {
    initialized: true,
    text: memoryWakeUp(stateDir, { ...(opts.wing ? { wing: opts.wing } : {}), tokenBudget: budget }),
  };
}

