export type AgentId = string;
export type AgentStatus = 'idle' | 'running' | 'offline' | 'dead';
export type Provider = 'codex' | 'claude' | 'gemini' | 'human';
export type AgentRole = 'worker' | 'reviewer' | 'master' | 'scout';
export type DispatchMode = 'autonomous' | 'supervised' | 'human-commanded' | null;

export interface Agent {
  agent_id: AgentId;
  provider: Provider;
  model?: string | null | undefined;
  status: AgentStatus;
  dispatch_mode?: DispatchMode | undefined;
  role?: AgentRole | undefined;
  capabilities?: string[] | undefined;
  session_handle?: string | null | undefined;
  provider_ref?: Record<string, unknown> | null | undefined;
  registered_at: string;
  last_heartbeat_at?: string | null | undefined;
  last_status_change_at?: string | null | undefined;
}

export interface AgentsState {
  version: '1';
  agents: Agent[];
}
