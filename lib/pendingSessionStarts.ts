import { withEventDb } from './eventLog.ts';
import type { SessionStartHookEvent } from './hookEventBus.ts';

/**
 * Session-start hook records drained before their launch was recorded (the
 * hook can fire while `adapter.start` is still running), one per agent, kept
 * in events.db so a restarted coordinator still applies them
 * (lib/sessionStartReadiness.ts) or lets them expire with the readiness timeout.
 */
export interface PendingSessionStart {
  agentId: string;
  record: SessionStartHookEvent;
  /** When the coordinator drained the record. */
  receivedAt: string;
}

interface Row {
  agent_id: string;
  provider_session_id: string;
  source: string;
  orc_session_id: string | null;
  hook_ts: string;
  received_at: string;
}

/** Keep the agent's latest record, replacing an older one. */
export function savePendingSessionStart(stateDir: string, agentId: string, record: SessionStartHookEvent, receivedAt: string): void {
  withEventDb(stateDir, (db) => {
    db.prepare(`
      INSERT INTO pending_session_starts (agent_id, provider_session_id, source, orc_session_id, hook_ts, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (agent_id) DO UPDATE SET provider_session_id = excluded.provider_session_id, source = excluded.source,
        orc_session_id = excluded.orc_session_id, hook_ts = excluded.hook_ts, received_at = excluded.received_at
    `).run(agentId, record.session_id, record.source, record.orc_session_id ?? null, record.ts, receivedAt);
  });
}

export function listPendingSessionStarts(stateDir: string): PendingSessionStart[] {
  return withEventDb(stateDir, (db) => (db.prepare('SELECT * FROM pending_session_starts ORDER BY received_at, agent_id').all() as Row[])
    .map((row) => ({
      agentId: row.agent_id,
      receivedAt: row.received_at,
      record: {
        type: 'session_start',
        session_id: row.provider_session_id,
        source: row.source,
        ...(row.orc_session_id ? { orc_session_id: row.orc_session_id } : {}),
        ts: row.hook_ts,
      },
    })));
}

export function deletePendingSessionStart(stateDir: string, agentId: string): void {
  withEventDb(stateDir, (db) => {
    db.prepare('DELETE FROM pending_session_starts WHERE agent_id = ?').run(agentId);
  });
}
