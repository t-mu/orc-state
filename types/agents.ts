export type AgentId = string;
export type AgentStatus = 'idle' | 'running' | 'offline' | 'dead';
export type Provider = 'codex' | 'claude' | 'gemini' | 'human';
export type AgentRole = 'worker' | 'reviewer' | 'master' | 'scout';

export interface Agent {
  agent_id: AgentId;
  provider: Provider;
  model?: string | null | undefined;
  status: AgentStatus;
  role?: AgentRole | undefined;
  session_handle?: string | null | undefined;
  session_token?: string | null | undefined;
  session_started_at?: string | null | undefined;
  session_ready_at?: string | null | undefined;
  provider_ref?: Record<string, unknown> | null | undefined;
  registered_at: string;
  last_heartbeat_at?: string | null | undefined;
  last_status_change_at?: string | null | undefined;
  /** True when this agent was spawned by the coordinator for a specific task run.
   * Informational: every worker is task-scoped and removed on terminal cleanup. */
  ephemeral?: boolean | undefined;
}

export interface AgentsState {
  version: '1';
  agents: Agent[];
}
