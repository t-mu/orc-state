export type AgentId = string;
export type AgentStatus = 'idle' | 'running' | 'offline' | 'dead';
export type Provider = 'codex' | 'claude' | 'gemini' | 'human';
export type AgentRole = 'worker' | 'reviewer' | 'master';
export type DispatchMode = 'autonomous' | 'supervised' | 'human-commanded' | null;

export interface Agent {
  agent_id: AgentId;
  provider: Provider;
  model?: string | null;
  status: AgentStatus;
  dispatch_mode?: DispatchMode;
  role?: AgentRole;
  capabilities?: string[];
  session_handle?: string | null;
  provider_ref?: Record<string, unknown> | null;
  registered_at: string;
  last_heartbeat_at?: string | null;
  last_status_change_at?: string | null;
}

export interface AgentsState {
  version: '1';
  agents: Agent[];
}
