export type SnapshotTaskStatus = 'todo' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'released';

export interface AgentSummary {
  agent_id: string;
  provider: string;
  status: 'idle' | 'running' | 'offline' | 'dead';
  last_heartbeat_at?: string | null;
  [key: string]: unknown;
}

export interface ClaimSummary {
  run_id: string;
  task_ref: string;
  agent_id: string;
  state: string;
  lease_expires_at?: string;
  [key: string]: unknown;
}

export interface Snapshot {
  version: '1';
  rebuilt_at: string | null;
  last_event_seq: number;
  agents: Record<string, AgentSummary>;
  claims: Record<string, ClaimSummary>;
  task_statuses: Record<string, SnapshotTaskStatus>;
}
